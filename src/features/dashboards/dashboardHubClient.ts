import type {
  DashboardConnectionState,
  DashboardEnvelope,
  DashboardHubClientConfig,
  DashboardRecord,
  DashboardSnapshot,
} from './types';

type SocketEvent = { data?: unknown };
type SocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: SocketEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type ClientDependencies = {
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
};

const OPEN = 1;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const WATCHDOG_MS = 120000;

function objectRecord(value: unknown): value is DashboardRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isDashboardEnvelope(value: unknown): value is DashboardEnvelope {
  if (!objectRecord(value)) return false;
  return typeof value.dashboard_id === 'string'
    && Number.isFinite(value.schema_version)
    && utcMillis(value.updated_at) !== null
    && utcMillis(value.server_received_at) !== null
    && typeof value.freshness_ttl_sec === 'number'
    && value.freshness_ttl_sec > 0
    && objectRecord(value.data);
}

export function resolveDashboardSnapshot<T extends DashboardRecord>(
  envelope: DashboardEnvelope<T> | null,
  connected: boolean,
  nowMs = Date.now(),
): DashboardSnapshot<T> | null {
  if (!envelope) return null;
  const receivedMs = utcMillis(envelope.server_received_at);
  if (receivedMs === null || !Number.isFinite(nowMs)) return null;
  const ageSec = Math.max(0, nowMs - receivedMs) / 1000;
  return {
    ...envelope.data,
    _updated_at: envelope.updated_at,
    _server_received_at: envelope.server_received_at,
    _age_sec: ageSec,
    _transport_stale: !connected,
    _data_stale: ageSec > envelope.freshness_ttl_sec,
  };
}

export class DashboardHubClient {
  private readonly createSocket: (url: string) => SocketLike;
  private readonly now: () => number;
  private readonly setTimer: ClientDependencies['setTimer'];
  private readonly clearTimer: ClientDependencies['clearTimer'];
  private readonly random: () => number;
  private readonly envelopes = new Map<string, DashboardEnvelope>();
  private readonly listeners = new Set<() => void>();
  private config: DashboardHubClientConfig | null = null;
  private socket: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private active = false;
  private state: DashboardConnectionState = 'idle';

  constructor(dependencies: ClientDependencies = {}) {
    this.createSocket = dependencies.createSocket || ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = dependencies.now || Date.now;
    this.setTimer = dependencies.setTimer || setTimeout;
    this.clearTimer = dependencies.clearTimer || clearTimeout;
    this.random = dependencies.random || Math.random;
  }

  configure(config: DashboardHubClientConfig) {
    const normalized = {
      url: config.url.trim().replace(/\/$/, ''),
      deviceToken: config.deviceToken.trim(),
    };
    if (this.config?.url === normalized.url && this.config.deviceToken === normalized.deviceToken) return;
    this.config = normalized;
    if (this.active) this.reconnectNow();
  }

  connect() {
    this.active = true;
    if (!this.config?.url || !this.config.deviceToken || this.socket) return;
    this.setState('connecting');
    const url = `${this.config.url.replace(/^http/, 'ws')}/live?token=${encodeURIComponent(this.config.deviceToken)}`;
    let socket: SocketLike;
    try {
      socket = this.createSocket(url);
    } catch {
      this.setState('offline');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.resetWatchdog(socket);
      this.send({
        type: 'hello',
        client: 'pentacle-mobile',
        capabilities: ['full-snapshot'],
        subscribe: { all: true },
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.resetWatchdog(socket);
      this.receive(event.data);
    };
    socket.onerror = () => this.failSocket(socket, 4002, 'dashboard socket error');
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearWatchdog();
      this.setState('offline');
      this.scheduleReconnect();
    };
  }

  disconnect() {
    this.active = false;
    if (this.reconnectTimer) this.clearTimer?.(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearWatchdog();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'dashboard tab inactive');
    this.setState('idle');
  }

  refresh(_dashboardId?: string, _params: DashboardRecord = {}) {
    // The Hub's subscription contract is atomic hello+subscribe. Reconnect to
    // request a fresh full snapshot; batch selection is resolved from the
    // foreclosure envelope's cached snapshots on-device.
    this.reconnectNow();
  }

  getState() {
    return this.state;
  }

  getEnvelope<T extends DashboardRecord = DashboardRecord>(dashboardId: string): DashboardEnvelope<T> | null {
    return (this.envelopes.get(dashboardId) as DashboardEnvelope<T> | undefined) || null;
  }

  get<T extends DashboardRecord = DashboardRecord>(dashboardId: string): DashboardSnapshot<T> | null {
    const envelope = this.envelopes.get(dashboardId) as DashboardEnvelope<T> | undefined;
    return resolveDashboardSnapshot(envelope || null, this.state === 'connected', this.now());
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private receive(raw: unknown) {
    let message: DashboardRecord;
    try {
      const decoded = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      if (!objectRecord(decoded)) return;
      message = decoded;
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      this.setState('connected');
      return;
    }
    if (message.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (message.type === 'snapshot' && isDashboardEnvelope(message.envelope)) {
      this.envelopes.set(message.envelope.dashboard_id, message.envelope);
      this.emit();
    }
  }

  private send(message: DashboardRecord) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private reconnectNow() {
    if (this.reconnectTimer) this.clearTimer?.(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.clearWatchdog();
    socket?.close(4000, 'dashboard refresh');
    if (this.active) this.connect();
  }

  private scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    const base = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer?.(() => {
      this.reconnectTimer = null;
      this.connect();
    }, base * (1 + this.random() * 0.3)) || null;
  }

  private resetWatchdog(socket: SocketLike) {
    this.clearWatchdog();
    this.watchdogTimer = this.setTimer?.(() => {
      this.watchdogTimer = null;
      this.failSocket(socket, 4001, 'dashboard heartbeat timeout');
    }, WATCHDOG_MS) || null;
  }

  private clearWatchdog() {
    if (this.watchdogTimer) this.clearTimer?.(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private failSocket(socket: SocketLike, code: number, reason: string) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearWatchdog();
    socket.close(code, reason);
    this.setState('offline');
    this.scheduleReconnect();
  }

  private setState(next: DashboardConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const dashboardHubClient = new DashboardHubClient();
