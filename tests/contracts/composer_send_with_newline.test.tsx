import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SessionScreen from '../../app/pentacle/session/[streamId]';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { useUserPreference } from '../../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';
import { runTrace, type TraceSetup, type UserStep, type DaemonStep } from './traces';
import { COMPOSER_SEND_WITH_NEWLINE } from './traces/composer_send_with_newline';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
let rendered: ReturnType<typeof render>;
let sequence = 1;

const STREAM_ID = 'hostc:codex:one';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_one_1';

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(() => OPTIMISTIC_ID),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});

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
  const mock = require('../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' })),
  sameStreamEventsLoadState: jest.fn((a, b) => a.currentGenerationComplete === b.currentGenerationComplete && a.fresh === b.fresh && a.requestStatus === b.requestStatus),
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
      workingState: state.workingStates?.[streamId],
      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
      sending: core.getSessionSendingState(state, streamId).sending,
      sendingImmediate: core.getSessionSendingState(state, streamId).immediate,
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => mockState),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    title: 'Composer newline',
    last_event_at: '2026-05-16T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: sequence++,
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_id: 'session',
    session_name: 'one',
    timestamp: '2026-05-16T12:00:00.000Z',
    kind: 'ASSIST',
    text: '',
    ...overrides,
  };
}

function resetState() {
  sequence = 1;
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
    optimisticSends: {},
    eventContentVersionByStream: {},
  };
}

async function rerenderScreen() {
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
}

function applyPendingTurn(text: string) {
  mockState = {
    ...mockState,
    sessions: [session({ pending: true, last_text: text, last_kind: 'USER' })],
    events: [
      ...mockState.events,
      event({
        daemon_seq: Number.NaN,
        kind: 'USER',
        text,
        client_origin: true,
        optimistic_id: OPTIMISTIC_ID,
        pending: true,
      }),
    ],
    workingByStream: {
      ...mockState.workingByStream,
      [STREAM_ID]: {
        phase: 'pending',
        optimisticId: OPTIMISTIC_ID,
        sentAt: Date.now(),
      },
    },
    optimisticSends: {
      ...mockState.optimisticSends,
      [OPTIMISTIC_ID]: {
        optimistic_id: OPTIMISTIC_ID,
        request_id: 'req_multiline',
        stream_id: STREAM_ID,
        text,
        status: 'dispatched',
        created_at: Date.now() - 1_000,
        dispatched_at: Date.now() - 500,
        window_started_at: Date.now() - 500,
        reconnect_count: 0,
      },
    },
  };
}

function applyDaemonStep(step: DaemonStep) {
  if (step.event === 'ASSIST') {
    mockState = {
      ...mockState,
      sessions: [session({ last_text: String((step.payload as { text?: unknown })?.text || ''), last_kind: 'ASSIST' })],
      events: [
        ...mockState.events,
        event({
          kind: 'ASSIST',
          text: String((step.payload as { text?: unknown })?.text || ''),
        }),
      ],
      workingByStream: {
        ...mockState.workingByStream,
        [STREAM_ID]: {
          ...mockState.workingByStream?.[STREAM_ID],
          phase: 'working',
          firstServerEventAt: Date.now(),
        },
      },
    };
    return;
  }

  if (step.event === 'SYSTEM') {
    mockState = {
      ...mockState,
      events: [
        ...mockState.events,
        event({
          kind: 'SYSTEM',
          text: 'Worked for 1s',
          raw: step.payload as Record<string, unknown>,
        }),
      ],
      workingByStream: {
        ...mockState.workingByStream,
        [STREAM_ID]: {
          ...mockState.workingByStream?.[STREAM_ID],
          phase: 'idle',
          endedAt: Date.now(),
          endReason: 'turn_summary',
        },
      },
    };
  }
}

function queryAssistText() {
  return mockState.events.find((item) => item.kind === 'ASSIST')?.text ?? null;
}

function makeTraceSetup(): TraceSetup {
  const start = Date.now();
  const observed = [] as {
    ts_observer_monotonic: number;
    source: 'user' | 'daemon' | 'reducer' | 'screen' | 'composer';
    name: string;
    payload?: unknown;
  }[];
  const listeners = new Set<(event: unknown) => void>();

  function emit(source: 'user' | 'daemon' | 'reducer' | 'screen' | 'composer', name: string, payload?: unknown) {
    const eventRecord = { ts_observer_monotonic: Date.now() - start, source, name, payload };
    observed.push(eventRecord);
    for (const listener of listeners) listener(eventRecord);
  }

  const setup: TraceSetup = {
    streamId: STREAM_ID,
    getState: () => mockState,
    monotonic: () => Date.now() - start,
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
    observers: {
      reducer: {
        snapshot: () => mockState,
        getTurn: (streamId) => {
          const turn = mockState.workingByStream?.[streamId];
          return turn
            ? ({ streamId, ...turn, firstServerEventAt: turn.firstServerEventAt ?? null } as any)
            : { streamId, phase: 'idle', firstServerEventAt: null };
        },
        subscribeToTurn: () => () => undefined,
      },
      screen: {
        isMountedByTestID: (testID) => {
          if (testID === 'working-dock') return screen.queryByTestId('working-dock') != null;
          return screen.queryByTestId(testID) != null;
        },
        findByTestID: (testID) => {
          const node = screen.queryByTestId(testID);
          return node ? { testID } : null;
        },
        queryTextByTestID: (testID) => {
          if (testID === 'assist-row') return queryAssistText();
          return null;
        },
        wasMountedAtAnyPointByTestID: (testID) => {
          if (testID === 'working-dock') return screen.queryByTestId('working-dock') != null;
          return screen.queryByTestId(testID) != null;
        },
      },
      composer: {
        isSendButtonDisabled: () => Boolean(screen.getByTestId('composer-send-button').props.accessibilityState?.disabled),
        composerText: () => String(screen.getByTestId('composer-input').props.value || ''),
      },
    },
    driveUserAction: async (step: UserStep) => {
      if (step.action === 'composer_change_text') {
        fireEvent.changeText(screen.getByTestId('composer-input'), (step.payload as { text: string }).text);
      } else if (step.action === 'composer_submit_editing') {
        fireEvent(screen.getByTestId('composer-input'), 'submitEditing');
        if (mockActions.sendMessage.mock.calls.length || mockActions.sendTurn.mock.calls.length) {
          emit('user', 'actions.sendMessage');
        }
      } else if (step.action === 'composer_press_send') {
        await act(async () => {
          fireEvent.press(screen.getByTestId('composer-send-button'));
        });
        applyPendingTurn((step.payload as { text?: string } | undefined)?.text || 'line one\nline two');
        await rerenderScreen();
      } else if (step.action === 'actions.sendMessage') {
        await waitFor(() => expect(mockActions.sendTurn).toHaveBeenCalledTimes(1));
        expect(mockActions.sendTurn).toHaveBeenCalledWith(STREAM_ID, 'line one\nline two');
        await waitFor(() => expect(mockActions.sendMessage).toHaveBeenCalledTimes(1));
        expect(mockActions.sendMessage).toHaveBeenCalledWith({
          host: 'hostc',
          sessionName: 'one',
          text: 'line one\nline two',
        });
        emit('reducer', 'append_optimistic_user');
        emit('screen', 'sending_status_mounts');
        emit('composer', 'send_button_disabled');
      }
      emit('user', step.action, step.payload);
    },
    injectDaemonEvent: async (step: DaemonStep) => {
      applyDaemonStep(step);
      await rerenderScreen();
      emit('daemon', step.event, step.payload);
      if (step.event === 'ASSIST') {
        emit('screen', 'assist_row_renders');
      } else if (step.event === 'SYSTEM') {
        emit('reducer', 'phase_returns_to_idle');
      }
    },
  };

  Object.defineProperty(setup, '__eventListeners', {
    value: listeners,
    enumerable: false,
  });
  Object.defineProperty(setup, '__eventLog', {
    value: observed,
    enumerable: false,
  });

  return setup;
}

beforeEach(() => {
  resetState();
  jest.clearAllMocks();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.sendTurn.mockReturnValue(OPTIMISTIC_ID);
  mockActions.appendOptimisticUserMessage.mockReturnValue(OPTIMISTIC_ID);
  rendered = render(<SessionScreen />);
});

test('trace: multiline return does not submit; send button submits exactly once', async () => {
  const result = await runTrace(COMPOSER_SEND_WITH_NEWLINE, makeTraceSetup());

  if (!result.ok) {
    throw new Error(result.failureReport);
  }
  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
});
