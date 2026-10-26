import React from 'react';
import { act, render } from '@testing-library/react-native';
import { TranscriptRow } from '../app/pentacle/session/[streamId]';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

// Send-while-working queue + ESC: service-level mechanics against the real
// chat-core reducer + a mocked WebSocket. enqueueTurn appends a queued
// optimistic row without beginning/replacing the active turn; the mobile
// by-optimistic-id dispatcher sends queued rows FIFO to the daemon so its native
// working-session queue can batch them on idle. interruptSend issues a single
// `send.interrupt` frame.
// Queue regression coverage uses deterministic synthetic sessions and messages.

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import type { PentacleSessionSummary } from 'pentacle-chat-core';

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
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
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
  // Reset the transport singleton, retaining the renderer's React instance.
  jest.doMock('react', () => React);
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

const STREAM_ID = 'hostc:codex:chat-1';

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-06-17T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

const END_OF_TURN = {
  type: 'chat.event',
  event: {
    daemon_seq: 0,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'chat-1',
    stream_id: STREAM_ID,
    timestamp: '2026-06-17T12:00:01.000Z',
    kind: 'SYSTEM',
    text: '─ Worked for 1s ─────────────────────────────────────────────────────────────────────────────────',
  },
};

function bootStream() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID)] });
  return { stream, socket, unsubscribe };
}

function endOfTurn(socket: MockWebSocket, seq: number) {
  socket.message({ ...END_OF_TURN, event: { ...END_OF_TURN.event, daemon_seq: seq } });
}

function sentFrames(socket: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-06-17T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});


function beginSend() {
  const env = bootStream();
  const id = env.stream.sendTurn(STREAM_ID, 'synthetic pending message');
  env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, [id]);
  const frame = sentFrames(env.socket, 'send')[0];
  return { ...env, id, frame };
}
function row(env: ReturnType<typeof beginSend>) {
  return env.stream.getPentacleStreamState().optimisticSends?.[env.id];
}
function caption(env: ReturnType<typeof beginSend>) {
  return require('pentacle-chat-core').selectSessionDetail(env.stream.getPentacleStreamState(), STREAM_ID, { visibleCount: 'all' })
    .transcriptItems.find((item: any) => item.optimisticId === env.id);
}

test.each([
  { delivery: 'committed_pending_proof' },
  { delivery: 'committed_pending_proof', state: 'accepted' },
  { delivery: 'committed_pending_proof', coalesced: true, action_committed: true, do_not_resubmit: true },
  { action_committed: true, confirmation_pending: true, do_not_resubmit: true },
])('committed pending preserves one pending row and refuses retry: %p', async (result) => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, ...result });
    await Promise.resolve();
    expect(row(env)).toMatchObject({ status: 'indeterminate', request_id: env.frame.request_id, action_committed: true });
    expect(caption(env)?.receiptCaption).toBe('sending');
    expect(caption(env)?.sendState).not.toBe('failed');
    expect(await env.stream.retryOptimisticSend(env.id)).toBe(false);
    jest.advanceTimersByTime(120_000);
    expect(row(env)?.status).toBe('indeterminate');
    expect(sentFrames(env.socket, 'send')).toHaveLength(1);
    expect(await env.stream.retryOptimisticSend(env.id)).toBe(false);
    expect(sentFrames(env.socket, 'send')).toHaveLength(1);
  } finally { env.unsubscribe(); }
});

test.each(['landed', 'not_landed'])('terminal %s retains its existing classification', async (delivery) => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery });
    await Promise.resolve();
    expect(row(env)?.status).toBe(delivery === 'landed' ? 'acked' : 'failed');
  } finally { env.unsubscribe(); }
});

test('late pending evidence cannot regress landed proof', async () => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'landed' });
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    await Promise.resolve();
    expect(row(env)?.status).toBe('acked');
    expect(caption(env)?.receiptCaption).toBe('sent');
  } finally { env.unsubscribe(); }
});

test('matching receipt converges the original pending row; mismatched stream cannot', async () => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    env.socket.message({ type: 'send.receipt.get.ok', request_id: env.frame.request_id, found: true,
      receipts: [{ request_id: env.frame.request_id, to_stream_id: 'hostc:codex:other', state: 'landed' }] });
    expect(row(env)?.status).toBe('indeterminate');
    env.socket.message({ type: 'send.receipt.get.ok', request_id: env.frame.request_id, found: true,
      receipts: [{ request_id: env.frame.request_id, to_stream_id: STREAM_ID, state: 'landed' }] });
    expect(row(env)?.status).toBe('acked');
    expect(row(env)?.request_id).toBe(env.frame.request_id);
    expect(sentFrames(env.socket, 'send')).toHaveLength(1);
  } finally { env.unsubscribe(); }
});


test('actual transport/model pending row renders Sending without Failed or Retry', async () => {
  const env = beginSend();
  let view: ReturnType<typeof render> | undefined;
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    await Promise.resolve();
    view = render(<TranscriptRow item={caption(env)} chrome={{ header: '#102a4a', accent: '#4da3ff', surface: '#0c1827', border: '#2f6ca5', title: 'Host C' }} onRetry={jest.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(view!.getByTestId('user-send-sending')).toBeTruthy();
    expect(view!.queryByTestId('user-send-failed')).toBeNull();
    expect(view!.queryByText('Retry')).toBeNull();
  } finally { view?.unmount(); env.unsubscribe(); }
});

test('committed pending never replays on a new socket and late USER proof retires it', async () => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    await Promise.resolve();
    env.socket.close();
    jest.advanceTimersByTime(1_000);
    const socket = MockWebSocket.instances.at(-1)!;
    expect(socket).not.toBe(env.socket);
    socket.open();
    socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID)] });
    expect(sentFrames(socket, 'send')).toHaveLength(0);
    expect(row(env)?.request_id).toBe(env.frame.request_id);
    expect(await env.stream.retryOptimisticSend(env.id)).toBe(false);
    socket.message({ type: 'chat.event', event: {
      daemon_seq: 42, host: 'hostc', provider: 'codex', session_id: STREAM_ID,
      session_name: 'chat-1', stream_id: STREAM_ID, kind: 'USER',
      text: 'synthetic pending message', timestamp: new Date().toISOString(), optimistic_id: env.id,
    } });
    expect(row(env)).toBeUndefined();
    expect(env.stream.getPentacleStreamState().events.filter(event => event.optimistic_id === env.id)).toHaveLength(1);
    socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    expect(row(env)).toBeUndefined();
    expect(sentFrames(socket, 'send')).toHaveLength(0);
  } finally { env.unsubscribe(); }
});

test('pending receipt without compatibility state stays pending, then matching landing converges', async () => {
  const env = beginSend();
  try {
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof' });
    await Promise.resolve();
    env.socket.message({ type: 'send.receipt.get.ok', request_id: env.frame.request_id, found: true,
      receipts: [{ request_id: env.frame.request_id, to_stream_id: STREAM_ID, delivery: 'committed_pending_proof' }] });
    expect(row(env)).toMatchObject({ status: 'indeterminate', action_committed: true });
    env.socket.message({ type: 'send.receipt.get.ok', request_id: env.frame.request_id, found: true,
      receipts: [{ request_id: env.frame.request_id, to_stream_id: STREAM_ID, state: 'landed' }] });
    expect(row(env)?.status).toBe('acked');
    env.socket.message({ type: 'send.receipt.get.ok', request_id: env.frame.request_id, found: true,
      receipts: [{ request_id: env.frame.request_id, to_stream_id: STREAM_ID, state: 'accepted', delivery: 'committed_pending_proof' }] });
    expect(row(env)?.status).toBe('acked');
  } finally { env.unsubscribe(); }
});

test.each([
  { to_stream_id: 'hostc:codex:other' },
  { session_generation: 'wrong-generation' },
  { request_id: 'unknown-request' },
])('mismatched pending evidence does not mutate the original row: %p', async (override) => {
  const env = beginSend();
  try {
    const before = row(env);
    env.socket.message({ type: 'send.result', request_id: env.frame.request_id, delivery: 'committed_pending_proof', ...override });
    await Promise.resolve();
    expect(row(env)).toEqual(before);
  } finally { env.unsubscribe(); }
});
