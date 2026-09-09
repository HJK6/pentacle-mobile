// Regression for chat_autoscroll_behavior_contract.
//
// The transcript list is `inverted`, so the newest row is data index 0 and sits at
// content-layout y=0; contentOffset.y===0 is the visual bottom. A new row therefore grows
// the content at its START, which is exactly what `maintainVisibleContentPosition` holds
// still — the native list bumps contentOffset by the new row's height so the previously
// visible rows do not move. Applied unconditionally (as it was before this spec), that
// cancels bottom-follow: the new row lands off-screen, the JS scrollToOffset(0) is undone
// after layout, and the resulting offset trips NEAR_BOTTOM_OFFSET so the scroll-to-bottom
// arrow appears even though the user never scrolled.
//
// Position maintenance is still correct — and load-bearing — while the user IS scrolled up
// (contract point 4). These assertions therefore pin the CONDITIONAL wiring: anchored only
// when scrolled up, never while pinned to the bottom.
//
// These are effect assertions on what the screen actually hands the list (the anchoring prop
// and real scrollToOffset calls), not on the `chat:autoscroll_decision` telemetry reason —
// telemetry reports intent, and the defect was intent landing but not taking effect. The
// native half of that (position maintenance undoing a programmatic scroll) is unobservable
// from Jest and is covered by test/e2e/scenarios/mock_autoscroll_at_bottom_follow.py.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import usePentacleToken from '../src/hooks/usePentacleToken';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

const STREAM_ID = 'hostc:codex:autoscroll';
// NEAR_BOTTOM_OFFSET is 120; 480 is unambiguously "the user scrolled up".
const SCROLLED_UP_OFFSET = 480;

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
let lastFlatListProps: any = null;
// One entry per transcript-list render: how many rows it mounted, and whether native
// position maintenance was armed for that exact commit.
let mockRenderLog: Array<{ newestRowId: string | null; anchored: boolean }> = [];
const mockScrollToOffset = jest.fn();

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

jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('react-native', () => {
  const ReactNative = jest.requireActual('react-native');
  const ReactForMock = require('react');
  // Captures the props the screen hands the transcript list, so the anchoring prop and the
  // scroll calls can be asserted directly instead of inferred.
  const MockFlatList = ReactForMock.forwardRef((props: any, ref: any) => {
    lastFlatListProps = props;
    mockRenderLog.push({
      // Inverted list: data[0] is the newest row, so this identifies the commit that first
      // carried an arriving message.
      newestRowId: (props.data || [])[0]?.id ?? null,
      anchored: Boolean(props.maintainVisibleContentPosition),
    });
    ReactForMock.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
    const rows = (props.data || []).map((item: any, index: number) => (
      <ReactNative.View key={props.keyExtractor ? props.keyExtractor(item, index) : String(index)}>
        {props.renderItem({ item, index })}
      </ReactNative.View>
    ));
    const footer = typeof props.ListFooterComponent === 'function'
      ? props.ListFooterComponent()
      : props.ListFooterComponent;
    return (
      <ReactNative.View testID={props.testID}>
        {rows}
        {footer}
      </ReactNative.View>
    );
  });
  return new Proxy(ReactNative, {
    get(target, prop) {
      if (prop === 'FlatList') return MockFlatList;
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) };
      if (prop === 'InteractionManager') {
        return {
          runAfterInteractions: (callback: () => void) => {
            callback();
            return { cancel: jest.fn() };
          },
        };
      }
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

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'autoscroll',
    title: 'Autoscroll chat',
    last_event_at: '2026-07-23T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(daemonSeq: number, text: string, kind = 'ASSIST'): PentacleEvent {
  return {
    daemon_seq: daemonSeq,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'autoscroll',
    stream_id: STREAM_ID,
    timestamp: new Date(Date.parse('2026-07-23T12:00:00.000Z') + daemonSeq * 1000).toISOString(),
    kind,
    text,
  } as PentacleEvent;
}

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected mock WebSocket instance');
  return socket;
}

async function flush() {
  await act(async () => {});
}

// Lets batched transcript updates apply and any rAF-scheduled scroll run.
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  await flush();
}

/** The anchoring prop the screen hands the inverted list, normalized to a boolean. */
function listIsAnchored() {
  const value = lastFlatListProps?.maintainVisibleContentPosition;
  return Boolean(value && typeof value === 'object');
}

function scrolledToBottomCalls() {
  return mockScrollToOffset.mock.calls.filter(([args]) => args && args.offset === 0);
}

/** Drives the list's real onScroll handler, as a user drag would. */
async function scrollTo(offset: number) {
  await act(async () => {
    lastFlatListProps.onScrollBeginDrag?.({ nativeEvent: { contentOffset: { y: offset } } });
    lastFlatListProps.onScroll({ nativeEvent: { contentOffset: { y: offset } } });
    lastFlatListProps.onScrollEndDrag?.({ nativeEvent: { contentOffset: { y: offset } } });
  });
  await flush();
}

async function mountAtBottom() {
  const rendered = render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(0);
  });
  const socket = latestSocket();
  await act(async () => {
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [session()],
      events: [
        event(1, 'seed one'),
        event(2, 'seed two'),
        event(3, 'seed three'),
      ],
    });
  });
  await settle();
  await waitFor(() => expect(screen.getByTestId('transcript-list')).toBeTruthy());
  // Mount performs its own cold-start scroll; the assertions below are about what
  // happens AFTER the chat is settled at the bottom.
  mockScrollToOffset.mockClear();
  return socket;
}

let SessionScreen: React.ComponentType;

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-07-23T12:00:00.000Z') });
  MockWebSocket.instances = [];
  lastFlatListProps = null;
  mockRenderLog = [];
  mockScrollToOffset.mockClear();
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  SessionScreen = require('../app/pentacle/session/[streamId]').default;
});

afterEach(() => {
  jest.clearAllTimers();
});

test('the inverted transcript is anchored only while the user is scrolled up', async () => {
  await mountAtBottom();

  // Pinned to the bottom: anchoring here is what cancels bottom-follow, because a new row
  // grows the content at its start and the list would hold the old rows still.
  expect(listIsAnchored()).toBe(false);

  await scrollTo(SCROLLED_UP_OFFSET);
  // Scrolled up: anchoring is what stops an incoming message yanking the viewport.
  expect(listIsAnchored()).toBe(true);
  expect(lastFlatListProps.maintainVisibleContentPosition).toMatchObject({ minIndexForVisible: 0 });

  await scrollTo(0);
  expect(listIsAnchored()).toBe(false);
});

test('a new message while pinned to the bottom scrolls to the bottom and shows no arrow', async () => {
  const socket = await mountAtBottom();

  expect(screen.queryByTestId('new-messages-pill')).toBeNull();

  await act(async () => {
    socket.message({ type: 'chat.event', event: event(4, 'arrives while pinned') });
  });
  await settle();

  expect(screen.getByText('arrives while pinned')).toBeTruthy();
  expect(scrolledToBottomCalls().length).toBeGreaterThan(0);
  expect(listIsAnchored()).toBe(false);
  // Contract point 2: the arrow is for a user who scrolled up, not for a followed message.
  expect(screen.queryByTestId('new-messages-pill')).toBeNull();
});

test('a new message while scrolled up neither scrolls nor unanchors the list', async () => {
  const socket = await mountAtBottom();
  await scrollTo(SCROLLED_UP_OFFSET);
  mockScrollToOffset.mockClear();

  await act(async () => {
    socket.message({ type: 'chat.event', event: event(4, 'arrives while scrolled up') });
  });
  await settle();

  // Contract point 4: no yank — no scroll issued, and the list stays anchored so the
  // native side holds the viewport still.
  expect(scrolledToBottomCalls()).toHaveLength(0);
  expect(listIsAnchored()).toBe(true);
  expect(screen.getByTestId('new-messages-pill')).toBeTruthy();
});

// Native position maintenance captures its anchor child BEFORE mounting new children, so the
// prop must already be correct in the very commit that mounts an arriving row. That is why the
// production prop reads the synchronous `isAtBottomRef` and not the `isAtBottom` state, which
// trails it by a commit.
//
// This uses a USER-kind event deliberately. `shouldApplyLiveEventImmediately`
// (src/services/pentacleStream.ts) applies USER (and DRAFT/WORKING, and leading-edge bulk)
// frames to the external store IMMEDIATELY rather than through the batch-window timer, so in
// production the row can render on the sync lane before the scroll-driven state update commits.
//
// The scroll handlers run inside startTransition so their state update takes the transition
// lane, while the USER frame reaches the external store on the sync lane. That reproduces the
// production priority inversion — a sync-lane store render preempting the lower-priority scroll
// state update — which a plain batched act() hides by flushing both together.
//
// This test DISCRIMINATES: with the production ref-driven prop it passes; changing only the prop
// to the `isAtBottom` state fails it with unanchored new-row renders. Two earlier attempts at
// this regression did not discriminate (one used a burst-batched ASSIST frame, one omitted the
// transition lane), and the resulting claim that no Jest-tier test could discriminate was wrong
// — QA round 3 refuted it by building this arrangement.
test('a USER append on the sync lane mounts anchored even while the scroll update is still pending', async () => {
  const socket = await mountAtBottom();
  const newestBefore = lastFlatListProps.data[0]?.id ?? null;
  mockRenderLog = [];

  // One act: the scroll-up is demoted to the transition lane, then the message arrives and is
  // applied to the store immediately, rendering before the scroll state has committed.
  await act(async () => {
    React.startTransition(() => {
      lastFlatListProps.onScrollBeginDrag?.({ nativeEvent: { contentOffset: { y: SCROLLED_UP_OFFSET } } });
      lastFlatListProps.onScroll({ nativeEvent: { contentOffset: { y: SCROLLED_UP_OFFSET } } });
    });
    socket.message({ type: 'chat.event', event: event(4, 'arrives on the immediate lane', 'USER') });
  });
  await settle();

  expect(screen.getByText('arrives on the immediate lane')).toBeTruthy();
  // The arriving message really did become the newest row during the window under test.
  const arrivedId = lastFlatListProps.data[0]?.id ?? null;
  expect(arrivedId).not.toBe(newestBefore);
  const growthRenders = mockRenderLog.filter((entry) => entry.newestRowId === arrivedId);
  expect(growthRenders.length).toBeGreaterThan(0);
  // Every commit that carried the new row must already have been anchored, or the native side
  // captures no anchor and the append yanks the viewport the user just scrolled.
  expect(growthRenders.filter((entry) => !entry.anchored)).toHaveLength(0);
  expect(scrolledToBottomCalls()).toHaveLength(0);
});

test('sending scrolls to the bottom and unanchors the list even when scrolled up', async () => {
  await mountAtBottom();
  await scrollTo(SCROLLED_UP_OFFSET);
  expect(listIsAnchored()).toBe(true);
  mockScrollToOffset.mockClear();

  fireEvent.changeText(screen.getByTestId('composer-input'), 'my own message');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  await settle();

  // Contract point 3: sending always returns to the bottom, whatever the prior position —
  // and the list must be unanchored, or the optimistic row's insertion pushes it straight
  // back off the bottom.
  expect(scrolledToBottomCalls().length).toBeGreaterThan(0);
  expect(listIsAnchored()).toBe(false);
  expect(screen.queryByTestId('new-messages-pill')).toBeNull();
});

