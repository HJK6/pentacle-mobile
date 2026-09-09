import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../../app/pentacle/session/[streamId]';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { useUserPreference } from '../../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { runTrace, type DaemonStep, type TraceSetup, type UserStep } from './traces';
import { CODEX_SINGLE_DIVIDER_PER_TURN } from './traces/codex_single_divider_per_turn';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
let rendered: ReturnType<typeof render>;
let sequence = 1;

const STREAM_ID = 'hostc:codex:one';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_one_1';

const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: mockKeyboardAddListener };
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
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
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
    title: 'Divider count',
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
    timestamp: `2026-05-16T12:00:0${sequence}.000Z`,
    kind: 'SYSTEM',
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
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
    eventContentVersionByStream: {},
  };
}

async function rerenderScreen() {
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
}

function applyUserSend(text: string) {
  mockState = {
    ...mockState,
    sessions: [session({ pending: true, last_text: text, last_kind: 'USER' })],
    workingByStream: {
      ...mockState.workingByStream,
      [STREAM_ID]: {
        phase: 'pending',
        optimisticId: OPTIMISTIC_ID,
        sentAt: Date.now(),
      },
    },
  };
}

function applyDaemonStep(step: DaemonStep) {
  if (step.event === 'USER') {
    const text = String((step.payload as { text?: unknown })?.text || '');
    mockState = {
      ...mockState,
      sessions: [session({ pending: true, last_text: text, last_kind: 'USER' })],
      events: [
        ...mockState.events,
        event({ kind: 'USER', text, timestamp: '2026-05-16T12:00:00.000Z' }),
      ],
    };
    return;
  }

  if (step.event === 'SYSTEM') {
    const payload = step.payload as { text?: string; subtype?: string; source?: string; durationMs?: number };
    const isTurnEnd = payload.subtype === 'turn_duration';
    mockState = {
      ...mockState,
      sessions: [session({ last_text: payload.text || '', last_kind: 'SYSTEM' })],
      events: [
        ...mockState.events,
        event({
          kind: 'SYSTEM',
          text: payload.text || '',
          raw: {
            source: payload.source,
            subtype: payload.subtype,
            durationMs: payload.durationMs,
          },
        }),
      ],
      workingByStream: {
        ...mockState.workingByStream,
        [STREAM_ID]: {
          ...mockState.workingByStream?.[STREAM_ID],
          phase: isTurnEnd ? 'idle' : mockState.workingByStream?.[STREAM_ID]?.phase ?? 'pending',
          endReason: isTurnEnd ? 'terminal_divider' : undefined,
        },
      },
    };
  }
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
          if (testID === 'divider-row') return screen.queryAllByTestId('terminal-divider-row').length > 0;
          return screen.queryByTestId(testID) != null;
        },
        findByTestID: (testID) => {
          const node = screen.queryByTestId(testID);
          return node ? { testID } : null;
        },
        queryTextByTestID: () => null,
        wasMountedAtAnyPointByTestID: (testID) => {
          if (testID === 'divider-row') return screen.queryAllByTestId('terminal-divider-row').length > 0;
          return screen.queryByTestId(testID) != null;
        },
      },
      composer: {
        isSendButtonDisabled: () => Boolean(screen.getByTestId('composer-send-button').props.accessibilityState?.disabled),
        composerText: () => String(screen.getByTestId('composer-input').props.value || ''),
      },
    },
    driveUserAction: async (step: UserStep) => {
      if (step.action === 'composer_press_send') {
        const text = (step.payload as { text?: string } | undefined)?.text || 'hello from codex';
        fireEvent.changeText(screen.getByTestId('composer-input'), text);
        await act(async () => {
          fireEvent.press(screen.getByTestId('composer-send-button'));
        });
        applyUserSend(text);
        await rerenderScreen();
      }
      emit('user', step.action, step.payload);
    },
    injectDaemonEvent: async (step: DaemonStep) => {
      applyDaemonStep(step);
      await rerenderScreen();
      emit('daemon', step.event, step.payload);
      if (step.event === 'USER') {
        emit('reducer', 'turn_pending');
      } else if ((step.payload as { subtype?: string } | undefined)?.subtype === 'terminal-divider') {
        emit('screen', 'divider_row_absent');
      } else if ((step.payload as { subtype?: string } | undefined)?.subtype === 'turn_duration') {
        emit('screen', 'divider_row_count_is_zero');
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
  (useUserPreference as jest.Mock).mockReturnValue([true, jest.fn()]);
  mockActions.sendTurn.mockReturnValue(OPTIMISTIC_ID);
  mockActions.sendMessage.mockResolvedValue(true);
  rendered = render(<SessionScreen />);
});

test('trace: codex divider-shaped furniture never mounts between user bubbles', async () => {
  const result = await runTrace(CODEX_SINGLE_DIVIDER_PER_TURN, makeTraceSetup());

  if (!result.ok) {
    throw new Error(result.failureReport);
  }
  expect(screen.queryAllByTestId('terminal-divider-row')).toHaveLength(0);
  expect(screen.queryByText('Worked for 1s')).toBeNull();
  expect(screen.queryByText('Worked for 2s')).toBeNull();
  expect(screen.queryByText('Worked for 3s')).toBeNull();
});
