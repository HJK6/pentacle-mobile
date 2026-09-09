jest.mock('expo-notifications', () => ({}));

type MockSocketEvent = { data?: string };

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MockSocketEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function loadStream(armed: boolean) {
  jest.resetModules();
  jest.doMock('../src/config/pentacle', () => ({
    getDefaultPentacleWsUrl: () => 'ws://spawn-diagnostics.example/ws',
  }));
  jest.doMock('../src/utils/harnessRuntime', () => ({
    ...jest.requireActual('../src/utils/harnessRuntime'),
    isArmed: () => armed,
  }));
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  return { stream, telemetry };
}

function connect(armed = true) {
  const loaded = loadStream(armed);
  const unsubscribe = loaded.stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  return { ...loaded, socket, unsubscribe };
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  jest.useFakeTimers();
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});

test('catalog and V2 wrappers expose dispatch-attempt and socket-send-return metadata', async () => {
  const { stream, socket, unsubscribe } = connect();
  const catalogAttempt = jest.fn();
  const catalogSent = jest.fn();
  const catalogPending = stream.getSpawnCatalog({
    onDispatched: catalogAttempt,
    onSocketSent: catalogSent,
  });
  const catalogPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(catalogAttempt).toHaveBeenCalledWith(catalogPayload.request_id, expect.any(Number));
  expect(catalogSent).toHaveBeenCalledWith(catalogPayload.request_id, expect.any(Number));
  socket.message({
    type: 'spawn_catalog_get.ok',
    request_id: catalogPayload.request_id,
    schema_version: 'CatalogV1',
    catalog_version: 'catalog-1',
    profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-5.6-luna', 'max'] } },
    models: {
      claude: { 'claude-opus-4-8': { efforts: ['high'] } },
      codex: { 'gpt-5.6-luna': { efforts: ['max'] } },
    },
  });
  await catalogPending;

  const spawnAttempt = jest.fn();
  const spawnSent = jest.fn();
  const spawnPending = stream.spawnPentacleSessionV2({
    host: 'hostc',
    provider: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    spawnProfile: 'desktop_manual',
    catalogVersion: 'catalog-1',
    resolutionSource: 'profile_default',
    objective: 'Diagnose the V2 spawn path',
    idempotencyKey: 'intent-safe-for-test',
    onDispatched: spawnAttempt,
    onSocketSent: spawnSent,
  });
  const spawnPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(spawnAttempt).toHaveBeenCalledWith(spawnPayload.request_id, expect.any(Number));
  expect(spawnSent).toHaveBeenCalledWith(spawnPayload.request_id, expect.any(Number));
  socket.message({
    type: 'spawn.ok',
    request_id: spawnPayload.request_id,
    state: 'starting',
    session: { stream_id: 'hostc:v2-diag', host: 'hostc', provider: 'claude', session_name: 'v2-diag' },
  });
  await expect(spawnPending).resolves.toMatchObject({ session: { stream_id: 'hostc:v2-diag' } });
  unsubscribe();
});

test('harness receipt metadata distinguishes matched and unmatched V2 responses', async () => {
  const { stream, telemetry, socket, unsubscribe } = connect();
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));
  const pending = stream.spawnPentacleSessionV2({
    host: 'hostc', provider: 'claude', model: 'claude-opus-4-8', effort: 'high',
    spawnProfile: 'desktop_manual', catalogVersion: 'catalog-1', resolutionSource: 'profile_default',
    objective: 'Diagnose matched vs unmatched V2 responses',
  });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload.objective).toBe('Diagnose matched vs unmatched V2 responses');
  socket.message({ type: 'session.inventory', sessions: [] });
  socket.message({
    type: 'spawn.ok', request_id: 'spawn.v2-unmatched', state: 'starting',
    session: { stream_id: 'hostc:unmatched', host: 'hostc', provider: 'claude', session_name: 'unmatched' },
  });
  socket.message({
    type: 'spawn.ok', request_id: payload.request_id, state: 'starting',
    session: { stream_id: 'hostc:matched', host: 'hostc', provider: 'claude', session_name: 'matched' },
  });
  await pending;

  const traces = events.filter((event) => event.message === 'harness:ui_trace').map((event) => event.data);
  expect(traces).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'spawn_rpc_response_metadata', stage: 'inbound-response', response_type: 'spawn.ok', request_id: 'spawn.v2-unmatched',
      pending_match: false, settled: false, socket_generation: expect.any(Number),
    }),
    expect.objectContaining({
      kind: 'spawn_rpc_response_metadata', stage: 'inbound-response', response_type: 'spawn.ok', request_id: payload.request_id,
      request_prefix: 'spawn.v2', pending_match: true, settled: false, socket_generation: expect.any(Number),
    }),
    expect.objectContaining({
      kind: 'spawn_rpc_response_metadata', stage: 'settled', response_type: 'spawn.ok', request_id: payload.request_id,
      request_prefix: 'spawn.v2', pending_match: true, settled: true, socket_generation: expect.any(Number),
    }),
    expect.objectContaining({
      kind: 'spawn_rpc_inbound_cadence', stage: 'inbound-cadence', response_type: 'session.inventory',
      request_id: null, socket_generation: expect.any(Number),
    }),
  ]));
  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('diagnostic response hook is inert outside the armed harness', () => {
  const { telemetry, socket, unsubscribe } = connect(false);
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));
  socket.message({ type: 'spawn.ok', request_id: 'spawn.v2-unmatched', state: 'starting' });
  expect(events.filter((event) => (
    event.message === 'harness:ui_trace' && String(event.data?.kind || '').startsWith('spawn_rpc_')
  ))).toEqual([]);
  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('onmessage boundary records entry and parse success without frame contents', () => {
  const { telemetry, socket, unsubscribe } = connect();
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));
  const raw = JSON.stringify({ type: 'session.inventory', sessions: [] });

  socket.onmessage?.({ data: raw });

  const traces = events.filter((event) => event.message === 'harness:ui_trace').map((event) => event.data);
  expect(traces).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'ws_onmessage_boundary', stage: 'entry', data_category: 'string',
      byte_length: expect.any(Number), callback_generation: expect.any(Number),
      current_generation: expect.any(Number), generation_match: true, active_socket: true,
    }),
    expect.objectContaining({
      kind: 'ws_onmessage_boundary', stage: 'json-parse', parse_category: 'success',
      frame_type: 'session.inventory',
    }),
  ]));
  expect(JSON.stringify(traces)).not.toContain(raw);
  expect(traces.every((trace) => !('payload' in (trace || {})) && !('text' in (trace || {})) && !('token' in (trace || {})))).toBe(true);
  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('onmessage boundary records parse failure category without raw data', () => {
  const { telemetry, socket, unsubscribe } = connect();
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));

  socket.onmessage?.({ data: '{invalid-json' });

  const traces = events.filter((event) => event.message === 'harness:ui_trace').map((event) => event.data);
  expect(traces).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'ws_onmessage_boundary', stage: 'json-parse', parse_category: 'syntax-error',
      frame_type: null,
    }),
  ]));
  expect(JSON.stringify(traces)).not.toContain('{invalid-json');
  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('onmessage boundary records stale callback early-return reason', () => {
  const { telemetry, socket, unsubscribe } = connect();
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));
  const staleHandler = socket.onmessage;
  unsubscribe();

  staleHandler?.({ data: JSON.stringify({ type: 'spawn.ok', request_id: 'spawn.v2-stale' }) });

  const traces = events.filter((event) => event.message === 'harness:ui_trace').map((event) => event.data);
  expect(traces).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'ws_onmessage_boundary', stage: 'early-return', reason: 'generation-mismatch',
      generation_match: false,
    }),
  ]));
  telemetry.setTelemetrySink(null);
});

test('onmessage boundary hook is inert outside the armed harness', () => {
  const { telemetry, socket, unsubscribe } = connect(false);
  const events: Array<{ message?: string; data?: Record<string, unknown> }> = [];
  telemetry.setTelemetrySink((payload) => events.push(payload));

  socket.onmessage?.({ data: JSON.stringify({ type: 'session.inventory', sessions: [] }) });

  expect(events.some((event) => event.message === 'harness:ui_trace' && event.data?.kind === 'ws_onmessage_boundary')).toBe(false);
  telemetry.setTelemetrySink(null);
  unsubscribe();
});

