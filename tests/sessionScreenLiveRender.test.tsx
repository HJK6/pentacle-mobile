// Stage 5 — live-update case RNTL regression. Render the chat screen, push an additional
// assistant event for the open stream through the real reducer + selector
// pipeline, and assert the new event mounts in the visible transcript without
// unmounting/remounting the screen.
//
// Spec: docs/behavior-contract.md
// (live-update case: existing-chat reply doesn't render until nav-away). The screen
// subscribes to selectSessionDetail with Object.is identity; the cache used to
// return the previous reference even after the reducer mutated state.events,
// so React/SyncExternalStore short-circuited the re-render. Stage 5c's
// content-version cache key forces a new selector output on append.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { useUserPreference } from '../src/services/userPreferences';
import * as stream from '../src/services/pentacleStream';
import type { PentacleEvent, PentacleSessionSummary } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

const STREAM_ID = 'hostc:claude:bug-c-live';
let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
const cleanupFns: Array<() => void> = [];
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouterBack = jest.fn();
const mockRouterCanGoBack = jest.fn(() => true);
const mockRouterRedirect = jest.fn();
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  const timer = setTimeout(callback, 0);
  return { cancel: jest.fn(() => clearTimeout(timer)) };
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
}

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
      if (prop === 'InteractionManager') return { runAfterInteractions: mockRunAfterInteractions };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => {
  const ReactModule = require('react');
  const PassThrough = ({ children }: { children?: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, children);
  return {
    useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: mockRouterBack, canGoBack: mockRouterCanGoBack }),
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => {
      mockRouterRedirect(href);
      return null;
    },
    Stack: Object.assign(PassThrough, { Screen: () => null }),
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'bug-c-live',
    title: 'live-update case live render chat',
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: 'first reply',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function userEvent(daemonSeq: number, text: string): PentacleEvent {
  return {
    daemon_seq: daemonSeq,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'bug-c-live',
    stream_id: STREAM_ID,
    timestamp: '2026-05-13T12:00:00.500Z',
    kind: 'USER',
    text,
  };
}

function assistEvent(daemonSeq: number, text: string): PentacleEvent {
  return {
    daemon_seq: daemonSeq,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'bug-c-live',
    stream_id: STREAM_ID,
    timestamp: '2026-05-13T12:00:01.000Z',
    kind: 'ASSIST',
    text,
  };
}

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected mock WebSocket instance');
  return socket;
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
  mockKeyboardDismiss.mockClear();
  mockKeyboardAddListener.mockClear();
  mockRunAfterInteractions.mockClear();
  mockRouterPush.mockClear();
  mockRouterReplace.mockClear();
  mockRouterBack.mockClear();
  mockRouterRedirect.mockClear();
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
});

afterEach(() => {
  while (cleanupFns.length) {
    cleanupFns.pop()?.();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('live-update case regression: a new ASSIST event for the open stream renders without unmount/remount', async () => {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    // Seed an existing chat with prior history so the screen mounts onto a
    // populated transcript (the live-update case scenario is "existing chat, reply
    // doesn't render until nav-away").
    socket.message({
      type: 'snapshot',
      sessions: [session()],
      events: [userEvent(100, 'who are you'), assistEvent(101, 'first reply')],
    });
  });

  render(<SessionScreen />);

  // Allow the transcript-ready interaction-manager tick to flush.
  act(() => {
    jest.advanceTimersByTime(0);
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });

  expect(await screen.findByText('first reply')).toBeTruthy();
  expect(screen.queryByText('live-update case reply lands while screen is mounted')).toBeNull();

  // Now push a NEW assist event for the open stream, WITHOUT unmounting.
  await act(async () => {
    socket.message({
      type: 'chat.event',
      event: assistEvent(102, 'live-update case reply lands while screen is mounted'),
    });
  });

  // One tick to let useSyncExternalStoreWithSelector pick up the change.
  act(() => {
    jest.advanceTimersByTime(0);
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });

  await waitFor(() => {
    expect(screen.getByText('live-update case reply lands while screen is mounted')).toBeTruthy();
  });
  // Sanity: prior content still present, no nav-away occurred.
  expect(screen.getByText('first reply')).toBeTruthy();
  expect(mockRouterReplace).not.toHaveBeenCalled();
  expect(mockRouterPush).not.toHaveBeenCalled();
  expect(mockRouterBack).not.toHaveBeenCalled();
  expect(mockRouterRedirect).not.toHaveBeenCalled();
});

test('tmux timeout labels the open session without discarding its retained transcript and clears on recovery', async () => {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);
  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session({ working: true })],
      events: [userEvent(120, 'preserve this'), assistEvent(121, 'last good reply')],
    });
  });

  render(<SessionScreen />);
  expect(await screen.findByText('last good reply')).toBeTruthy();

  await act(async () => {
    socket.message({
      type: 'session.inventory',
      sessions: [session({
        working: true,
        pane_status: 'pane_unresponsive',
        pane_status_reason: 'tmux_probe_timeout',
        pane_status_since: '2026-08-01T22:00:20.000Z',
      })],
    });
  });

  expect(await screen.findByText('Session unresponsive — tmux did not answer')).toBeTruthy();
  expect(screen.getByText('last good reply')).toBeTruthy();

  await act(async () => {
    socket.message({
      type: 'session.inventory',
      sessions: [session({ working: false, pane_status: 'pane_confirmed' })],
    });
  });

  await waitFor(() => {
    expect(screen.queryByText('Session unresponsive — tmux did not answer')).toBeNull();
  });
  expect(screen.getByText('last good reply')).toBeTruthy();
});

test('Back to chats falls back to the chats tab when no navigation history exists', async () => {
  mockRouterCanGoBack.mockReturnValue(false);
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session()],
      events: [userEvent(110, 'open from push'), assistEvent(111, 'push target ready')],
    });
  });

  render(<SessionScreen />);
  expect(await screen.findByText('push target ready')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Back to chats'));

  expect(mockKeyboardDismiss).toHaveBeenCalled();
  expect(mockRouterBack).not.toHaveBeenCalled();
  expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/chats');
});

test('session detail header renders status card fields and indicators', async () => {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session({
        status_card: {
          goal: 'Implement header status card',
          plan: [
            { text: 'wire data', status: 'done' },
            { text: 'render header', status: 'active' },
          ],
          update: 'header render is under test',
          handoff_planned: true,
          updated_at: '2026-05-13T11:55:00.000Z',
        },
        context_tokens: 97000,
        spec_issues: [{ obligation_id: 'ob-7', detail: 'detail header spec drift' }],
      })],
      events: [userEvent(120, 'open status card'), assistEvent(121, 'status card transcript')],
    });
  });

  render(<SessionScreen />);
  expect(await screen.findByText('status card transcript')).toBeTruthy();
  fireEvent.press(screen.getByTestId('session-status-overlay-trigger'));
  for (const value of [
    'Implement header status card',
    'render header',
    'header render is under test',
    '· 5m ago',
    '↗ handoff',
    '97k',
  ]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.getByLabelText('1 of 2 plan steps complete')).toBeTruthy();
});

test('session detail header updates when inventory adds status card fields', async () => {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session()],
      events: [userEvent(130, 'open without card'), assistEvent(131, 'status card target transcript')],
    });
  });

  render(<SessionScreen />);
  expect(await screen.findByText('status card target transcript')).toBeTruthy();
  expect(screen.queryByText('Inventory status card arrived')).toBeNull();

  await act(async () => {
    socket.message({
      type: 'session.inventory',
      sessions: [session({
        status_card: {
          goal: 'Inventory status card arrived',
          plan: [
            { text: 'mount detail', status: 'done' },
            { text: 'apply inventory', status: 'active' },
          ],
          update: 'inventory-only update rendered',
          updated_at: '2026-05-13T11:58:00.000Z',
        },
        context_tokens: 123000,
        model_context_window: 246000,
        context_level: 'warning',
        spec_issues: [{ obligation_id: 'ob-8', detail: 'inventory detail issue' }],
      })],
    });
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });

  fireEvent.press(screen.getByTestId('session-status-overlay-trigger'));

  for (const value of [
    'Inventory status card arrived',
    'apply inventory',
    'inventory-only update rendered',
    '· 2m ago',
    '123k · 50%',
  ]) {
    expect(await screen.findByText(value)).toBeTruthy();
  }
  expect(screen.getByLabelText('1 of 2 plan steps complete')).toBeTruthy();
});

test('live-update case regression: a progressive prefix-extension at the same daemon_seq updates the rendered row in place', async () => {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session()],
      events: [userEvent(200, 'tell me a story')],
    });
  });

  render(<SessionScreen />);

  // First chunk of the streaming reply.
  await act(async () => {
    socket.message({
      type: 'chat.event',
      event: assistEvent(201, 'Once upon'),
    });
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });
  await waitFor(() => expect(screen.getByText('Once upon')).toBeTruthy());

  // Progressive prefix-extension at the same daemon_seq — used to be dropped
  // as a duplicate, leaving the row stuck at "Once upon" until nav-away.
  await act(async () => {
    socket.message({
      type: 'chat.event',
      event: assistEvent(201, 'Once upon a time, in a land far away'),
    });
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });

  await waitFor(() => {
    expect(screen.getByText('Once upon a time, in a land far away')).toBeTruthy();
  });
});

