import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { useUserPreference } from '../src/services/userPreferences';
import * as stream from '../src/services/pentacleStream';
import type { PentacleEvent, PentacleSessionSummary } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Adisconnect-one' };
const mockAlert = jest.fn();
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});

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
    this.onclose?.({ code: 1000, reason: 'client', wasClean: true });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromServer() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: 'test_disconnect', wasClean: false });
  }
}

jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Alert') return { alert: mockAlert };
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
      if (prop === 'InteractionManager') return { runAfterInteractions: mockRunAfterInteractions };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => {
  const mock = require('./helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const parts = streamId.split(':');
  const sessionName = parts.at(-1) || streamId;
  return {
    stream_id: streamId,
    host: parts[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    title: `Disconnect ${sessionName}`,
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function serverUserEvent(streamId: string, text: string, daemonSeq: number, optimisticId?: string): PentacleEvent {
  const parts = streamId.split(':');
  const sessionName = parts.at(-1) || streamId;
  return {
    daemon_seq: daemonSeq,
    host: parts[0] || 'hostc',
    provider: 'codex',
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp: new Date(Date.now()).toISOString(),
    kind: 'USER',
    text,
    ...(optimisticId ? { optimistic_id: optimisticId } : {}),
  };
}

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected mock WebSocket instance');
  return socket;
}

async function mountConnectedSession(streamId: string) {
  mockParams = { streamId: encodeURIComponent(streamId) };
  const rendered = render(<SessionScreen />);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({ type: 'session.inventory', sessions: [session(streamId)] });
  });
  await screen.findByText(session(streamId).title || '');
  return { rendered, socket };
}

async function sendAndDisconnect(socket: MockWebSocket, text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
  const optimistic = stream.getPentacleStreamState().events.find((event) => event.text === text && event.client_origin === true);
  expect(optimistic?.pending).toBe(true);

  await act(async () => {
    socket.closeFromServer();
    await Promise.resolve();
  });
  expect(mockAlert).not.toHaveBeenCalled();

  // §A: a transport-cut (same daemon) leaves the ambiguous survivor 'dispatched' and PENDING
  // (not falsely failed); it auto-replays on the next reconnect generation.
  const afterDisconnect = stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimistic?.optimistic_id);
  expect(afterDisconnect?.pending).toBe(true);
  return optimistic?.optimistic_id || '';
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockAlert.mockClear();
  mockKeyboardDismiss.mockClear();
});

afterEach(() => {
  jest.clearAllTimers();
});

test('SessionScreen send rejection fails visibly and a stamped reconnect echo reconciles it', async () => {
  const streamId = 'hostc:codex:disconnect-one';
  const text = 'disconnect survives and reconciles';
  const { socket } = await mountConnectedSession(streamId);
  const optimisticId = await sendAndDisconnect(socket, text);

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  const reconnect = latestSocket();
  await act(async () => {
    reconnect.open();
    reconnect.message({
      type: 'snapshot',
      sessions: [session(streamId)],
      events: [serverUserEvent(streamId, text, 101, optimisticId)],
    });
  });

  await waitFor(() => {
    const events = stream.getPentacleStreamState().events;
    expect(events.find((event) => event.optimistic_id === optimisticId)).toMatchObject({
      correlatedDaemonSeq: 101,
      pending: false,
      text,
    });
  });
  expect(screen.getByText(text)).toBeTruthy();
});

test('landed send with a lost result keeps the composer cleared and suppresses the false disconnect error', async () => {
  const streamId = 'hostc:codex:disconnect-landed';
  const text = 'landed exactly once while result was lost';
  const { socket } = await mountConnectedSession(streamId);

  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  fireEvent.press(screen.getByTestId('composer-send-button'));
  await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
  await act(async () => {
    socket.closeFromServer();
    await Promise.resolve();
  });

  await waitFor(() => expect(screen.getByTestId('composer-input').props.value).toBe(''));
  expect(mockAlert).not.toHaveBeenCalled();
});

test('offline send stays queued and dispatches exactly once after reconnect', async () => {
  const streamId = 'hostc:codex:disconnect-before-dispatch';
  const text = 'not dispatched';
  const { socket } = await mountConnectedSession(streamId);
  await act(async () => {
    socket.closeFromServer();
    await Promise.resolve();
  });

  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  fireEvent.press(screen.getByTestId('composer-send-button'));

  await waitFor(() => expect(screen.getByTestId('composer-input').props.value).toBe(''));
  const optimistic = stream.getPentacleStreamState().events.find((event) => event.text === text && event.client_origin === true);
  expect(optimistic).toMatchObject({ pending: true });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimistic?.optimistic_id || '']).toMatchObject({
    status: 'queued',
  });
  expect(mockAlert).not.toHaveBeenCalled();

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  const reconnect = latestSocket();
  await act(async () => {
    reconnect.open();
    reconnect.message({ type: 'session.inventory', sessions: [session(streamId)] });
  });

  const replayedSends = reconnect.sent
    .map((payload) => JSON.parse(payload) as { type?: string; text?: string })
    .filter((payload) => payload.type === 'send' && payload.text === text);
  expect(replayedSends).toHaveLength(1);
});

test('definitive daemon rejection restores the composer and exposes retry', async () => {
  const streamId = 'hostc:codex:definitive-send-failure';
  const text = 'restore me after rejection';
  const { socket } = await mountConnectedSession(streamId);

  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  fireEvent.press(screen.getByTestId('composer-send-button'));
  const sendPayload = socket.sent
    .map((payload) => JSON.parse(payload) as { type?: string; request_id?: string })
    .find((payload) => payload.type === 'send');
  expect(sendPayload?.request_id).toBeTruthy();

  await act(async () => {
    socket.message({ type: 'send.error', request_id: sendPayload?.request_id, error: 'send rejected' });
  });

  await waitFor(() => expect(screen.getByTestId('composer-input').props.value).toBe(text));
  expect(screen.getByTestId('user-send-failed')).toBeTruthy();
  expect(screen.getByTestId('user-send-retry')).toBeTruthy();
});

test('send-reconnect case: an unconfirmed SessionScreen send stays sending (auto-replays) after reconnect, not falsely failed/retryable', async () => {
  const streamId = 'hostc:codex:disconnect-two';
  const text = 'disconnect survives, stays sending';
  const { socket } = await mountConnectedSession(streamId);
  const optimisticId = await sendAndDisconnect(socket, text);

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  const reconnect = latestSocket();
  await act(async () => {
    reconnect.open();
    reconnect.message({ type: 'session.inventory', sessions: [session(streamId)] });
  });

  // §A: transport-cut (same daemon) → the survivor auto-replays and stays 'dispatched'/pending,
  // NOT falsely failed. No retry affordance while it is sending; it reconciles on its echo or
  // becomes recoverable only on window expiry / owner-lost.
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)?.pending).toBe(true);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'dispatched',
  });

  act(() => {
    jest.advanceTimersByTime(60_000);
  });

  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)?.pending).toBe(true);
  expect(screen.queryByTestId('user-send-retry')).toBeNull();
  expect(screen.getByText(text)).toBeTruthy();
});

test('a composer send whose RPC timeout closes the silent transport stays sending (no false retry, no alert)', async () => {
  const streamId = 'hostc:codex:disconnect-one';
  const text = 'times out but stays sending';
  await mountConnectedSession(streamId);

  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
  const optimisticId = stream.getPentacleStreamState().events
    .find((event) => event.text === text && event.client_origin === true)?.optimistic_id;
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)?.pending).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();
  });

  // §A: the RPC-timeout transport-cut leaves the survivor 'dispatched'/pending (sending), not
  // falsely failed — it auto-replays on reconnect. No retry affordance while sending; no alert.
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)?.pending).toBe(true);
  expect(screen.queryByTestId('user-send-retry')).toBeNull();
  expect(mockAlert).not.toHaveBeenCalled();
});

