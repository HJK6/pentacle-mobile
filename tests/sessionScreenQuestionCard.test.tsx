// Agent-question card regression tests. When a session summary carries a
// pending `question` (claude AskUserQuestion selector, parsed by the daemon and
// carried on the summary by pentacle-chat-core), the session screen renders a
// `question-card`. Single questions keep the immediate option-tap path; multi
// questions render a stacked sparse-submit UI.
// Spec: agent_question_parsing_contract

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import SessionScreen, { SESSION_QUESTION_SUBMISSION_TIMEOUT_MS } from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import { MOBILE_TELEMETRY_EVENTS } from '../src/services/mobileTelemetryEvents';
import { buildPentacleQuestionAnswerText, setTelemetrySink, TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type {
  PentacleEvent,
  PentacleQuestion,
  PentacleNotification,
  PentacleSessionSummary,
  PentacleStreamState,
  TelemetryPayload,
} from 'pentacle-chat-core';
import { UNANET_QUESTION_PREVIEW_PAYLOAD } from './fixtures/unanetQuestionPreviewPayload';

const CLAUDE_STREAM_ID = 'hostc:claude:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(CLAUDE_STREAM_ID) };
let mockState: PentacleStreamState;
let mockShowToolActions = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_test_1'),
  beginOptimisticQuestionAnswer: jest.fn(() => 'optimistic_question_1'),
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
const mockKeyboardDismiss = jest.fn();
const mockKeyboardListeners = new Map<string, (event: { endCoordinates: { height: number } }) => void>();
const mockKeyboardAddListener = jest.fn((eventName: string, callback: (event: { endCoordinates: { height: number } }) => void) => {
  mockKeyboardListeners.set(eventName, callback);
  return { remove: jest.fn(() => mockKeyboardListeners.delete(eventName)) };
});
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
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  selectOptimisticQuestionAnswerIdentities: jest.fn((state) => Object.values(state.optimisticSends ?? {}).flatMap((send: any) => {
    try {
      const payload = JSON.parse(send.text);
      return payload.type === 'notification.answer' && payload.notification_id
        ? [{ notificationId: payload.notification_id, ...(payload.question_id ? { questionId: payload.question_id } : {}) }]
        : [];
    } catch {
      return [];
    }
  })),
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
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

const QUESTION: PentacleQuestion = {
  header: 'Pick',
  prompt: 'Pick a number.',
  options: [
    { index: 1, label: '1', description: 'The number one.', meta: false },
    { index: 2, label: '2', description: 'The number two.', meta: false },
    { index: 3, label: 'Type something.', description: '', meta: true },
    { index: 4, label: 'Chat about this', description: '', meta: true },
  ],
};

const MULTI_QUESTION: PentacleQuestion = {
  header: 'Plan',
  prompt: 'Answer the setup questions.',
  options: [],
  multi: true,
  active_index: 0,
  submit_present: true,
  questions: [
    {
      index: 0,
      header: 'First',
      prompt: 'Pick a priority.',
      options: [
        { index: 1, label: 'Low', description: 'Wait.', meta: false },
        { index: 2, label: 'High', description: 'Do it now.', meta: false },
      ],
    },
    {
      index: 1,
      header: 'Second',
      prompt: 'Add context.',
      options: [
        { index: 1, label: 'No context', description: '', meta: false },
      ],
      free_text: true,
    },
  ],
};

const DEDUPED_MULTI_QUESTION = {
  ...MULTI_QUESTION,
  questions: [
    {
      id: 'hosts',
      index: 0,
      header: 'Hosts',
      prompt: 'Pick hosts.',
      options: [
        { index: 1, label: 'hostc', description: 'Mobile.', meta: false },
      ],
    },
    {
      id: 'hosts',
      index: 0,
      header: 'Hosts duplicate',
      prompt: 'Pick hosts again.',
      options: [
        { index: 1, label: 'hostc', description: 'Mobile.', meta: false },
      ],
    },
  ],
} as unknown as PentacleQuestion;

const BOUNDED_MULTI_SELECT_QUESTION = {
  header: 'Hosts',
  prompt: 'Pick hosts.',
  options: [],
  multi: true,
  active_index: 0,
  submit_present: true,
  questions: [
    {
      index: 0,
      header: 'Hosts',
      prompt: 'Pick two hosts.',
      multiSelect: true,
      allow_custom: true,
      minSelections: 2,
      maxSelections: 2,
      options: [
        { index: 1, label: 'hosta', description: '', meta: false },
        { index: 2, label: 'hostc', description: '', meta: false },
        { index: 3, label: 'hostb', description: '', meta: false },
      ],
    },
  ],
} as unknown as PentacleQuestion;

const SCAN_MULTI_QUESTION: PentacleQuestion = {
  ...MULTI_QUESTION,
  active_index: 1,
  scan_incomplete: true,
  questions: [
    {
      index: 0,
      header: 'First',
      prompt: 'Pick a priority.',
      options: [
        { index: 1, label: 'Low', description: 'Wait.', meta: false },
      ],
      free_text: true,
    },
    {
      index: 1,
      header: 'Second',
      prompt: 'Add context.',
      options: [
        { index: 1, label: 'No context', description: '', meta: false },
      ],
      free_text: true,
    },
  ],
};

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const [host, provider, name] = streamId.split(':');
  const question = overrides.question
    ? ({ ...overrides.question, question_key: `question-key-${streamId}` } as PentacleQuestion)
    : overrides.question;
  return {
    stream_id: streamId,
    host,
    provider,
    session_name: name,
    title: 'Test chat',
    last_event_at: '2026-05-13T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
    question,
  };
}

function resetState(streamId: string = CLAUDE_STREAM_ID, sessionOverrides: Partial<PentacleSessionSummary> = {}) {
  mockParams = { streamId: encodeURIComponent(streamId) };
  mockShowToolActions = false;
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    hosts: {},
    sessions: [session(streamId, sessionOverrides)],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
  };
}

function durableQuestionNotification(notificationId: string): PentacleNotification {
  return {
    notification_id: notificationId,
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: CLAUDE_STREAM_ID,
    severity: 'info',
    title: 'Pick a lane',
    body: 'Which lane should run?',
    dedup_key: `question:${notificationId}`,
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    question: {
      question_id: `question-${notificationId}`,
      producer_stream_id: CLAUDE_STREAM_ID,
      response_mode: 'single_choice',
      options: [{ label: 'Lane A', value: 'lane_a' }],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
  } as PentacleNotification;
}

function renderQuestionScreen() {
  const view = render(<SessionScreen />);
  const fab = screen.queryByTestId('question-fab');
  if (fab) fireEvent.press(fab);
  return view;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  resetState();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [mockShowToolActions, jest.fn()]);
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.dismissQuestion.mockResolvedValue({ dismissed: true, textSubmitted: true });
  mockActions.resolveNotification.mockResolvedValue(true);
  mockActions.answerPrompt.mockResolvedValue(true);
  mockKeyboardListeners.clear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  setTelemetrySink(null);
});

test('renders no question card when the session has no pending question', () => {
  renderQuestionScreen();
  expect(screen.queryByTestId('question-card')).toBeNull();
});

test('renders the question card with one tappable row per non-meta option', () => {
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  renderQuestionScreen();

  expect(screen.getByTestId('question-card')).toBeTruthy();
  expect(screen.getByText('Pick a number.')).toBeTruthy();
  // Non-meta options 1 and 2 render; meta options 3 and 4 are hidden.
  expect(screen.getByTestId('question-option-1')).toBeTruthy();
  expect(screen.getByTestId('question-option-2')).toBeTruthy();
  expect(screen.queryByTestId('question-option-3')).toBeNull();
  expect(screen.queryByTestId('question-option-4')).toBeNull();
});

test('renders AskUserQuestion preview as a separate selected-option block', () => {
  resetState(CLAUDE_STREAM_ID, { question: UNANET_QUESTION_PREVIEW_PAYLOAD });
  renderQuestionScreen();

  const firstOption = screen.getByTestId('question-option-1');
  const secondOption = screen.getByTestId('question-option-2');
  const thirdOption = screen.getByTestId('question-option-3');
  expect(screen.queryByTestId('question-option-preview-0')).toBeNull();
  expect(within(firstOption).queryByText(/TOTAL\s+80h/)).toBeNull();
  expect(within(secondOption).queryByText(/TOTAL\s+88h/)).toBeNull();
  expect(within(thirdOption).queryByText(/Saved, NOT submitted/)).toBeNull();

  fireEvent.press(firstOption);

  expect(screen.getByTestId('question-option-preview-text-0')).toHaveTextContent(/TOTAL\s+80h/);
  expect(within(firstOption).queryByText(/TOTAL\s+80h/)).toBeNull();

  fireEvent.press(secondOption);

  expect(screen.getByTestId('question-option-preview-text-0')).toHaveTextContent(/TOTAL\s+88h/);
  expect(within(secondOption).queryByText(/TOTAL\s+88h/)).toBeNull();
  expect(within(thirdOption).queryByText(/Saved, NOT submitted/)).toBeNull();
});

test('does not render an empty AskUserQuestion preview frame', () => {
  const questionWithEmptyPreview = {
    ...UNANET_QUESTION_PREVIEW_PAYLOAD,
    options: [
      {
        ...UNANET_QUESTION_PREVIEW_PAYLOAD.options[0],
        preview: '   ',
      },
    ],
  } as unknown as PentacleQuestion;

  resetState(CLAUDE_STREAM_ID, { question: questionWithEmptyPreview });
  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-option-1'));

  expect(screen.queryByTestId('question-option-preview-0')).toBeNull();
});

test('selecting an option reveals notes and submit answers with that 1-based option index + the session host/name', async () => {
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  renderQuestionScreen();

  expect(screen.queryByTestId('question-note-0')).toBeNull();
  expect(screen.queryByTestId('question-freetext-0')).toBeNull();
  expect(screen.getByTestId('question-cancel')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-option-2'));
  });
  expect(screen.getByTestId('question-note-0')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const expectedText = buildPentacleQuestionAnswerText({
    question: QUESTION,
    answers: [{ selectedOptionIndex: 2 }],
  });
  expect(mockActions.dismissQuestion).toHaveBeenCalledTimes(1);
  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    questionKey: `question-key-${CLAUDE_STREAM_ID}`,
  });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: expectedText,
    optimisticId: 'optimistic_question_1',
  });
});

test('legacy question answer renders immediately and yields to its authoritative transcript echo', async () => {
  const dispatch = deferred<{ dismissed: boolean; textSubmitted: boolean }>();
  mockActions.dismissQuestion.mockReturnValue(dispatch.promise);
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  const view = renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-option-2'));
  act(() => fireEvent.press(screen.getByTestId('question-submit')));

  const expectedText = buildPentacleQuestionAnswerText({
    question: QUESTION,
    answers: [{ selectedOptionIndex: 2 }],
  });
  expect(screen.getByTestId(`message-bubble-session-question-answer-pane:${CLAUDE_STREAM_ID}`)).toBeTruthy();

  mockState.sessions = [{ ...mockState.sessions[0], question: undefined }];
  mockState.events = [{
    daemon_seq: 1,
    stream_id: CLAUDE_STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    timestamp: '2026-05-13T12:00:01.000Z',
    kind: 'USER',
    text: expectedText,
  } as PentacleEvent];
  await act(async () => {
    dispatch.resolve({ dismissed: true, textSubmitted: true });
    await dispatch.promise;
  });
  view.rerender(<SessionScreen />);

  expect(screen.queryByTestId(`message-bubble-session-question-answer-pane:${CLAUDE_STREAM_ID}`)).toBeNull();
  expect(screen.getAllByTestId('answer-bubble')).toHaveLength(1);
});

test('stranded Session question rolls back to its preserved draft and can retry', async () => {
  const stranded = deferred<{ dismissed: boolean; textSubmitted: boolean }>();
  mockActions.dismissQuestion.mockReturnValueOnce(stranded.promise);
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-option-2'));
  act(() => fireEvent.press(screen.getByTestId('question-submit')));
  expect(screen.getByTestId(`message-bubble-session-question-answer-pane:${CLAUDE_STREAM_ID}`)).toBeTruthy();

  await act(async () => {
    jest.advanceTimersByTime(SESSION_QUESTION_SUBMISSION_TIMEOUT_MS + 1);
    await Promise.resolve();
  });
  expect(screen.queryByTestId(`message-bubble-session-question-answer-pane:${CLAUDE_STREAM_ID}`)).toBeNull();
  expect(screen.getByText('Question submit failed. Try again.')).toBeTruthy();
  expect(screen.getByTestId('question-option-2').props.accessibilityState.checked).toBe(true);

  mockActions.dismissQuestion.mockResolvedValue({ dismissed: true, textSubmitted: true });
  await act(async () => fireEvent.press(screen.getByTestId('question-submit')));
  expect(mockActions.dismissQuestion).toHaveBeenCalledTimes(2);
  await act(async () => {
    stranded.resolve({ dismissed: true, textSubmitted: true });
    await stranded.promise;
  });
  expect(screen.getByTestId(`message-bubble-session-question-answer-pane:${CLAUDE_STREAM_ID}`)).toBeTruthy();
});

test('durable agent question renders in-chat, submits, and does not restore its matched pane badge on remount', async () => {
  const dispatch = deferred<true>();
  mockActions.answerPrompt.mockReturnValue(dispatch.promise);
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [
    {
      notification_id: 'n-question',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: CLAUDE_STREAM_ID,
      severity: 'info',
      title: 'Pick a lane',
      body: 'Which lane should run?',
      dedup_key: 'question:1',
      state: 'open',
      actions: [{ kind: 'yes_no', action_id: 'legacy-a' }],
      question: {
        question_id: 'q1',
        producer_stream_id: CLAUDE_STREAM_ID,
        response_mode: 'single_choice',
        allow_custom: true,
        options: [
          { label: 'Lane A', value: 'lane_a', description: 'Safest rollout.' },
          { label: 'Lane B', value: 'lane_b' },
        ],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    } as unknown as PentacleNotification,
  ];

  const view = renderQuestionScreen();

  expect(screen.getByText('Which lane should run?')).toBeTruthy();
  expect(screen.getByTestId('question-option-description-1')).toHaveTextContent('Safest rollout.');
  expect(screen.queryByTestId('question-freetext-0')).toBeNull();
  expect(screen.getByTestId('question-cancel')).toBeTruthy();
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(true);

  fireEvent.press(screen.getByTestId('question-option-2'));
  fireEvent.changeText(screen.getByTestId('question-note-0'), 'stale user context');
  fireEvent.press(screen.getByTestId('question-custom-toggle'));
  fireEvent.changeText(screen.getByTestId('question-custom-answer'), 'with a canary first');
  expect(mockActions.answerPrompt).not.toHaveBeenCalled();
  expect(screen.queryByTestId('question-note-0')).toBeNull();

  act(() => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q1',
    text: 'with a canary first',
  });
  expect(mockActions.beginOptimisticQuestionAnswer).toHaveBeenCalledWith(expect.objectContaining({
    streamId: CLAUDE_STREAM_ID,
    notificationId: 'n-question',
    questionId: 'q1',
  }));
  expect(screen.getAllByText('Operator answered: with a canary first')).toHaveLength(1);
  expect(mockActions.dismissQuestion).not.toHaveBeenCalled();

  mockState.events = [{
    daemon_seq: 1,
    stream_id: CLAUDE_STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_id: 'one',
    session_name: 'one',
    timestamp: '2026-05-25T12:00:00.500Z',
    kind: 'USER',
    text: JSON.stringify({
      type: 'notification.answer',
      notification_id: 'n-question',
      question_id: 'q1',
      answer: { action_kind: 'yes_no', text: 'with a canary first' },
    }),
  } as PentacleEvent];
  view.rerender(<SessionScreen />);
  expect(screen.getAllByText('Operator answered: with a canary first')).toHaveLength(1);

  const open = mockState.notifications[0];
  mockState.notifications = [{
    ...open,
    state: 'resolved',
    updated_at: '2026-05-25T12:00:01.000Z',
    resolved_at: '2026-05-25T12:00:01.000Z',
    question: { ...open.question!, state: 'answered', answer: { custom_text: 'with a canary first' } },
    resolution: { by: 'operator', at: '2026-05-25T12:00:01.000Z', action_kind: 'yes_no' },
  } as PentacleNotification];
  await act(async () => {
    dispatch.resolve(true);
    await dispatch.promise;
  });
  expect(mockActions.queueOptimisticQuestionAnswer).toHaveBeenCalledWith('optimistic_question_1');
  view.rerender(<SessionScreen />);
  expect(screen.getAllByText('Operator answered: with a canary first')).toHaveLength(1);
  const authoritativeRows = screen.getByTestId('transcript-list').props.data.filter(
    (item: { notificationId?: string }) => item.notificationId === 'n-question',
  );
  expect(authoritativeRows).toHaveLength(1);
  expect(authoritativeRows[0]).toEqual(expect.objectContaining({
    eventCase: 'agent-question-answer',
    displayRule: 'activity:question',
  }));
  expect(screen.getByTestId('transcript-list').props.data.every(
    (item: { text?: string }) => !String(item.text || '').includes('notification.answer'),
  )).toBe(true);

  view.unmount();
  mockState.sessions = [session(CLAUDE_STREAM_ID, {
    question: {
      header: 'Pick a lane',
      prompt: 'Which lane should run?',
      question_id: 'q1',
      options: [{ index: 1, label: 'Lane A' }, { index: 2, label: 'Lane B' }],
    } as PentacleQuestion,
  })];
  render(<SessionScreen />);
  expect(screen.getAllByText('Operator answered: with a canary first')).toHaveLength(1);
  expect(screen.queryByTestId('question-fab')).toBeNull();
});


test('terminal durable question does not hide a partially overlapping later pane question', () => {
  resetState(CLAUDE_STREAM_ID);
  mockState.sessions = [session(CLAUDE_STREAM_ID, {
    question: {
      ...MULTI_QUESTION,
      question_id: 'q-shared',
      questions: [
        { ...MULTI_QUESTION.questions![0], question_id: 'q-shared' },
        { ...MULTI_QUESTION.questions![1], question_id: 'q-later' },
      ],
    } as unknown as PentacleQuestion,
  })];
  mockState.notifications = [{
    notification_id: 'n-ambiguous-terminal',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:01.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: CLAUDE_STREAM_ID,
    severity: 'info',
    title: 'Earlier grouped question',
    body: 'Earlier grouped question',
    dedup_key: 'question:ambiguous-terminal',
    state: 'answered',
    actions: [],
    question: {
      question_id: 'q-shared',
      producer_stream_id: CLAUDE_STREAM_ID,
      response_mode: 'single_choice',
      options: [],
      state: 'answered',
      answer: { selections: ['done'] },
      questions: [
        { question_id: 'q-shared' },
        { question_id: 'q-old-only' },
      ],
    },
    resolution: { by: 'operator', at: '2026-05-25T12:00:01.000Z', action_kind: 'yes_no' },
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: '2026-05-25T12:00:01.000Z',
  } as unknown as PentacleNotification];

  render(<SessionScreen />);

  expect(screen.getByTestId('question-fab')).toBeTruthy();
});

test('optimistic durable answer stays hidden across Session re-entry and restores when discarded', () => {
  const notification = durableQuestionNotification('n-cross-surface');
  resetState(CLAUDE_STREAM_ID, { question: notification.question as unknown as PentacleQuestion });
  mockState.notifications = [notification];
  mockState.optimisticSends = {
    'optimistic-cross-surface': {
      optimistic_id: 'optimistic-cross-surface',
      request_id: 'request-cross-surface',
      stream_id: CLAUDE_STREAM_ID,
      text: JSON.stringify({
        type: 'notification.answer',
        notification_id: 'n-cross-surface',
        question_id: 'question-n-cross-surface',
        answer: { action_kind: 'yes_no' },
      }),
      status: 'queued',
      created_at: Date.now(),
      reconnect_count: 0,
    },
  };

  const view = render(<SessionScreen />);
  expect(screen.queryByTestId('question-fab')).toBeNull();

  mockState.optimisticSends = {};
  mockState.notifications = [{
    ...mockState.notifications[0],
    client_resolution_pending: false,
    client_resolution_error: 'resolve failed',
  } as PentacleNotification];
  view.rerender(<SessionScreen />);

  expect(screen.getByTestId('question-fab')).toBeTruthy();
});

test('Session restores a multi-question notification when a later child optimistic answer is discarded', () => {
  const notification = {
    ...durableQuestionNotification('n-multi-restore'),
    question: {
      ...durableQuestionNotification('n-multi-restore').question,
      questions: [
        { question_id: 'q-first', response_mode: 'single_choice', options: [{ label: 'A', value: 'a' }] },
        { question_id: 'q-second', response_mode: 'single_choice', options: [{ label: 'B', value: 'b' }] },
      ],
    },
  } as PentacleNotification;
  resetState(CLAUDE_STREAM_ID, { question: notification.question as unknown as PentacleQuestion });
  mockState.notifications = [notification];
  const optimisticSend = (questionId: string) => ({
    optimistic_id: `optimistic-${questionId}`,
    request_id: `request-${questionId}`,
    stream_id: CLAUDE_STREAM_ID,
    text: JSON.stringify({
      type: 'notification.answer',
      notification_id: 'n-multi-restore',
      question_id: questionId,
      answer: { action_kind: 'yes_no' },
    }),
    status: 'queued' as const,
    created_at: Date.now(),
    reconnect_count: 0,
  });
  mockState.optimisticSends = {
    first: optimisticSend('q-first'),
    second: optimisticSend('q-second'),
  };

  const view = render(<SessionScreen />);
  expect(screen.queryByTestId('question-fab')).toBeNull();

  mockState.optimisticSends = { first: optimisticSend('q-first') };
  view.rerender(<SessionScreen />);
  expect(screen.getByTestId('question-fab')).toBeTruthy();
});

test('rejected durable answer restores the overlay with its selected option and note', async () => {
  let rejectResolve: ((error: Error) => void) | undefined;
  mockActions.answerPrompt.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectResolve = reject;
  }));
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [{
    notification_id: 'n-retry-draft',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: CLAUDE_STREAM_ID,
    severity: 'info',
    title: 'Pick a lane',
    body: 'Which lane should run?',
    dedup_key: 'question:retry-draft',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'retry-a' }],
    question: {
      question_id: 'q-retry-draft',
      producer_stream_id: CLAUDE_STREAM_ID,
      response_mode: 'single_choice',
      options: [{ label: 'Lane A', value: 'lane_a' }],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
  }];

  const view = renderQuestionScreen();
  fireEvent.press(screen.getByTestId('question-option-1'));
  fireEvent.changeText(screen.getByTestId('question-note-0'), 'keep this context');
  act(() => fireEvent.press(screen.getByTestId('question-submit')));
  mockState.notifications = [{
    ...mockState.notifications[0],
    client_resolution_pending: true,
  } as PentacleNotification];
  view.rerender(<SessionScreen />);
  expect(screen.queryByText('Which lane should run?')).toBeNull();

  mockState.notifications = [{
    ...mockState.notifications[0],
    client_resolution_pending: false,
    client_resolution_error: 'resolve failed',
  } as PentacleNotification];
  view.rerender(<SessionScreen />);
  await act(async () => rejectResolve?.(new Error('resolve failed')));

  expect(screen.getByText('Which lane should run?')).toBeTruthy();
  expect(screen.getByTestId('question-option-1').props.accessibilityState.checked).toBe(true);
  expect(screen.getByTestId('question-note-0').props.value).toBe('keep this context');
  expect(screen.getByText('resolve failed')).toBeTruthy();
});

test('durable agent question cancel closes the overlay without resolving', async () => {
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [
    {
      notification_id: 'n-question-cancel',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: CLAUDE_STREAM_ID,
      severity: 'info',
      title: 'Pick a lane',
      body: 'Which lane should run?',
      dedup_key: 'question:cancel',
      state: 'open',
      actions: [{ kind: 'yes_no', action_id: 'legacy-a' }],
      question: {
        question_id: 'q-cancel',
        producer_stream_id: CLAUDE_STREAM_ID,
        response_mode: 'single_choice',
        options: [{ label: 'Lane A', value: 'lane_a' }],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    },
  ];

  renderQuestionScreen();
  expect(screen.getByText('Which lane should run?')).toBeTruthy();
  fireEvent.press(screen.getByTestId('question-option-1'));
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(false);

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-cancel'));
  });

  expect(mockActions.resolveNotification).not.toHaveBeenCalled();
  expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
  expect(screen.queryByText('Which lane should run?')).toBeNull();
  expect(screen.getByTestId('question-fab')).toBeTruthy();
  fireEvent.press(screen.getByTestId('question-fab'));
  expect(screen.getByText('Which lane should run?')).toBeTruthy();
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(true);
});

test('durable multi-question payload resolves each child question id', async () => {
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [{
    ...({
      notification_id: 'n-durable-multi',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: CLAUDE_STREAM_ID,
      severity: 'info',
      title: 'Choose rollout details',
      body: 'Answer both.',
      dedup_key: 'question:durable-multi',
      state: 'open',
      actions: [{ kind: 'answer', action_id: 'answer' }],
      question: {
        question_id: 'q-envelope',
        producer_stream_id: CLAUDE_STREAM_ID,
        response_mode: 'single_choice',
        options: [],
        questions: [
          { question_id: 'q-lane', response_mode: 'single_choice', prompt: 'Which lane?', options: [{ label: 'Lane B', value: 'lane_b' }] },
          { question_id: 'q-window', response_mode: 'single_choice', prompt: 'Which window?', options: [{ label: 'Tonight', value: 'tonight' }] },
        ],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    } as unknown as PentacleNotification),
  }];

  renderQuestionScreen();
  fireEvent.press(screen.getByTestId('question-option-1'));
  fireEvent.press(screen.getByTestId('question-page-next'));
  fireEvent.press(screen.getByTestId('question-option-1'));
  await act(async () => fireEvent.press(screen.getByTestId('question-submit')));

  expect(mockActions.answerPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
    questionId: 'q-lane', selections: ['lane_b'],
  }));
  expect(mockActions.answerPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
    questionId: 'q-window', selections: ['tonight'],
  }));
});

test('durable free_text agent question submits exact text through prompt.answer', async () => {
  const typed = `  explain
the blocker  `;
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [
    {
      notification_id: 'n-free-question',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: CLAUDE_STREAM_ID,
      severity: 'info',
      title: 'Explain blocker',
      body: 'What is blocking?',
      dedup_key: 'question:free',
      state: 'open',
      actions: [{ kind: 'ack', action_id: 'ack-free' }],
      question: {
        question_id: 'q-free',
        producer_stream_id: CLAUDE_STREAM_ID,
        response_mode: 'free_text' as any,
        options: [],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    },
  ];

  renderQuestionScreen();
  fireEvent.changeText(screen.getByTestId('question-freetext-0'), typed);
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-free',
    text: typed,
  });
});

test('legacy and durable question sessions coexist and submit through their own actions', async () => {
  const legacyStreamId = CLAUDE_STREAM_ID;
  const durableStreamId = 'hostc:claude:daemon-question';
  mockParams = { streamId: encodeURIComponent(legacyStreamId) };
  mockState.sessions = [
    session(legacyStreamId, { question: QUESTION }),
    session(durableStreamId),
  ];
  mockState.notifications = [
    {
      notification_id: 'n-daemon-question',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: durableStreamId,
      severity: 'info',
      title: 'Pick a lane',
      body: 'Which lane should run?',
      dedup_key: 'question:daemon',
      state: 'open',
      actions: [{ kind: 'yes_no', action_id: 'daemon-a' }],
      question: {
        question_id: 'q-daemon',
        producer_stream_id: durableStreamId,
        response_mode: 'single_choice',
        options: [
          { label: 'Lane A', value: 'lane_a' },
          { label: 'Lane B', value: 'lane_b' },
        ],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    },
  ];

  const view = renderQuestionScreen();
  fireEvent.press(screen.getByTestId('question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    questionKey: `question-key-${legacyStreamId}`,
  });

  mockParams = { streamId: encodeURIComponent(durableStreamId) };
  view.rerender(<SessionScreen />);
  fireEvent.press(screen.getByTestId('question-fab'));
  fireEvent.press(screen.getByTestId('question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-daemon',
    selections: ['lane_b'],
  });
});

test('durable multi_choice question submits multiple selected values with a note', async () => {
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [
    {
      notification_id: 'n-multi-question',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: CLAUDE_STREAM_ID,
      severity: 'info',
      title: 'Pick hosts',
      body: 'Which hosts should run QA?',
      dedup_key: 'question:multi',
      state: 'open',
      actions: [{ kind: 'yes_no', action_id: 'legacy-a' }],
      question: {
        question_id: 'q-multi',
        producer_stream_id: CLAUDE_STREAM_ID,
        response_mode: 'multi_choice',
        options: [
          { label: 'hosta', value: 'hosta' },
          { label: 'hostc', value: 'hostc' },
          { label: 'hostb', value: 'hostb' },
        ],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    },
  ];

  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-option-1'));
  fireEvent.press(screen.getByTestId('question-option-3'));
  fireEvent.changeText(screen.getByTestId('question-note-0'), 'parallelize it');

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-multi',
    selections: ['hosta', 'hostb'],
    text: 'parallelize it',
  });
});

test('durable question discovery is scoped to this chat stream', () => {
  resetState(CLAUDE_STREAM_ID);
  mockState.notifications = [
    {
      notification_id: 'other-question',
      created_at: '2026-05-25T12:00:00.000Z',
      updated_at: '2026-05-25T12:00:00.000Z',
      producer: 'agent_question.v1',
      answer_to_stream_id: 'hosta:codex:other',
      severity: 'info',
      title: 'Other chat',
      body: 'Should not render here',
      dedup_key: 'question:other',
      state: 'open',
      actions: [{ kind: 'ack', action_id: 'ack' }],
      question: {
        question_id: 'q-other',
        producer_stream_id: 'hosta:codex:other',
        response_mode: 'ack',
        options: [{ label: 'OK', value: 'ok' }],
        state: 'open',
        answer: null,
      },
      resolution: null,
      ttl_seconds: 3600,
      expires_at: '2026-05-25T13:00:00.000Z',
      resolved_at: null,
    },
  ];

  renderQuestionScreen();

  expect(screen.queryByText('Should not render here')).toBeNull();
});

test('FAB and dots aggregate pane then durable questions per render item', () => {
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  mockState.notifications = [{
    notification_id: 'n-coexist',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: CLAUDE_STREAM_ID,
    severity: 'info',
    title: 'Durable',
    body: 'Durable prompt?',
    dedup_key: 'question:coexist',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a' }],
    question: {
      question_id: 'q-coexist',
      producer_stream_id: CLAUDE_STREAM_ID,
      response_mode: 'single_choice',
      options: [{ label: 'Proceed', value: 'proceed' }],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
  }];

  const view = render(<SessionScreen />);
  expect(screen.getByTestId('question-fab-count')).toHaveTextContent('2');
  fireEvent.press(screen.getByTestId('question-fab'));
  expect(screen.getByText('Pick a number.')).toBeTruthy();
  expect(screen.getByTestId('question-dot-0')).toBeTruthy();
  expect(screen.getByTestId('question-dot-1')).toBeTruthy();
  fireEvent.press(screen.getByTestId('question-dot-1'));
  expect(screen.getByText('Durable prompt?')).toBeTruthy();
  fireEvent.press(screen.getByTestId('question-overlay-cancel'));

  mockState = { ...mockState, notifications: [{ ...mockState.notifications[0], state: 'resolved' }] };
  view.rerender(<SessionScreen />);
  expect(screen.getByTestId('question-fab-count')).toHaveTextContent('1');
});

test('emits question:card_rendered but not harness-only question render telemetry when harness is not armed', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((p) => seen.push(p));
  resetState(CLAUDE_STREAM_ID, { question: QUESTION });
  renderQuestionScreen();

  const rendered = seen.filter((p) => p.message === TELEMETRY_EVENTS.QUESTION_CARD_RENDERED);
  expect(rendered.length).toBeGreaterThanOrEqual(1);
  // option_count counts only the 2 non-meta options (meta 3/4 are excluded).
  expect(rendered[0].data).toMatchObject({
    stream_id: CLAUDE_STREAM_ID,
    option_count: 2,
    question_count: 1,
    option_counts: [2],
    free_text_count: 0,
    scan_incomplete: false,
    locked_count: 0,
  });
  expect(rendered[0].data).not.toHaveProperty('option_label_count');
  expect(rendered[0].data).not.toHaveProperty('option_label_digests');
  expect(seen.filter((p) => p.message === MOBILE_TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED)).toHaveLength(0);
});

test('does not emit question:card_rendered when there is no pending question', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((p) => seen.push(p));
  renderQuestionScreen();

  expect(seen.filter((p) => p.message === TELEMETRY_EVENTS.QUESTION_CARD_RENDERED)).toHaveLength(0);
});

test('renders multi questions as a single-card pager', () => {
  resetState(CLAUDE_STREAM_ID, { question: MULTI_QUESTION });
  renderQuestionScreen();

  expect(screen.getByTestId('question-card')).toBeTruthy();
  expect(screen.getByTestId('question-card-0')).toBeTruthy();
  expect(screen.queryByTestId('question-card-1')).toBeNull();
  expect(screen.getByTestId('question-page-label')).toHaveTextContent(/1\s*\/\s*2/);
  expect(screen.getByText('Pick a priority.')).toBeTruthy();
  expect(screen.queryByText('Add context.')).toBeNull();
  fireEvent.press(screen.getByTestId('question-page-next'));
  expect(screen.getByTestId('question-page-label')).toHaveTextContent(/2\s*\/\s*2/);
  expect(screen.getByText('Add context.')).toBeTruthy();
  expect(screen.getByTestId('question-option-1')).toBeTruthy();
  expect(screen.queryByTestId('question-freetext-0')).toBeNull();
  expect(screen.queryByTestId('question-freetext-1')).toBeNull();
  expect(screen.queryByTestId('question-note-0')).toBeNull();
  expect(screen.getByTestId('question-cancel')).toBeTruthy();

  const submit = screen.getByTestId('question-submit');
  expect(submit.props.accessibilityState?.disabled).toBe(true);
  expect(submit).toHaveTextContent('2 unanswered');
  expect(screen.queryByTestId('question-warning')).toBeNull();
});

test('full-screen overlay is modal while the composer stays mounted behind it', () => {
  resetState(CLAUDE_STREAM_ID, { question: MULTI_QUESTION });
  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-page-next'));
  expect(screen.getByTestId('composer-bar')).toBeTruthy();
  expect(screen.getByTestId('question-overlay').props.accessibilityViewIsModal).toBe(true);
  expect(screen.getByTestId('composer-bar')).toBeTruthy();
});

test('keeps the unanswered count exclusively on the disabled submit button', () => {
  resetState(CLAUDE_STREAM_ID, { question: MULTI_QUESTION });
  renderQuestionScreen();

  expect(screen.queryByTestId('question-warning')).toBeNull();
  expect(screen.getByTestId('question-page-next')).toHaveTextContent('Next');

  fireEvent.press(screen.getByTestId('question-option-2'));
  fireEvent.press(screen.getByTestId('question-page-next'));
  expect(screen.getByTestId('question-submit')).toHaveTextContent('1 unanswered');
  fireEvent.press(screen.getByTestId('question-option-1'));
  expect(screen.queryByTestId('question-warning')).toBeNull();
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(false);
});

test('multi-question submit sends every answer from the final page', async () => {
  resetState(CLAUDE_STREAM_ID, { question: MULTI_QUESTION });
  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-option-2'));
  fireEvent.press(screen.getByTestId('question-page-next'));
  fireEvent.press(screen.getByTestId('question-option-1'));

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const expectedText = buildPentacleQuestionAnswerText({
    question: MULTI_QUESTION,
    answers: [{ selectedOptionIndex: 2 }, { selectedOptionIndex: 1 }],
  });
  expect(mockActions.dismissQuestion).toHaveBeenCalledTimes(1);
  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    questionKey: `question-key-${CLAUDE_STREAM_ID}`,
  });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: expectedText,
    optimisticId: 'optimistic_question_1',
  });
});

test('dedupes re-emitted question cards by stable question id', () => {
  resetState(CLAUDE_STREAM_ID, { question: DEDUPED_MULTI_QUESTION });
  renderQuestionScreen();

  expect(screen.getAllByText('Pick hosts.')).toHaveLength(1);
  expect(screen.queryByText('Pick hosts again.')).toBeNull();
  expect(screen.getAllByTestId('question-option-1')).toHaveLength(1);
});

test('multi-select min/max constraints disable submit until the count is valid', async () => {
  resetState(CLAUDE_STREAM_ID, { question: BOUNDED_MULTI_SELECT_QUESTION });
  renderQuestionScreen();

  const submit = screen.getByTestId('question-submit');
  expect(submit.props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByTestId('question-constraint')).toHaveTextContent('Select 2 options');

  fireEvent.press(screen.getByTestId('question-option-1'));
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByTestId('question-constraint')).toHaveTextContent('Select 2 options');

  fireEvent.press(screen.getByTestId('question-option-2'));
  expect(screen.queryByTestId('question-constraint')).toBeNull();
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(false);

  fireEvent.press(screen.getByTestId('question-option-3'));
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByTestId('question-constraint')).toHaveTextContent('Select 2 options');

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });
  expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
});

test('bounded multi-select can submit an explicit custom answer through the shared builder', async () => {
  resetState(CLAUDE_STREAM_ID, { question: BOUNDED_MULTI_SELECT_QUESTION });
  renderQuestionScreen();

  fireEvent.press(screen.getByTestId('question-custom-toggle'));
  fireEvent.changeText(screen.getByTestId('question-custom-answer'), 'run it on the hosts with capacity');

  expect(screen.queryByTestId('question-constraint')).toBeNull();
  expect(screen.getByTestId('question-submit').props.accessibilityState?.disabled).toBe(false);

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const expectedText = buildPentacleQuestionAnswerText({
    question: BOUNDED_MULTI_SELECT_QUESTION,
    answers: [{ text: 'run it on the hosts with capacity' }],
  });
  expect(mockActions.dismissQuestion).toHaveBeenCalledTimes(1);
  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    questionKey: `question-key-${CLAUDE_STREAM_ID}`,
  });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: expectedText,
    optimisticId: 'optimistic_question_1',
  });
});

test('multi-question render telemetry describes the visible pager card', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((p) => seen.push(p));
  resetState(CLAUDE_STREAM_ID, { question: SCAN_MULTI_QUESTION });
  renderQuestionScreen();

  const rendered = seen.filter((p) => p.message === TELEMETRY_EVENTS.QUESTION_CARD_RENDERED);
  expect(rendered.length).toBeGreaterThanOrEqual(1);
  expect(rendered[0].data).toMatchObject({
    stream_id: CLAUDE_STREAM_ID,
    option_count: 1,
    question_count: 2,
    option_counts: [1, 1],
    free_text_count: 2,
    scan_incomplete: true,
    locked_count: 1,
  });
});

test('scan_incomplete pager shows one active card and enables submit once answered', () => {
  resetState(CLAUDE_STREAM_ID, { question: SCAN_MULTI_QUESTION });
  renderQuestionScreen();

  expect(screen.getByTestId('question-option-1').props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('question-page-next'));
  expect(screen.getAllByTestId('question-option-1')).toHaveLength(1);
  expect(screen.getByTestId('question-option-1').props.accessibilityState?.disabled).toBe(false);
  expect(screen.queryByTestId('question-freetext-1')).toBeNull();

  const submit = screen.getByTestId('question-submit');
  expect(submit.props.accessibilityState?.disabled).toBe(true);

  fireEvent.press(screen.getByTestId('question-option-1'));

  const enabledSubmit = screen.getByTestId('question-submit');
  expect(enabledSubmit.props.disabled).not.toBe(true);
  expect(enabledSubmit.props.accessibilityState?.disabled).toBe(false);
});

