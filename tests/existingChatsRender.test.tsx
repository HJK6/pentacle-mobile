// T1 — reusable "existing chats render" regression lock (spec § T1).
//
// Drives the REAL session-screen render path over a corpus of existing chats
// (tests/fixtures/existingChatsCorpus.ts) and asserts that EVERY transcript row
// the model produces for the visible window actually mounts at the CLIENT, and
// that each message's key content is visible. This catches the reg1-class
// defect the operator reported — "I don't see the latest messages" — which is a
// client-side missing-row / transcript-freeze failure (the data is in the model
// but a row never reaches the screen).
//
// To extend coverage, add a chat to EXISTING_CHAT_CORPUS — no test changes
// needed; this suite parameterizes over the corpus.

import React from 'react';
import { act, render, type RenderAPI } from '@testing-library/react-native';

import {
  EXISTING_CHAT_CORPUS,
  buildExistingChatFrames,
  expectedFragments,
  type ExistingChat,
} from './fixtures/existingChatsCorpus';

// INITIAL_TRANSCRIPT_ROWS in the screen — the initial render window size.
const RENDER_WINDOW = 16;

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());

// Per-test the streamId param is swapped to the chat under test.
let mockStreamId = '';
jest.mock('expo-router', () => {
  const mock = require('./helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => ({ streamId: encodeURIComponent(mockStreamId) }),
  };
});

// FlatList mock that renders EVERY data row (no virtualization windowing), so a
// row dropped by the client — not the model — is observable as a missing mount.
jest.mock('react-native', () => {
  const ReactNative = jest.requireActual('react-native');
  const ReactForMock = require('react');
  const MockFlatList = ReactForMock.forwardRef((props: any, ref: any) => {
    ReactForMock.useImperativeHandle(ref, () => ({ scrollToOffset: jest.fn() }));
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
        return { runAfterInteractions: (fn: () => void) => ({ cancel: jest.fn(), __run: fn }) };
      }
      return target[prop as keyof typeof target];
    },
  });
});

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

async function flush() {
  await act(async () => {});
}

// Flatten every rendered <Text> string so we can assert visible fragments
// regardless of how the row chrome nests them.
function renderedText(api: RenderAPI): string {
  const { Text } = jest.requireActual('react-native');
  const stringify = (children: unknown): string => {
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(stringify).join('');
    return '';
  };
  return api.UNSAFE_getAllByType(Text).map((node) => stringify(node.props.children)).join('\n');
}

interface MountedChat {
  api: RenderAPI;
  telemetry: any[];
  state: unknown;
}

// One shared stream + socket for the whole suite (resetting modules per test
// would fork React and break hooks). Each corpus chat uses a UNIQUE streamId,
// so accumulated state is isolated by streamId in every assertion.
let stream: typeof import('../src/services/pentacleStream');
let core: typeof import('pentacle-chat-core');
let socket: MockWebSocket;
const telemetry: any[] = [];

beforeAll(async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  jest.useFakeTimers({ now: Date.parse('2026-06-16T12:00:00.000Z') });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  core.setTelemetrySink((payload) => telemetry.push(payload));

  (require('../src/hooks/usePentacleToken') as jest.Mock).mockReturnValue({ isReady: true, token: 'token' });

  // Show every row type (tool cards are hidden by default) so the corpus fully
  // exercises the render path. Go through the real setter so the value survives
  // the async hydration that would otherwise reset it to defaults.
  const prefs = require('../src/services/userPreferences') as typeof import('../src/services/userPreferences');
  prefs.__resetUserPreferencesForTests();
  await prefs.setUserPreference('showToolActions', true);

  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=existing_chats_render');

  stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  stream.subscribePentacleStream(jest.fn());
  act(() => {
    jest.advanceTimersByTime(0);
  });
  socket = MockWebSocket.instances[0];
  socket.open();
  await flush();

  // Seed the WHOLE corpus once: one inventory holding every chat, then each
  // chat's existing transcript replayed exactly as the daemon would. Unique
  // streamIds keep every chat isolated in later per-test assertions; cumulative
  // seq offsets keep daemon_seq globally monotonic so no chat's rows are dropped
  // as stale.
  let seqCursor = 0;
  const frames = EXISTING_CHAT_CORPUS.map((chat) => {
    const frame = buildExistingChatFrames(chat, seqCursor);
    seqCursor += chat.messages.length;
    return frame;
  });
  socket.message({ type: 'session.inventory', sessions: frames.map((f) => f.session) });
  for (const frame of frames) {
    for (const event of frame.events) {
      socket.message({ type: 'chat.event', event });
    }
  }
  // Cross-stream USER frames no longer synchronously flush unrelated transcript
  // batches. Let the normal batch timer settle the seeded corpus before this
  // render-only suite starts collecting mount telemetry.
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  await flush();
});

// The global afterEach (test/setup.ts) restores real timers and clears mock
// return values after every test — re-establish what each mount needs.
// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../app/pentacle/session/[streamId]'));

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-06-16T12:00:00.000Z') });
  (require('../src/hooks/usePentacleToken') as jest.Mock).mockReturnValue({ isReady: true, token: 'token' });
});

afterAll(() => {
  core.setTelemetrySink(null);
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  (require('../src/services/userPreferences') as typeof import('../src/services/userPreferences')).__resetUserPreferencesForTests();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});

// Seed one corpus chat's existing transcript over the shared socket exactly as
// the daemon replays it, mount the screen for that chat, and settle.
async function mountExistingChat(chat: ExistingChat): Promise<MountedChat> {
  telemetry.length = 0;
  mockStreamId = chat.streamId;

  // Re-arm the harness per chat so the transcript-ready settle (the 250ms
  // harness-timeout branch) fires on every mount, not just the first.
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=existing_chats_render');

  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const api = render(<SessionScreen />);
  await flush();
  act(() => {
    jest.advanceTimersByTime(250);
  });
  await flush();

  return { api, telemetry, state: stream.getPentacleStreamState() };
}

describe('existing chats render every transcript message at the client', () => {
  for (const chat of EXISTING_CHAT_CORPUS) {
    test(`${chat.id}: every row in the latest window mounts and shows its content`, async () => {
      const mounted = await mountExistingChat(chat);
      try {
        const { api, telemetry: events, state } = mounted;
        const { selectSessionDetail, TELEMETRY_EVENTS } = core;

        // The transcript actually rendered (not stuck on the loading spinner).
        expect(api.queryByTestId('transcript-list')).toBeTruthy();
        expect(api.queryByTestId('transcript-loading')).toBeNull();

        // The model's view of the initial render window — exactly what the
        // screen feeds its list. We assert the CLIENT renders all of it.
        const model = selectSessionDetail(state as any, chat.streamId, {
          showToolActions: true,
          visibleCount: RENDER_WINDOW,
        });
        expect(model).toBeTruthy();
        const windowItems = model!.transcriptItems;
        expect(windowItems.length).toBeGreaterThan(0);

        // Every transcript row the model produced for the window mounted at the
        // client. A missing id here IS the reg1 "missing latest message" bug.
        const mountedIds = new Set(
          events
            .filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ITEM_MOUNTED && p.data.stream_id === chat.streamId)
            .map((p) => p.data.id),
        );
        for (const item of windowItems) {
          expect(mountedIds.has(item.id)).toBe(true);
        }

        // The NEWEST message must always be visible (the operator's exact
        // complaint: "I don't see the latest messages").
        const newest = chat.messages[chat.messages.length - 1];
        const text = renderedText(api);
        for (const fragment of expectedFragments(newest)) {
          expect(text).toContain(fragment);
        }

        if (!chat.windowed) {
          // Whole transcript fits the window: assert EVERY message's content.
          for (const message of chat.messages) {
            for (const fragment of expectedFragments(message)) {
              expect(text).toContain(fragment);
            }
          }
          // No row dropped, no phantom row: client mounts exactly the model.
          const modelIds = new Set(windowItems.map((i) => i.id));
          expect(mountedIds).toEqual(modelIds);
        } else {
          // Long transcript: the window holds the most-recent rows. Prove the
          // tail (latest) renders and the head (oldest) is correctly windowed
          // out — i.e. windowing trims the OLDEST, never the latest.
          expect(windowItems.length).toBe(RENDER_WINDOW);
          const oldest = chat.messages[0];
          for (const fragment of expectedFragments(oldest)) {
            expect(text).not.toContain(fragment);
          }
        }
      } finally {
        act(() => {
          mounted.api.unmount();
        });
      }
    });
  }
});
