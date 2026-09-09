import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { INITIAL_PENTACLE_LIMITS, setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import usePentacleToken from '../src/hooks/usePentacleToken';
import {
  requestStreamEvents,
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
} from '../src/services/pentacleStream';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockIsFocused = true;
let mockState: any;
let mockHistoryLoadState: { currentGenerationComplete: boolean; fresh: boolean; requestStatus: string };
const telemetryEvents: TelemetryPayload[] = [];
async function flushPendingWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
const mockActions = {
  sendMessage: jest.fn(),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_hostc_codex_one_1'),
  markOptimisticFailed: jest.fn(),
  retryOptimisticSend: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
  markStreamOpenIntent: jest.fn(),
};
const mockRunAfterInteractions = jest.fn(() => ({ cancel: jest.fn() }));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) };
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
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => mockHistoryLoadState),
  sameStreamEventsLoadState: jest.fn((a, b) => (
    a.currentGenerationComplete === b.currentGenerationComplete &&
    a.fresh === b.fresh &&
    a.requestStatus === b.requestStatus
  )),
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
      workingState: state.workingStates?.[streamId],
      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
    };
  }),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'press-in'),
}));

// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../app/pentacle/session/[streamId]'));

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_HARNESS = '1';
  telemetryEvents.length = 0;
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockIsFocused = true;
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      title: 'Migration plan',
      last_event_at: '2026-05-08T00:00:00Z',
      last_text: 'Previous answer',
      last_kind: 'ASSIST',
      online: true,
    }],
    drafts: {},
    events: [{
      daemon_seq: 1,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:00Z',
      kind: 'USER',
      text: 'Ship Phase B',
    }, {
      daemon_seq: 2,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:01Z',
      kind: 'ASSIST',
      text: 'Already visible final answer',
    }],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    workingStates: {},
  };
  mockHistoryLoadState = { currentGenerationComplete: false, fresh: false, requestStatus: 'idle' };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (requestStreamEvents as jest.Mock).mockReset();
  (requestStreamEvents as jest.Mock).mockResolvedValue([]);
  setTelemetrySink((payload) => telemetryEvents.push(payload));

  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=open_existing_chat_hostc');
});

afterEach(() => {
  setTelemetrySink(null);
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
});

test('armed harness reopen path keeps assistant transcript rows and emits question-flow telemetry tags', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const { MOUNT_FETCH_LIMIT } = require('../app/pentacle/session/[streamId]');
  expect(MOUNT_FETCH_LIMIT).toBe(25);

  render(<SessionScreen />);

  expect(mockRunAfterInteractions).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('transcript-loading')).toBeNull();
  expect(screen.getByTestId('transcript-list')).toBeTruthy();
  expect(screen.getByText('Ship Phase B')).toBeTruthy();
  expect(screen.getByText('Already visible final answer')).toBeTruthy();
  expect(telemetryEvents.find((event) => String(event.message) === 'chat.open.instant_open')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      entry_source: 'press-in',
      fetch_limit: MOUNT_FETCH_LIMIT,
      transcript_count: 3,
    },
  });
  expect(telemetryEvents.find((event) => event.message === 'harness:session_screen_mount')).toMatchObject({
    data: { stream_id: 'hostc:codex:one' },
  });

  // Regression: requestStreamEvents must be called with a BOUNDED limit so
  // opening an existing long-running chat doesn't pull the reducer's
  // 1200-event cap and block the JS thread (user-reported freeze 2026-05-17
  // PT, "screen freezes a bit … keyboard tap doesn't scroll up, back is not
  // responsive for a sec"). Asserts both: (a) called once with the streamId,
  // and (b) a numeric limit was passed (catches a future maintainer removing
  // the limit and reintroducing the freeze).
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  const [callStreamId, callLimit, callOptions] = (requestStreamEvents as jest.Mock).mock.calls[0];
  expect(callStreamId).toBe('hostc:codex:one');
  expect(typeof callLimit).toBe('number');
  expect(callLimit).toBeGreaterThan(0);
  // Defense against a future "let's bump the page size" that silently
  // re-introduces the freeze — the reducer cap is 1200 (PENTACLE_RECENT_EVENT_LIMIT),
  // so any mount limit ≥ that wedges back the bug.
  expect(callLimit).toBeLessThan(1000);
  expect(callLimit).toBe(MOUNT_FETCH_LIMIT);
  expect(callOptions).toEqual(expect.objectContaining({
    purpose: 'mount-fetch',
    entrySource: 'press-in',
  }));

  act(() => {
    jest.advanceTimersByTime(249);
  });
  expect(screen.queryByTestId('transcript-loading')).toBeNull();

  act(() => {
    jest.advanceTimersByTime(1);
  });

  expect(screen.getByTestId('transcript-list')).toBeTruthy();
  expect(telemetryEvents.find((event) => event.message === 'harness:transcript_ready_settled')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      branch: 'harness_timeout',
      subsystem: 'question_flow',
      bug_ref: 'trackD_bug2_reopen',
    },
  });

  await act(async () => {
    await Promise.resolve();
  });
  await flushPendingWork();

  expect(telemetryEvents.find((event) => String(event.message) === 'question:reopen_fetch_attempt')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      subsystem: 'question_flow',
      bug_ref: 'trackD_bug2_reopen',
      fetch_limit: MOUNT_FETCH_LIMIT,
    },
  });
  expect(telemetryEvents.find((event) => String(event.message) === 'question:reopen_fetch_ready')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      subsystem: 'question_flow',
      bug_ref: 'trackD_bug2_reopen',
      fetch_limit: MOUNT_FETCH_LIMIT,
    },
  });
  await flushPendingWork();
  expect(telemetryEvents.find((event) => String(event.message) === 'chat:history_backfill_rendered')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      fetch_limit: MOUNT_FETCH_LIMIT,
    },
  });
});

test('history fetch waits for connection before firing', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  mockState.connected = false;

  const rendered = render(<SessionScreen />);
  expect(requestStreamEvents).not.toHaveBeenCalled();

  mockState = { ...mockState, connected: true };
  rendered.rerender(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  expect(requestStreamEvents).toHaveBeenCalledWith(
    'hostc:codex:one',
    expect.any(Number),
    expect.objectContaining({ purpose: 'mount-fetch' }),
  );
});

test('load-state case: a never-loaded chat opened while disconnected shows loading, NOT a premature empty state', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  // Disconnected + globally hydrated + no events for this chat = we have NOT
  // loaded this chat's daemon state. The model: loading covers offline; never a
  // premature "No messages yet." (which would wrongly imply the chat is empty).
  mockState = {
    ...mockState,
    connected: false,
    hasHydrated: true,
    events: [],
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: undefined,
      last_text: '',
      last_kind: undefined,
    }],
  };

  render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(screen.getByTestId('transcript-loading')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();
  expect(telemetryEvents.find((event) => String(event.message) === 'chat.open.spinner_on_open')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      entry_source: 'press-in',
      transcript_count: 0,
      history_fetch_in_flight: false,
    },
  });
});

test('reconnecting case: a disconnected load surfaces a "Reconnecting…" affordance (never a blank/empty state)', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  mockState = {
    ...mockState,
    connected: false,
    connecting: false,
    hasHydrated: true,
    events: [],
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: undefined,
      last_text: '',
      last_kind: undefined,
    }],
  };

  render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(screen.getByTestId('transcript-loading')).toBeTruthy();
  expect(screen.getByTestId('transcript-reconnecting-hint')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();
});

test('hydration case regression: chat open renders loading until hydration and first history fetch settle', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  let resolveFetch!: (events: unknown[]) => void;
  (requestStreamEvents as jest.Mock).mockReturnValueOnce(new Promise((resolve) => {
    resolveFetch = resolve;
  }));
  mockState = {
    ...mockState,
    hasHydrated: false,
    events: [],
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: undefined,
      last_text: '',
      last_kind: undefined,
    }],
  };

  const rendered = render(<SessionScreen />);

  act(() => {
    jest.advanceTimersByTime(250);
  });
  expect(screen.getByTestId('transcript-loading')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();
  expect(telemetryEvents.some((event) => String(event.message) === 'chat:empty_state_rendered')).toBe(false);

  mockState = {
    ...mockState,
    hasHydrated: true,
  };
  rendered.rerender(<SessionScreen />);
  expect(screen.getByTestId('transcript-loading')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();

  await act(async () => {
    mockHistoryLoadState = { currentGenerationComplete: true, fresh: true, requestStatus: 'ready' };
    resolveFetch([]);
    await Promise.resolve();
  });

  await flushPendingWork();
  expect(screen.getByText('No messages yet.')).toBeTruthy();
  expect(screen.queryByTestId('transcript-loading')).toBeNull();
  expect(telemetryEvents.find((event) => String(event.message) === 'chat:empty_state_rendered')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      has_hydrated: true,
      history_fetch_in_flight: false,
      subsystem: 'chat_open_loading',
      bug_ref: 'remaining_chat_bugs_bug2_loading_state',
    },
  });
});

test('history fetch retries after a failed attempt', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  (requestStreamEvents as jest.Mock)
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce([]);

  render(<SessionScreen />);

  await flushPendingWork();
  expect(telemetryEvents.find((event) => String(event.message) === 'question:reopen_fetch_failed')).toBeTruthy();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  await act(async () => {
    jest.advanceTimersByTime(1000);
  });

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
});

test('history fetch is idempotent while connected and refetches after reconnect', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const rendered = render(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  rendered.rerender(<SessionScreen />);
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  mockState = { ...mockState, connected: false };
  rendered.rerender(<SessionScreen />);
  mockHistoryLoadState = { currentGenerationComplete: false, fresh: false, requestStatus: 'idle' };
  mockState = { ...mockState, connected: true };
  rendered.rerender(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
});

test('a completed fresh prefetch is mount-visible and does not issue a duplicate RPC', () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  mockState = {
    ...mockState,
    events: [],
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: undefined,
      last_text: '',
      last_kind: undefined,
    }],
  };
  mockHistoryLoadState = { currentGenerationComplete: true, fresh: true, requestStatus: 'ready' };

  render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(requestStreamEvents).not.toHaveBeenCalled();
  expect(screen.getByText('No messages yet.')).toBeTruthy();
  expect(screen.queryByTestId('transcript-loading')).toBeNull();
});

test('a stale completed prefetch revalidates once, while an in-flight prefetch owns the request', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  mockHistoryLoadState = { currentGenerationComplete: true, fresh: false, requestStatus: 'idle' };
  const rendered = render(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  mockHistoryLoadState = { currentGenerationComplete: false, fresh: false, requestStatus: 'prefetching' };
  rendered.rerender(<SessionScreen />);
  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
});

test('hydration case regression: in-flight reconnect refetch keeps loading and suppresses empty state during cache invalidation', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  (requestStreamEvents as jest.Mock)
    .mockResolvedValueOnce(mockState.events)
    .mockReturnValueOnce(new Promise(() => {}));

  const rendered = render(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(250);
    await Promise.resolve();
  });
  await flushPendingWork();
  expect(screen.getByText('Already visible final answer')).toBeTruthy();

  mockState = { ...mockState, connected: false };
  rendered.rerender(<SessionScreen />);
  mockState = { ...mockState, connected: true };
  rendered.rerender(<SessionScreen />);
  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);

  mockState = {
    ...mockState,
    connecting: true,
    events: [],
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: undefined,
      last_text: '',
      last_kind: undefined,
    }],
  };
  rendered.rerender(<SessionScreen />);

  mockIsFocused = false;
  rendered.rerender(<SessionScreen />);
  mockIsFocused = true;
  mockState = { ...mockState, connecting: false };
  rendered.rerender(<SessionScreen />);

  expect(screen.getByTestId('transcript-loading')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();
  expect(telemetryEvents.find((event) => (
    String(event.message) === 'chat:empty_state_rendered' &&
    event.data?.history_fetch_in_flight === false &&
    event.data?.transcript_count === 0
  ))).toBeUndefined();
});

test('hydration case regression: a chat that already holds rows never flashes the loading spinner or empty state while a refetch is in flight', async () => {
  // Complement of the rowless in-flight test above: there, a fetch in flight
  // with NO rows must KEEP the spinner; here, a fetch in flight WITH rows must
  // NOT show one. Pins the `rowlessIdle` gate on `detailIsHydrating` from both
  // sides so the unconditional `setHistoryFetchInFlight(true)` kick-off
  // ([streamId].tsx:~950) cannot flash the spinner/empty for a data-present chat.
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  (requestStreamEvents as jest.Mock)
    .mockResolvedValueOnce(mockState.events)
    .mockReturnValueOnce(new Promise(() => {}));

  const rendered = render(<SessionScreen />);

  // Rows are present from the first frame (cached/instant open). The initial
  // transcriptReady settle is the only intended loading window; once it settles
  // the transcript renders and the spinner is gone.
  await act(async () => {
    jest.advanceTimersByTime(250);
    await Promise.resolve();
  });
  await flushPendingWork();
  expect(screen.getByText('Already visible final answer')).toBeTruthy();
  expect(screen.getByTestId('transcript-list')).toBeTruthy();
  expect(screen.queryByTestId('transcript-loading')).toBeNull();

  // Connection flicker clears the fetched set and kicks a fresh history fetch
  // that never resolves -> historyFetchInFlight stays latched true. With rows
  // still present rowlessIdle is false, so detailIsHydrating must remain false.
  mockState = { ...mockState, connected: false };
  rendered.rerender(<SessionScreen />);
  mockState = { ...mockState, connected: true };
  rendered.rerender(<SessionScreen />);
  // No flash at the exact moment the refetch goes in flight...
  expect(screen.queryByTestId('transcript-loading')).toBeNull();
  expect(screen.getByTestId('transcript-list')).toBeTruthy();

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);

  // ...and none after it settles into the steady in-flight state.
  expect(screen.getByTestId('transcript-list')).toBeTruthy();
  expect(screen.queryByTestId('transcript-loading')).toBeNull();
  expect(screen.getByText('Already visible final answer')).toBeTruthy();
  expect(screen.queryByText('No messages yet.')).toBeNull();
  expect(telemetryEvents.some((event) => String(event.message) === 'chat:empty_state_rendered')).toBe(false);
});

test('history-recovery case: a summary that advances past the newest stored event triggers a recovery refetch (recovers a live frame dropped on the lossy link)', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const rendered = render(<SessionScreen />);

  // Initial mount fetch (the once-per-connection backfill).
  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  rendered.rerender(<SessionScreen />);
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  // A terminal/tmux message is committed on the daemon at 00:05. The resilient
  // session summary advances (last_event_at / last_text / last_kind), but the
  // one-shot chat.event frame is dropped on the 33%-loss link, so state.events
  // still ends at the older tail (seq 2 @ 00:00:01) and never gains the row.
  mockState = {
    ...mockState,
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: '2026-05-08T00:05:00Z',
      last_text: 'hello from the terminal',
      last_kind: 'USER',
    }],
  };
  rendered.rerender(<SessionScreen />);

  // The screen must notice it is behind the daemon summary and refetch to
  // recover the missed tail instead of staying stuck on stale events. Recovery
  // is debounced (~800ms); the next cooled-down retry is ~4s out, so advancing
  // 1.5s fires exactly the first recovery refetch.
  await act(async () => {
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
  });

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  expect((requestStreamEvents as jest.Mock).mock.calls[1][2]).toEqual(expect.objectContaining({
    purpose: 'freshness-guard',
    entrySource: 'press-in',
  }));
  expect(telemetryEvents.find((event) => String(event.message) === 'chat.open.freshness_refetch')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      entry_source: 'press-in',
      summary_last_event_at: '2026-05-08T00:05:00Z',
      detail_latest_event_at: '2026-05-08T00:00:01Z',
    },
  });
});

test('history-recovery case: freshness refetch still runs while mount history is in flight', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  let resolveMountFetch: ((events: unknown[]) => void) | null = null;
  (requestStreamEvents as jest.Mock)
    .mockReturnValueOnce(new Promise((resolve) => {
      resolveMountFetch = resolve;
    }))
    .mockResolvedValueOnce([]);

  const rendered = render(<SessionScreen />);
  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  mockState = {
    ...mockState,
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: '2026-05-08T00:05:00Z',
      last_text: 'tmux line while mount history drains',
      last_kind: 'USER',
    }],
  };
  rendered.rerender(<SessionScreen />);

  await act(async () => {
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
  });

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  expect((requestStreamEvents as jest.Mock).mock.calls[1][2]).toEqual(expect.objectContaining({
    purpose: 'freshness-guard',
    entrySource: 'press-in',
  }));

  await act(async () => {
    resolveMountFetch?.([]);
    await Promise.resolve();
  });
});

test('history-recovery case: slow-consumer disconnect refetch renders the missed user row after reconnect', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const missedOperator = {
    daemon_seq: 8,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:08Z',
    kind: 'USER',
    text: 'user after slow consumer',
    raw: {
      source: 'terminal',
      working: true,
      working_label: 'Working 8s',
    },
  };
  (requestStreamEvents as jest.Mock)
    .mockResolvedValueOnce(mockState.events)
    .mockImplementationOnce(async () => {
      mockState = {
        ...mockState,
        events: [...mockState.events, missedOperator],
      };
      return [missedOperator];
    });
  const rendered = render(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  mockState = { ...mockState, connected: false };
  rendered.rerender(<SessionScreen />);
  mockState = {
    ...mockState,
    connected: true,
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: '2026-05-08T00:00:08Z',
      last_text: 'user after slow consumer',
      last_kind: 'USER',
      working: true,
      working_label: 'Working 8s',
    }],
  };
  rendered.rerender(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  await act(async () => {
    await Promise.resolve();
  });
  rendered.rerender(<SessionScreen />);

  await flushPendingWork();
  expect(screen.getByText('user after slow consumer')).toBeTruthy();
  expect(telemetryEvents.find((event) => String(event.message) === 'chat:history_backfill_rendered')).toMatchObject({
    data: {
      stream_id: 'hostc:codex:one',
      transcript_count: 3,
    },
  });
});

test('history-recovery case: an up-to-date summary does NOT trigger a recovery refetch (no storm while live events keep pace)', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const rendered = render(<SessionScreen />);

  await flushPendingWork();
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);

  // Summary advances, and the matching live event ALSO lands (no dropped frame):
  // state.events now ends at the same instant the summary reports, so the client
  // is not behind and must not refetch.
  mockState = {
    ...mockState,
    sessions: [{
      ...mockState.sessions[0],
      last_event_at: '2026-05-08T00:05:00Z',
      last_text: 'kept pace',
      last_kind: 'ASSIST',
    }],
    events: [
      ...mockState.events,
      {
        daemon_seq: 3,
        stream_id: 'hostc:codex:one',
        host: 'hostc',
        provider: 'codex',
        session_name: 'one',
        timestamp: '2026-05-08T00:05:00Z',
        kind: 'ASSIST',
        text: 'kept pace',
      },
    ],
  };
  rendered.rerender(<SessionScreen />);

  await act(async () => {
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
  });

  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
});

test('send-retry case: a failed send renders a Retry control wired to retryOptimisticSend', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const optimisticId = 'optimistic_hostc_codex_one_99';
  mockState = {
    ...mockState,
    optimisticSends: {
      [optimisticId]: {
        optimistic_id: optimisticId,
        stream_id: 'hostc:codex:one',
        text: 'failed message',
        status: 'failed',
        created_at: Date.parse('2026-05-08T00:00:02Z'),
        failure_reason: 'send_error',
      },
    },
    events: [
      ...mockState.events,
      {
        daemon_seq: 50,
        stream_id: 'hostc:codex:one',
        host: 'hostc',
        provider: 'codex',
        session_name: 'one',
        timestamp: '2026-05-08T00:00:02Z',
        kind: 'USER',
        text: 'failed message',
        client_origin: true,
        optimistic_id: optimisticId,
        pending: false,
      },
    ],
  };

  render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(250);
  });

  // The "failed sending" row shows a Retry affordance; tapping it re-arms + re-sends.
  await flushPendingWork();
  const retry = screen.getByTestId('user-send-retry');
  fireEvent.press(retry);
  expect(mockActions.retryOptimisticSend).toHaveBeenCalledWith(optimisticId);
});

