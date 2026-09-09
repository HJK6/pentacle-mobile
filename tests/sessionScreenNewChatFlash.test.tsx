import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

import { INITIAL_PENTACLE_LIMITS, setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import usePentacleToken from '../src/hooks/usePentacleToken';
import {
  requestStreamEvents,
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
} from '../src/services/pentacleStream';

const STREAM_A = 'hostc:codex:flash-old';
const STREAM_B = 'hostc:codex:flash-new';
const OLD_MARKER = 'M2_OLD_CHAT_FLASH_MARKER_ALPHA';
const NEW_MARKER = 'M2_NEW_CHAT_FLASH_MARKER_BRAVO';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_A) };
let mockState: any;
const telemetryEvents: TelemetryPayload[] = [];
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(),
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
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn((_state, streamId) => {
    const covered = streamId === STREAM_A;
    return { currentGenerationComplete: covered, fresh: covered, requestStatus: covered ? 'ready' : 'idle' };
  }),
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
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'press-in'),
}));

function session(streamId: string, title: string, lastText: string) {
  const [, host, provider, sessionName] = streamId.match(/^([^:]+):([^:]+):(.+)$/) || [];
  return {
    stream_id: streamId,
    host: host || 'hostc',
    provider: provider || 'codex',
    session_name: sessionName || title,
    title,
    last_event_at: '2026-05-27T00:00:00Z',
    last_text: lastText,
    last_kind: 'USER',
    online: true,
  };
}

function userEvent(streamId: string, daemonSeq: number, text: string) {
  const [, host, provider, sessionName] = streamId.match(/^([^:]+):([^:]+):(.+)$/) || [];
  return {
    daemon_seq: daemonSeq,
    stream_id: streamId,
    host: host || 'hostc',
    provider: provider || 'codex',
    session_name: sessionName || 'session',
    timestamp: '2026-05-27T00:00:00Z',
    kind: 'USER',
    text,
  };
}

function buildState(activeStreamId: string) {
  const activeMarker = activeStreamId === STREAM_A ? OLD_MARKER : NEW_MARKER;
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [
      session(STREAM_A, 'Old chat', OLD_MARKER),
      session(STREAM_B, 'New chat', NEW_MARKER),
    ],
    drafts: {},
    events: [
      userEvent(activeStreamId, activeStreamId === STREAM_A ? 101 : 201, activeMarker),
    ],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    workingStates: {},
    workingByStream: {},
  };
}

function rowEventsAfter(index: number) {
  return telemetryEvents.slice(index).filter((event) => event.message === 'harness:row_rendered');
}

// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../app/pentacle/session/[streamId]'));

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_HARNESS = '1';
  telemetryEvents.length = 0;
  mockParams = { streamId: encodeURIComponent(STREAM_A) };
  mockState = buildState(STREAM_A);
  jest.clearAllMocks();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  setTelemetrySink((payload) => telemetryEvents.push(payload));

  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=batch3_new_chat_flash&scenario_run_id=jest-m2-flash');
});

afterEach(() => {
  setTelemetrySink(null);
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});

test('switching a mounted session screen does not render old chat rows into the new chat screen', async () => {
  const SessionScreen = require('../app/pentacle/session/[streamId]').default;
  const rendered = render(<SessionScreen />);

  act(() => {
    jest.advanceTimersByTime(250);
  });
  expect(screen.getByText(OLD_MARKER)).toBeTruthy();

  const switchStart = telemetryEvents.length;
  mockParams = { streamId: encodeURIComponent(STREAM_B) };
  mockState = buildState(STREAM_B);

  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });

  const firstCommitRows = rowEventsAfter(switchStart);
  expect(firstCommitRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          stream_id: STREAM_B,
          text_prefix: NEW_MARKER,
          lifecycle: 'mount',
        }),
      }),
    ]),
  );
  expect(firstCommitRows).toEqual(
    expect.not.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          text_prefix: OLD_MARKER,
          lifecycle: 'mount',
        }),
      }),
    ]),
  );

  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(screen.queryByText(OLD_MARKER)).toBeNull();
  expect(screen.getByText(NEW_MARKER)).toBeTruthy();
  expect(rowEventsAfter(switchStart)).toEqual(
    expect.not.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          text_prefix: OLD_MARKER,
          lifecycle: 'mount',
        }),
      }),
    ]),
  );
  expect(requestStreamEvents).toHaveBeenCalledWith(
    STREAM_B,
    expect.any(Number),
    expect.objectContaining({ purpose: 'mount-fetch' }),
  );
});

