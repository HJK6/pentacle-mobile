import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { useUserPreference } from '../src/services/userPreferences';
import * as stream from '../src/services/pentacleStream';
import type { PentacleEvent, PentacleSessionSummary } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Afresh' };
const cleanupFns: Array<() => void> = [];
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
const mockRouterBack = jest.fn();
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
  const React = require('react');
  const PassThrough = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return {
    useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, back: mockRouterBack }),
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

function session(provider: 'claude' | 'codex'): PentacleSessionSummary {
  return {
    stream_id: `hostc:${provider}:fresh`,
    host: 'hostc',
    provider,
    session_name: 'fresh',
    title: `${provider} fresh chat`,
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function assistEvent(provider: 'claude' | 'codex'): PentacleEvent {
  return {
    daemon_seq: provider === 'claude' ? 101 : 201,
    stream_id: `hostc:${provider}:fresh`,
    host: 'hostc',
    provider,
    session_id: 'fresh',
    session_name: 'fresh',
    timestamp: '2026-05-13T12:00:01.000Z',
    kind: 'ASSIST',
    text: `${provider} first reply`,
  };
}

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected mock WebSocket instance');
  return socket;
}

async function seedSpawnedSession(provider: 'claude' | 'codex') {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  cleanupFns.push(unsubscribe);

  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();

  await act(async () => {
    socket.open();
  });

  const spawnPromise = stream.spawnPentacleSession({ host: 'hostc', provider });
  const spawnPayload = JSON.parse(socket.sent.at(-1) || '{}');

  await act(async () => {
    socket.message({
      type: 'spawn.ok',
      request_id: spawnPayload.request_id,
      session: session(provider),
    });
    await expect(spawnPromise).resolves.toEqual(expect.objectContaining({
      stream_id: `hostc:${provider}:fresh`,
    }));
  });

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
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'TEST' });
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockKeyboardDismiss.mockClear();
  mockKeyboardAddListener.mockClear();
  mockRunAfterInteractions.mockClear();
  mockRouterPush.mockClear();
  mockRouterReplace.mockClear();
  mockRouterBack.mockClear();
  mockRouterRedirect.mockClear();
});

afterEach(() => {
  while (cleanupFns.length) {
    cleanupFns.pop()?.();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe.each(['claude', 'codex'] as const)('new-chat live render for %s', (provider) => {
  test('renders the first assistant event through the real stream before transcript timers flush', async () => {
    mockParams = { streamId: encodeURIComponent(`hostc:${provider}:fresh`) };
    const socket = await seedSpawnedSession(provider);
    const baselineSubscriberCount = stream.__getPentacleStreamSubscriberCountForTests();

    render(<SessionScreen />);

    expect(screen.getByText(`${provider} fresh chat`)).toBeTruthy();
    expect(screen.getByTestId('transcript-loading')).toBeTruthy();
    expect(screen.queryByText(`${provider} first reply`)).toBeNull();
    const preFlushSubscriberCount = stream.__getPentacleStreamSubscriberCountForTests();
    expect(preFlushSubscriberCount - baselineSubscriberCount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      socket.message({ type: 'chat.event', event: assistEvent(provider) });
    });
    expect(stream.getPentacleStreamState().events.find(
      (event) => event.stream_id === `hostc:${provider}:fresh` && event.kind === 'ASSIST',
    )).toEqual(expect.objectContaining({ text: `${provider} first reply` }));
    expect(screen.getByText(`${provider} first reply`)).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(0);
    });
    act(() => {
      jest.advanceTimersByTime(16);
    });

    expect(stream.__getPentacleStreamSubscriberCountForTests()).toBe(preFlushSubscriberCount);
    expect(screen.getByText(`${provider} first reply`)).toBeTruthy();
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterBack).not.toHaveBeenCalled();
    expect(mockRouterRedirect).not.toHaveBeenCalled();
  });
});
