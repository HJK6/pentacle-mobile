import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { useUserPreference } from '../src/services/userPreferences';
import * as stream from '../src/services/pentacleStream';
import { buildPentacleQuestionAnswerText, setTelemetrySink, type PentacleQuestion, type PentacleSessionSummary, type TelemetryPayload } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

const STREAM_ID = 'hostc:claude:question-flow';
let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
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

  closeFromServer(code = 1012, reason = 'service_restart') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }
}

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://question-submit.example/ws',
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

function session(question: PentacleQuestion): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'question-flow',
    title: 'Question flow',
    last_event_at: '2026-05-30T12:00:00.000Z',
    last_text: '',
    last_kind: 'WORKING',
    draft: '',
    pending: false,
    working: true,
    online: true,
    question: { ...question, question_key: 'server-question-key' } as PentacleQuestion,
  };
}

const SINGLE_QUESTION: PentacleQuestion = {
  header: 'Pick one',
  prompt: 'Choose a host.',
  options: [
    { index: 1, label: 'hosta', description: 'Desktop host.', meta: false },
    { index: 2, label: 'hostc', description: 'Mobile host.', meta: false },
  ],
};

const TOP_LEVEL_MULTI_SELECT_QUESTION = {
  header: 'Pick hosts',
  prompt: 'Which hosts should run the sweep?',
  multiSelect: true,
  options: [
    { index: 1, label: 'hosta', description: 'Desktop host.', meta: false },
    { index: 2, label: 'hostc', description: 'Mobile host.', meta: false },
    { index: 3, label: 'hostb', description: 'Windows host.', meta: false },
  ],
} as PentacleQuestion & { multiSelect: boolean };

const OPTION_AND_TEXT_QUESTION = {
  header: 'Plan',
  prompt: 'Answer the setup questions.',
  options: [],
  multi: true,
  active_index: 0,
  submit_present: true,
  questions: [
    {
      index: 0,
      header: 'Hosts',
      prompt: 'Which hosts and what context?',
      multiSelect: true,
      free_text: true,
      allow_custom: true,
      options: [
        { index: 1, label: 'hostc', description: 'Mobile host.', meta: false },
        { index: 2, label: 'hosta', description: 'Daemon host.', meta: false },
      ],
    },
  ],
} as unknown as PentacleQuestion;

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected mock WebSocket instance');
  return socket;
}

function latestDismissQuestionPayload(socket: MockWebSocket) {
  const payload = [...socket.sent]
    .map((raw) => JSON.parse(raw))
    .reverse()
    .find((item) => item.type === 'question.dismiss');
  if (!payload) throw new Error(`expected question.dismiss payload, got ${socket.sent.join('\n')}`);
  return payload;
}

function latestSendPayload(socket: MockWebSocket) {
  const payload = [...socket.sent]
    .map((raw) => JSON.parse(raw))
    .reverse()
    .find((item) => item.type === 'send');
  if (!payload) throw new Error('expected send payload');
  return payload;
}

async function ackDismissQuestion(socket: MockWebSocket, requestId: string, textSubmitted = true) {
  await act(async () => {
    socket.message({
      type: 'question.dismiss.ok',
      request_id: requestId,
      dismissed: true,
      text_submitted: textSubmitted,
    });
  });
}

function settleUnansweredQuestionRequests() {
  for (const socket of MockWebSocket.instances) {
    for (const raw of socket.sent) {
      const payload = JSON.parse(raw);
      if (payload.type === 'question.dismiss' && typeof payload.request_id === 'string') {
        socket.message({
          type: 'question.dismiss.ok',
          request_id: payload.request_id,
          dismissed: true,
          text_submitted: payload.text !== undefined,
        });
      }
      if (payload.type === 'send' && typeof payload.request_id === 'string') {
        socket.message({ type: 'send.ok', request_id: payload.request_id });
      }
    }
  }
}

async function mountQuestion(question: PentacleQuestion) {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
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
      sessions: [session(question)],
      events: [],
    });
  });

  render(<SessionScreen />);
  act(() => {
    jest.advanceTimersByTime(0);
  });
  act(() => {
    jest.advanceTimersByTime(16);
  });
  fireEvent.press(screen.getByTestId('question-fab'));

  return { socket, seen };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-30T12:00:00.000Z') });
  stream.__resetPentacleStreamForTests();
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
});

afterEach(() => {
  settleUnansweredQuestionRequests();
  while (cleanupFns.length) {
    cleanupFns.pop()?.();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
  setTelemetrySink(null);
});

test('question_dismiss_failed leaves the question card retryable on the real submit path', async () => {
  const { socket, seen } = await mountQuestion(SINGLE_QUESTION);

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-option-2'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const payload = latestDismissQuestionPayload(socket);
  expect(payload).toMatchObject({
    type: 'question.dismiss',
    host: 'hostc',
    session_name: 'question-flow',
    question_key: 'server-question-key',
  });
  expect(payload).not.toHaveProperty('text');
  // Questions-UI redesign: a submitted answer is NOT a chat send, so no
  // `user-send-sending` chat-send affordance renders. The optimistic answer is
  // held as a structured answer row while the question.dismiss is in flight, and
  // the answer text only reaches chat-stream-v2 as a real sendMessage AFTER a
  // successful question.dismiss.ok (verified by the multiSelect/custom-text
  // siblings via latestSendPayload). This test drives a dismiss FAILURE, so the
  // answer send is intentionally never issued and the card stays retryable.

  await act(async () => {
    socket.message({
      type: 'question.dismiss.error',
      request_id: payload.request_id,
      error_code: 'question_dismiss_failed',
      error: 'selector stayed active',
    });
  });

  expect(await screen.findByTestId('question-submit-error')).toHaveTextContent(/not dismissed/i);
  expect(screen.getByTestId('question-card')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('question-option-2').props.accessibilityState?.disabled).not.toBe(true));
  expect(seen.some((payload) => payload.data?.subsystem === 'question_flow' && payload.data?.bug_ref === 'trackD_bug1_submit')).toBe(true);
});

test('top-level multiSelect dismisses without text then identity-sends exact builder text', async () => {
  const { socket, seen } = await mountQuestion(TOP_LEVEL_MULTI_SELECT_QUESTION);

  fireEvent.press(screen.getByTestId('question-option-1'));
  fireEvent.press(screen.getByTestId('question-option-3'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const payload = latestDismissQuestionPayload(socket);
  expect(payload).not.toHaveProperty('text');
  expect(payload.question_key).toBe('server-question-key');
  await ackDismissQuestion(socket, payload.request_id);
  const sendPayload = latestSendPayload(socket);
  expect(sendPayload.text).toBe(buildPentacleQuestionAnswerText({
    question: TOP_LEVEL_MULTI_SELECT_QUESTION,
    answers: [{ selectedOptionIndices: [1, 3] }],
  }));
  expect(sendPayload.optimistic_id).toMatch(/^optimistic_/);
  expect(seen.some((payload) => payload.data?.subsystem === 'question_flow' && payload.data?.bug_ref === 'trackD_bug3_multiselect')).toBe(true);
});

test('custom text takes the answer slot without a notes field', async () => {
  const { socket } = await mountQuestion(OPTION_AND_TEXT_QUESTION);

  fireEvent.press(screen.getByTestId('question-custom-toggle'));
  fireEvent.changeText(screen.getByTestId('question-custom-answer'), 'include the slow hosts');
  expect(screen.queryByTestId('question-note-0')).toBeNull();

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const payload = latestDismissQuestionPayload(socket);
  expect(payload).not.toHaveProperty('text');
  await ackDismissQuestion(socket, payload.request_id);
  expect(latestSendPayload(socket).text).toBe(buildPentacleQuestionAnswerText({
    question: {
      ...OPTION_AND_TEXT_QUESTION,
      questions: [OPTION_AND_TEXT_QUESTION.questions![0]],
      active_index: 0,
    },
    answers: [{ text: 'include the slow hosts' }],
  }));
});

test('cancel closes the overlay without dismissing the question', async () => {
  const { socket } = await mountQuestion(SINGLE_QUESTION);

  await act(async () => {
    fireEvent.press(screen.getByTestId('question-cancel'));
  });

  expect(screen.queryByTestId('question-overlay')).toBeNull();
  expect(socket.sent.map((raw) => JSON.parse(raw)).some((payload) => payload.type === 'question.dismiss')).toBe(false);
  expect(screen.getByTestId('question-fab')).toBeTruthy();
});

test('send rejection keeps the dismissed answer as a retryable failed transcript row', async () => {
  const { socket } = await mountQuestion(SINGLE_QUESTION);

  fireEvent.press(screen.getByTestId('question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const payload = latestDismissQuestionPayload(socket);
  await ackDismissQuestion(socket, payload.request_id);
  const sendPayload = latestSendPayload(socket);
  await act(async () => {
    socket.message({
      type: 'send.error',
      request_id: sendPayload.request_id,
      error: 'send failed',
    });
  });

  expect(screen.queryByTestId('question-card')).toBeNull();
  expect(await screen.findByTestId('user-send-failed')).toBeTruthy();
  expect(screen.getByTestId('user-send-retry')).toBeTruthy();
});

// A transport-cut answer may have landed, so reconnect queries its durable
// receipt rather than silently sending a duplicate. The row stays pending.
test.each([
  { cut: 'half-open send', code: 4000, reason: 'focused_heartbeat_timeout', resume: false },
  { cut: 'drop after send without ack', code: 1006, reason: 'result_lost', resume: false },
  { cut: 'disconnect/reconnect mid-send', code: 1001, reason: 'network_transition', resume: false },
  { cut: 'background/foreground pending send', code: 1006, reason: 'foreground_probe_silent', resume: true },
])('question answer under $cut queries its receipt once on reconnect and stays pending', async ({ code, reason, resume }) => {
  const { socket } = await mountQuestion(SINGLE_QUESTION);

  fireEvent.press(screen.getByTestId('question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });
  const dismissPayload = latestDismissQuestionPayload(socket);
  await ackDismissQuestion(socket, dismissPayload.request_id);
  const originalSend = latestSendPayload(socket);
  const originalRequestId = originalSend.request_id as string;

  await act(async () => {
    if (resume) stream.__handlePentacleAppStateChangeForTests('background');
    socket.closeFromServer(code, reason);
    if (resume) stream.__handlePentacleAppStateChangeForTests('active');
  });
  act(() => {
    jest.advanceTimersByTime(1_000);
  });
  const recovered = latestSocket();
  await act(async () => {
    recovered.open();
  });

  expect(screen.queryByTestId('question-card')).toBeNull();
  expect(screen.queryByTestId('user-send-failed')).toBeNull();
  expect(screen.queryByTestId('user-send-retry')).toBeNull();
  const replays = recovered.sent.map((raw) => JSON.parse(raw)).filter((payload) => payload.type === 'send');
  expect(replays).toHaveLength(0);
  const receiptQueries = recovered.sent.map((raw) => JSON.parse(raw)).filter((payload) => payload.type === 'send.receipt.get');
  expect(receiptQueries).toHaveLength(1);
  expect(receiptQueries[0]).toMatchObject({
    to_stream_id: STREAM_ID,
    request_id: originalRequestId,
  });
});

// Daemon restart (1012) is NOT a replay-safe transport cut: the answer remains
// unconfirmed until its durable receipt resolves it and is never retransmitted.
test('question answer under daemon restart stays pending without retransmission', async () => {
  const { socket } = await mountQuestion(SINGLE_QUESTION);

  fireEvent.press(screen.getByTestId('question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });
  const dismissPayload = latestDismissQuestionPayload(socket);
  await ackDismissQuestion(socket, dismissPayload.request_id);
  latestSendPayload(socket);

  await act(async () => {
    socket.closeFromServer(1012, 'service_restart');
  });
  act(() => {
    jest.advanceTimersByTime(1_000);
  });
  const recovered = latestSocket();
  await act(async () => {
    recovered.open();
  });

  expect(screen.queryByTestId('question-card')).toBeNull();
  expect(screen.queryByTestId('user-send-failed')).toBeNull();
  expect(screen.queryByTestId('user-send-retry')).toBeNull();
  expect(recovered.sent.map((raw) => JSON.parse(raw)).filter((payload) => payload.type === 'send')).toHaveLength(0);
  const receiptQueries = recovered.sent.map((raw) => JSON.parse(raw)).filter((payload) => payload.type === 'send.receipt.get');
  expect(receiptQueries).toHaveLength(1);
});

test('stale_question still dispatches the existing optimistic row by identity', async () => {
  const { socket } = await mountQuestion(SINGLE_QUESTION);

  fireEvent.press(screen.getByTestId('question-option-1'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('question-submit'));
  });

  const payload = latestDismissQuestionPayload(socket);
  await act(async () => {
    socket.message({
      type: 'question.dismiss.error',
      request_id: payload.request_id,
      error_code: 'stale_question',
      error: 'already dismissed',
    });
  });

  expect(screen.queryByTestId('question-card')).toBeNull();
  const sendPayload = latestSendPayload(socket);
  expect(sendPayload.optimistic_id).toMatch(/^optimistic_/);
  expect(sendPayload.text).toBe(buildPentacleQuestionAnswerText({
    question: SINGLE_QUESTION,
    answers: [{ selectedOptionIndex: 1 }],
  }));
});

