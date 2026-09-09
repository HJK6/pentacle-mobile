jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import type { PentacleNotification } from 'pentacle-chat-core';

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

function loadStream() {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function notification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: 'n1',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'example-producer',
    severity: 'warning',
    title: 'Lead needs a decision',
    body: 'Approve outreach?',
    dedup_key: 'dk-1',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function connect() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  return { stream, socket, unsubscribe };
}

test('notification broadcast frame applies to state', () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'live-1' }) });
  expect(stream.getPentacleStreamState().notifications.map((n) => n.notification_id)).toEqual(['live-1']);
  unsubscribe();
});

test('reopen lookup restores the captured answered ask without replacing unrelated cards', async () => {
  const { stream, socket, unsubscribe } = connect();
  const id = '582a0a32-1d2e-4bd3-b59e-11b0deea87ea';
  socket.message({ type: 'notification', notification: notification({ notification_id: 'unrelated-open' }) });
  const promise = stream.listNotifications({ notificationIds: [id] });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload.notification_ids).toEqual([id]);
  expect(payload.limit).toBeUndefined();
  const answered = notification({ notification_id: id, state: 'answered' });
  socket.message({ type: 'notification.list.ok', request_id: payload.request_id, notifications: [answered] });
  await expect(promise).resolves.toEqual([answered]);
  expect(stream.getPentacleStreamState().notifications.map((n) => n.notification_id).sort())
    .toEqual([id, 'unrelated-open'].sort());
  unsubscribe();
});

test('notification.list.ok populates the slice and settles listNotifications', async () => {
  const { stream, socket, unsubscribe } = connect();
  const promise = stream.listNotifications({ states: ['open'], limit: 50 });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'notification.list',
    states: ['open'],
    limit: 50,
  }));
  expect(typeof payload.request_id).toBe('string');

  socket.message({
    type: 'notification.list.ok',
    request_id: payload.request_id,
    notifications: [
      notification({ notification_id: 'a', created_at: '2026-05-25T10:00:00.000Z' }),
      notification({ notification_id: 'b', created_at: '2026-05-25T14:00:00.000Z' }),
    ],
  });

  await expect(promise).resolves.toHaveLength(2);
  expect(stream.getPentacleStreamState().notifications.map((n) => n.notification_id)).toEqual(['b', 'a']);
  unsubscribe();
});

test('resolveNotification sends the right frame and settles on notification.resolve.ok', async () => {
  const { stream, socket, unsubscribe } = connect();
  // Seed an open record so we can observe the in-place update.
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  const promise = stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    choice: true,
  });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'notification.resolve',
    notification_id: 'n1',
    action_kind: 'yes_no',
    choice: true,
  }));
  expect(typeof payload.request_id).toBe('string');
  expect(stream.getPentacleStreamState().notifications.find((n) => n.notification_id === 'n1'))
    .toEqual(expect.objectContaining({ client_resolution_pending: true }));

  socket.message({
    type: 'notification.resolve.ok',
    request_id: payload.request_id,
    notification: notification({ notification_id: 'n1', state: 'answered' }),
  });

  await expect(promise).resolves.toEqual(expect.objectContaining({ state: 'answered' }));
  expect(stream.getPentacleStreamState().notifications.find((n) => n.notification_id === 'n1')?.state)
    .toBe('answered');
  expect(stream.getPentacleStreamState().notifications.find((n) => n.notification_id === 'n1'))
    .not.toHaveProperty('client_resolution_pending');
  unsubscribe();
});

test('resolveNotification keeps the feed card pending in place and restores it on rejection', async () => {
  const { stream, socket, unsubscribe } = connect();
  const open = notification({ notification_id: 'n-optimistic', state: 'open' });
  socket.message({ type: 'notification', notification: open });

  const promise = stream.resolveNotification({
    notification_id: 'n-optimistic',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');

  expect(stream.getPentacleStreamState().notifications.find((item) => item.notification_id === 'n-optimistic'))
    .toEqual(expect.objectContaining({
      ...open,
      client_resolution_pending: true,
    }));

  socket.message({
    type: 'notification.error',
    request_id: payload.request_id,
    error_code: 'notification_invalid',
    error: 'resolve failed',
  });

  await expect(promise).rejects.toThrow('resolve failed');
  expect(stream.getPentacleStreamState().notifications.find((item) => item.notification_id === 'n-optimistic'))
    .toEqual(expect.objectContaining({
      ...open,
      client_resolution_pending: false,
      client_resolution_error: 'resolve failed',
    }));
  unsubscribe();
});

// In-flight RPC promises that never settle in-test would be rejected by
// `failPendingRequests` on unsubscribe → unhandled rejection. Swallow them.
function ignore(p: Promise<unknown>) {
  p.catch(() => undefined);
}

test('resolveNotification forwards action_id when present', async () => {
  const { stream, socket, unsubscribe } = connect();
  ignore(stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'run_command',
    action_id: 'cmd-b',
  }));
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'notification.resolve',
    notification_id: 'n1',
    action_kind: 'run_command',
    action_id: 'cmd-b',
  }));
  unsubscribe();
});

test('resolveNotification forwards durable question selections and note', async () => {
  const { stream, socket, unsubscribe } = connect();
  ignore(stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    selections: ['lane_a', 'lane_b'],
    note: 'prefer both',
  }));
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'notification.resolve',
    notification_id: 'n1',
    action_kind: 'yes_no',
    selections: ['lane_a', 'lane_b'],
    note: 'prefer both',
  }));
  unsubscribe();
});

test('resolveNotification forwards free_text question id and exact text', async () => {
  const { stream, socket, unsubscribe } = connect();
  ignore(stream.resolveNotification({
    notification_id: 'n-free',
    action_kind: 'ack',
    question_id: 'q-free',
    text: '  keep\nspacing  ',
    note: 'operator note',
  }));
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'notification.resolve',
    notification_id: 'n-free',
    action_kind: 'ack',
    question_id: 'q-free',
    text: '  keep\nspacing  ',
    note: 'operator note',
  }));
  unsubscribe();
});

test('resolveNotification omits action_id when absent (legacy first-of-kind)', async () => {
  const { stream, socket, unsubscribe } = connect();
  ignore(stream.resolveNotification({ notification_id: 'n1', action_kind: 'ack' }));
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).not.toHaveProperty('action_id');
  unsubscribe();
});

test('resolveNotification telemetry includes action_id when present', async () => {
  const { stream, unsubscribe } = connect();
  const { teeTelemetrySink } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const captured: Array<{ message: string; data: Record<string, unknown> }> = [];
  const restore = teeTelemetrySink((payload) => {
    captured.push({ message: String(payload.message), data: payload.data });
  });
  try {
    ignore(stream.resolveNotification({ notification_id: 'n1', action_kind: 'yes_no', action_id: 'a0', choice: true }));
    ignore(stream.resolveNotification({ notification_id: 'n2', action_kind: 'ack' }));
  } finally {
    restore();
  }
  const sent = captured.filter((c) => c.message === 'notification:resolve_sent');
  expect(sent[0]?.data).toEqual(expect.objectContaining({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
  }));
  // No action_id key when the caller omits it.
  expect(sent[1]?.data).not.toHaveProperty('action_id');
  unsubscribe();
});

test('useNotifications-style listNotifications sends limit=100 with states omitted', async () => {
  const { stream, socket, unsubscribe } = connect();
  ignore(stream.listNotifications({ limit: 100 }));
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({ type: 'notification.list', limit: 100 }));
  // States omitted → daemon returns ALL states (persistent feed).
  expect(payload).not.toHaveProperty('states');
  unsubscribe();
});

test('resolveNotification omits choice when undefined and rejects on error frame', async () => {
  const { stream, socket, unsubscribe } = connect();
  const promise = stream.resolveNotification({ notification_id: 'n1', action_kind: 'ack' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).not.toHaveProperty('choice');

  // The daemon emits a single generic `notification.error` frame (not a
  // per-verb `notification.resolve.error`) — assert against what really ships.
  socket.message({
    type: 'notification.error',
    request_id: payload.request_id,
    error_code: 'notification_terminal_state',
    error: 'Notification already resolved',
  });

  await expect(promise).rejects.toThrow('Notification already resolved');
  unsubscribe();
});

test('optimistic durable-answer selector survives navigation state and ignores ordinary or failed sends', () => {
  const stream = loadStream();
  const send = (id: string, text: string, status: 'queued' | 'failed') => ({
    optimistic_id: id,
    request_id: `request-${id}`,
    stream_id: 'hostc:codex:question',
    text,
    status,
    created_at: 1,
    reconnect_count: 0,
  });
  const ids = stream.selectOptimisticQuestionNotificationIds({
    optimisticSends: {
      active: send('active', JSON.stringify({ type: 'notification.answer', notification_id: 'n-active', question_id: 'q-active' }), 'queued'),
      failed: send('failed', JSON.stringify({ type: 'notification.answer', notification_id: 'n-failed' }), 'failed'),
      ordinary: send('ordinary', 'hello', 'queued'),
    },
  });

  expect(ids).toEqual(['n-active']);
  expect(stream.selectOptimisticQuestionAnswerIdentities({
    optimisticSends: {
      active: send('active', JSON.stringify({ type: 'notification.answer', notification_id: 'n-active', question_id: 'q-active' }), 'queued'),
    },
  })).toEqual([{ notificationId: 'n-active', questionId: 'q-active' }]);
});

