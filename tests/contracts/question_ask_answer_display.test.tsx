import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import SessionScreen from '../../app/pentacle/session/[streamId]';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { useUserPreference } from '../../src/services/userPreferences';
import { INITIAL_PENTACLE_LIMITS, buildPentacleQuestionAnswerText, type PentacleEvent, type PentacleNotification, type PentacleQuestion, type PentacleSessionSummary, type PentacleStreamState } from 'pentacle-chat-core';
import { runTrace, type DaemonStep, type TraceSetup, type UserStep } from './traces';
import { DURABLE_QUESTION_NOTIFICATION_DISPLAY, QUESTION_ASK_ANSWER_DISPLAY } from './traces/question_ask_answer_display';

const STREAM_ID = 'hostc:claude:question-flow';
const QUESTION_KEY = 'question-key';
const ANSWER_OPTIMISTIC_ID = 'question-answer-echo-1';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
let mockState: PentacleStreamState;
let rendered: ReturnType<typeof render>;
let sequence = 1;
let submittedAnswerText = '';

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  beginOptimisticQuestionAnswer: jest.fn(() => ANSWER_OPTIMISTIC_ID),
  queueOptimisticQuestionAnswer: jest.fn(),
  discardOptimisticQuestionAnswer: jest.fn(),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  dismissQuestion: jest.fn(),
  resolveNotification: jest.fn(),
  answerPrompt: jest.fn(),
};
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: mockKeyboardAddListener };
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
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

const PUBLIC_QUESTION_PREVIEW_PAYLOAD = {
  header: 'Choose an option',
  prompt: 'Which option should be used?',
  multiSelect: false,
  allow_custom: true,
  options: [
    {
      index: 1,
      label: 'Use option A',
      description: 'Select the first synthetic option.',
      preview: 'Option A selected.',
    },
    {
      index: 2,
      label: 'Use option B',
      description: 'Select the second synthetic option.',
      preview: 'Option B selected.',
    },
    {
      index: 3,
      label: 'Decide later',
      description: 'Leave the choice open for a later response.',
      preview: 'No option selected.',
    },
  ],
} as unknown as PentacleQuestion;

function questionWithKey(): PentacleQuestion {
  return {
    ...(PUBLIC_QUESTION_PREVIEW_PAYLOAD as PentacleQuestion),
    question_key: QUESTION_KEY,
    allow_custom: true,
  } as PentacleQuestion;
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'question-flow',
    title: 'Question flow',
    last_event_at: '2026-07-02T03:00:00.000Z',
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
    provider: 'claude',
    session_id: 'session',
    session_name: 'question-flow',
    timestamp: `2026-07-02T03:00:${String(sequence).padStart(2, '0')}.000Z`,
    kind: 'USER',
    text: '',
    ...overrides,
  };
}

function resetState() {
  sequence = 1;
  submittedAnswerText = '';
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
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

function applyQuestionSummary() {
  mockState = {
    ...mockState,
    sessions: [
      session({
        question: questionWithKey(),
        last_kind: 'WORKING',
        last_text: 'Waiting for your answer',
        working: true,
      }),
    ],
  };
}

function durableQuestionNotification(): PentacleNotification {
  return {
    notification_id: 'durable-question-1',
    created_at: '2026-07-02T03:00:00.000Z',
    updated_at: '2026-07-02T03:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: STREAM_ID,
    severity: 'info',
    title: 'Choose an option',
    body: 'Which option should be used?',
    dedup_key: 'question:durable:1',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'legacy-1' }],
    question: {
      question_id: 'durable-q1',
      producer_stream_id: STREAM_ID,
      response_mode: 'single_choice',
      options: [
        { label: 'Lane A', value: 'option_a' },
        { label: 'Lane B', value: 'option_b' },
      ],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-07-02T04:00:00.000Z',
    resolved_at: null,
  };
}

function applyQuestionNotification() {
  mockState = {
    ...mockState,
    notifications: [durableQuestionNotification()],
  };
}

function applyCommittedAnswerEcho() {
  const text = submittedAnswerText || buildPentacleQuestionAnswerText({
    question: questionWithKey(),
    answers: [{ selectedOptionIndex: 2, note: 'Use option B.' }],
  });
  mockState = {
    ...mockState,
    sessions: [
      session({
        last_kind: 'USER',
        last_text: text,
        working: false,
      }),
    ],
    events: [
      ...mockState.events,
      event({
        kind: 'USER',
        text,
        client_origin: true,
        optimistic_id: ANSWER_OPTIMISTIC_ID,
      }),
    ],
    eventContentVersionByStream: {
      ...mockState.eventContentVersionByStream,
      [STREAM_ID]: (mockState.eventContentVersionByStream?.[STREAM_ID] ?? 0) + 1,
    },
  };
}

function textNodeValue(node: { props?: { children?: unknown } } | null): string | null {
  if (!node) return null;
  const children = node.props?.children;
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : '')).join('');
  }
  return null;
}

function openQuestionOverlayIfPresent() {
  const fab = screen.queryByTestId('question-fab');
  if (fab) fireEvent.press(fab);
}

function makeTraceSetup(): TraceSetup {
  const start = Date.now();
  const listeners = new Set<(event: unknown) => void>();

  function emit(source: 'user' | 'daemon' | 'reducer' | 'screen' | 'composer', name: string, payload?: unknown) {
    const eventRecord = { ts_observer_monotonic: Date.now() - start, source, name, payload };
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
        getTurn: (streamId) => ({ streamId, phase: 'idle', firstServerEventAt: null }),
        subscribeToTurn: () => () => undefined,
      },
      screen: {
        isMountedByTestID: (testID) => {
          if (testID === 'question-preview-separated-from-options') {
            const firstOption = screen.queryByTestId('question-option-1');
            const secondOption = screen.queryByTestId('question-option-2');
            const thirdOption = screen.queryByTestId('question-option-3');
            return Boolean(
              screen.queryByTestId('question-option-preview-text-0') &&
              firstOption &&
              secondOption &&
              thirdOption &&
              !within(firstOption).queryByText(/TOTAL\s+80h/) &&
              !within(secondOption).queryByText(/TOTAL\s+88h/) &&
              !within(thirdOption).queryByText(/Saved, NOT submitted/),
            );
          }
          if (testID === 'answer-grammar-hidden') {
            return Boolean(
              screen.queryByTestId('answer-bubble') &&
              !screen.queryByText(/Answering your question/) &&
              !screen.queryByText(/Q1 \(/),
            );
          }
          return screen.queryByTestId(testID) != null;
        },
        findByTestID: (testID) => {
          const node = screen.queryByTestId(testID);
          return node ? { testID } : null;
        },
        queryTextByTestID: (testID) => textNodeValue(screen.queryByTestId(testID)),
        wasMountedAtAnyPointByTestID: (testID) => screen.queryByTestId(testID) != null,
      },
      composer: {
        isSendButtonDisabled: () => Boolean(screen.queryByTestId('composer-send-button')?.props.accessibilityState?.disabled),
        composerText: () => String(screen.queryByTestId('composer-input')?.props.value || ''),
      },
    },
    driveUserAction: async (step: UserStep) => {
      if (step.action === 'question_select_option') {
        const optionIndex = (step.payload as { optionIndex?: number } | undefined)?.optionIndex ?? 2;
        await act(async () => {
          fireEvent.press(screen.getByTestId(`question-option-${optionIndex}`));
        });
        emit('screen', 'question_preview_block_renders');
        emit('screen', 'question_preview_stays_out_of_option_rows');
      } else if (step.action === 'question_enter_note') {
        const text = (step.payload as { text?: string } | undefined)?.text ?? '';
        fireEvent.changeText(screen.getByTestId('question-note-0'), text);
      } else if (step.action === 'question_submit') {
        await act(async () => {
          fireEvent.press(screen.getByTestId('question-submit'));
        });
        await waitFor(() => expect(mockActions.dismissQuestion).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mockActions.sendMessage).toHaveBeenCalledTimes(1));
        submittedAnswerText = mockActions.sendMessage.mock.calls[0][0].text;
        emit('user', 'actions.dismissQuestion', mockActions.dismissQuestion.mock.calls[0][0]);
        await rerenderScreen();
        emit('screen', 'question_card_dismissed');
      } else if (step.action === 'durable_question_select_option') {
        const optionIndex = (step.payload as { optionIndex?: number } | undefined)?.optionIndex ?? 2;
        await act(async () => {
          fireEvent.press(screen.getByTestId(`question-option-${optionIndex}`));
        });
        emit('screen', 'bare_tap_does_not_resolve');
      } else if (step.action === 'durable_question_enter_note') {
        const text = (step.payload as { text?: string } | undefined)?.text ?? '';
        fireEvent.changeText(screen.getByTestId('question-note-0'), text);
      } else if (step.action === 'durable_question_submit') {
        await act(async () => {
          fireEvent.press(screen.getByTestId('question-submit'));
        });
        await waitFor(() => expect(mockActions.answerPrompt).toHaveBeenCalledTimes(1));
        emit('user', 'actions.answerPrompt', mockActions.answerPrompt.mock.calls[0][0]);
        emit('screen', 'durable_question_resolved');
      }
      emit('user', step.action, step.payload);
    },
    injectDaemonEvent: async (step: DaemonStep) => {
      if (step.event === 'QUESTION_SUMMARY') {
        applyQuestionSummary();
        await rerenderScreen();
        openQuestionOverlayIfPresent();
        emit('screen', 'question_card_renders');
        emit('screen', 'question_preview_not_interleaved');
      } else if (step.event === 'QUESTION_NOTIFICATION') {
        applyQuestionNotification();
        await rerenderScreen();
        openQuestionOverlayIfPresent();
        emit('screen', 'question_card_renders');
      } else if (step.event === 'USER') {
        applyCommittedAnswerEcho();
        await rerenderScreen();
        emit('reducer', 'committed_user_echo');
        emit('screen', 'structured_answer_bubble_renders');
        emit('screen', 'raw_answer_grammar_hidden');
      }
      emit('daemon', step.event, step.payload);
    },
  };

  Object.defineProperty(setup, '__eventListeners', {
    value: listeners,
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
  mockActions.dismissQuestion.mockResolvedValue({ dismissed: true, textSubmitted: true });
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.resolveNotification.mockResolvedValue(true);
  mockActions.answerPrompt.mockResolvedValue(true);
  rendered = render(<SessionScreen />);
});

afterEach(() => {
  rendered?.unmount();
});

test('question overlay uses the mock body, FAB, and single disabled submit affordance', () => {
  applyQuestionSummary();
  rendered = render(<SessionScreen />);
  const fab = StyleSheet.flatten(screen.getByTestId('question-fab').props.style);
  const badge = StyleSheet.flatten(screen.getByTestId('question-fab-count').props.style);
  openQuestionOverlayIfPresent();

  const prompt = StyleSheet.flatten(screen.getByTestId('question-prompt').props.style);
  expect(prompt.textTransform).toBeUndefined();
  expect(prompt.fontSize).toBe(21);
  expect(screen.getByTestId('question-custom-toggle')).toHaveTextContent('Custom');
  expect(screen.getByTestId('question-overlay-cancel').props.accessibilityLabel).toBe('Close questions');
  expect(screen.getByTestId('question-option-1').props.accessibilityState.checked).toBe(false);
  expect(fab.backgroundColor).toBe(badge.borderColor);
  expect(badge.backgroundColor).toBe('#080b0a');
  expect(screen.queryByTestId('question-warning')).toBeNull();
  expect(screen.getByTestId('question-submit')).toHaveTextContent('1 unanswered');
  expect(screen.getByTestId('question-keyboard-avoiding')).toBeTruthy();
  expect(screen.getByTestId('question-overlay-scroll').props.keyboardShouldPersistTaps).toBe('handled');
});

test('trace: pending question submits and committed echo renders as a structured answer bubble', async () => {
  const result = await runTrace(QUESTION_ASK_ANSWER_DISPLAY, makeTraceSetup());

  if (!result.ok) {
    throw new Error(result.failureReport);
  }
  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'question-flow',
    questionKey: QUESTION_KEY,
  });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'question-flow',
    text: buildPentacleQuestionAnswerText({
      question: questionWithKey(),
      answers: [{ selectedOptionIndex: 2, note: 'Use option B.' }],
    }),
    optimisticId: ANSWER_OPTIMISTIC_ID,
  });
  expect(screen.getByTestId('answer-bubble')).toBeTruthy();
  expect(screen.getByText('Choose an option')).toBeTruthy();
  expect(screen.getByText('Use option B')).toBeTruthy();
  expect(screen.getByText('Use option B.')).toBeTruthy();
});

test('trace: durable question notification submits through prompt.answer', async () => {
  const result = await runTrace(DURABLE_QUESTION_NOTIFICATION_DISPLAY, makeTraceSetup());

  if (!result.ok) {
    throw new Error(result.failureReport);
  }
  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'durable-q1',
    selections: ['option_b'],
    text: 'Use option B.',
  });
  expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
});
