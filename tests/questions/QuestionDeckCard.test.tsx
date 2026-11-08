import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import QuestionDeckCard from '../../src/components/questions/QuestionDeckCard';
import MachineSigil from '../../src/components/MachineSigil';
import { questionCardStore } from '../../src/components/questions/questionCardStore';
import { baseState, durableQuestion, legacyQuestion, session, SESSION_B, HOSTS_CONFIG } from './fixtures';

let mockState: any;
const mockListeners = new Set<() => void>();
const mockActions: Record<string, jest.Mock> = {};
const mockSeeChat = jest.fn();
jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('../helpers/mocks/expoRouter').makeMock());
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../src/services/chatOpenNavigation', () => ({ performChatOpenNavigation: (...args: unknown[]) => mockSeeChat(...args) }));
jest.mock('../../src/services/voicePresentation', () => ({ useVoiceSurface: jest.fn() }));
jest.mock('../../src/components/voice/HeaderVoiceMic', () => ({ __esModule: true, default: () => null }));
jest.mock('../../src/services/pentacleStream', () => ({
  ...jest.requireActual('../../src/services/pentacleStream'),
  usePentacleStreamActions: () => mockActions,
  usePentacleStreamSelector: (selector: (state: any) => unknown) => {
    const ReactActual = require('react');
    const [, update] = ReactActual.useReducer((n: number) => n + 1, 0);
    ReactActual.useEffect(() => { mockListeners.add(update); return () => { mockListeners.delete(update); }; }, []);
    return selector(mockState);
  },
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: (state: any) => unknown) => selector(mockState),
}));
function notify() { mockListeners.forEach((listener) => listener()); }
async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
async function press(id: string) { await act(async () => { fireEvent.press(screen.getByTestId(id)); await flush(); }); }
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function finalDurable() {
  mockState = baseState({ sessions: [session(SESSION_B, 'Review')], notifications: [durableQuestion(SESSION_B, 'only')] });
}
beforeEach(() => {
  questionCardStore.reset(); mockListeners.clear(); mockSeeChat.mockReset();
  (globalThis as any).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG;
  finalDurable();
  mockActions.beginOptimisticQuestionAnswer = jest.fn(() => {
    mockState = { ...mockState, notifications: [] }; notify(); return 'optimistic';
  });
  mockActions.answerPrompt = jest.fn().mockResolvedValue(undefined);
  mockActions.queueOptimisticQuestionAnswer = jest.fn();
  mockActions.discardOptimisticQuestionAnswer = jest.fn(() => { finalDurable(); notify(); });
  mockActions.dismissQuestion = jest.fn(async () => {
    mockState = { ...mockState, sessions: mockState.sessions.map((s: any) => ({ ...s, question: null })) }; notify();
  });
  mockActions.sendMessage = jest.fn().mockResolvedValue(undefined);
});
afterEach(() => { delete (globalThis as any).__PENTACLE_EXPO_CONFIG__; });

test('embedded card has the shared controls and no header mic or See chat', () => {
  render(<QuestionDeckCard embedded />);
  expect(screen.getByTestId('question-deck-card')).toBeTruthy();
  expect(screen.getByTestId('questions-unanswered-label')).toHaveTextContent('1 unanswered');
  expect(screen.getByTestId('questions-skip')).toBeTruthy();
  expect(screen.queryByTestId('questions-see-chat')).toBeNull();
  expect(screen.queryByTestId('questions-voice-mic')).toBeNull();
});

test('closing and reopening preserves an answer and page, while an unseen key shows its page', () => {
  render(<QuestionDeckCard embedded />);
  fireEvent.press(screen.getByTestId('questions-option-1'));
  fireEvent.press(screen.getByTestId('questions-close'));
  expect(screen.queryByTestId('question-deck-card')).toBeNull();
  act(() => questionCardStore.toggle(1));
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Send all answers');
  fireEvent.press(screen.getByTestId('questions-close'));
  act(() => { mockState = { ...mockState, notifications: [...mockState.notifications, durableQuestion(SESSION_B, 'new')] }; notify(); });
  expect(screen.getByTestId('questions-counter')).toHaveTextContent('QUESTION 2 / 2');
});

test('a final delayed submit stays mounted on its pinned page, including hide and remount, then settles away', async () => {
  const pending = deferred(); mockActions.answerPrompt.mockReturnValue(pending.promise);
  const view = render(<QuestionDeckCard embedded />);
  fireEvent.press(screen.getByTestId('questions-option-1'));
  await press('questions-submit');
  expect(mockState.notifications).toEqual([]);
  expect(screen.getByTestId('questions-counter')).toHaveTextContent('QUESTION 1 / 1');
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Sending');
  fireEvent.press(screen.getByTestId('questions-close'));
  act(() => questionCardStore.toggle(1));
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Sending');
  view.unmount();
  render(<QuestionDeckCard embedded />);
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Sending');
  await act(async () => { pending.resolve(); await flush(); });
  expect(screen.queryByTestId('question-deck-card')).toBeNull();
});

test('a rejected final durable submit retains its pinned page, error and draft', async () => {
  const pending = deferred(); mockActions.answerPrompt.mockReturnValue(pending.promise);
  render(<QuestionDeckCard embedded />);
  fireEvent.press(screen.getByTestId('questions-option-1'));
  await press('questions-submit');
  await act(async () => { pending.reject(new Error('Daemon rejected this answer')); await flush(); });
  expect(screen.getByTestId('questions-item-error')).toHaveTextContent('Daemon rejected this answer');
  expect(screen.getByTestId('questions-counter')).toHaveTextContent('QUESTION 1 / 1');
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Send all answers');
  fireEvent.press(screen.getByTestId('questions-close'));
  act(() => questionCardStore.toggle(1));
  expect(screen.getByTestId('questions-item-error')).toBeTruthy();
});

test('a final legacy send failure holds the empty card and See chat until dismissed', async () => {
  mockState = baseState({ sessions: [session(SESSION_B, 'Legacy review', { question: legacyQuestion() })] });
  mockActions.sendMessage.mockRejectedValue(new Error('Offline'));
  render(<QuestionDeckCard embedded />);
  fireEvent.press(screen.getByTestId('questions-option-1'));
  await press('questions-submit');
  expect(screen.getByTestId('question-deck-card')).toBeTruthy();
  expect(screen.getByTestId('questions-legacy-error')).toBeTruthy();
  await press('questions-legacy-see-chat');
  expect(mockSeeChat).toHaveBeenCalledWith(SESSION_B, expect.anything());
  await press('questions-legacy-dismiss');
  expect(screen.queryByTestId('question-deck-card')).toBeNull();
});


test.each(['none', 'unknown', 'found'])('source lane mark: %s', (kind) => {
  const lane = { lane_id: 'sample', title: 'Test infrastructure', icon: 'flask', members: [], members_total: kind === 'unknown' ? 9 : 0,
    lead: kind === 'found' ? { stream_id: SESSION_B } : null };
  mockState = { ...mockState, workLanes: { lanes: [lane], counts: { open: 1, active: 1, paused: 0, blocked: 0 }, generated_at: '', truncated: false } };
  render(<QuestionDeckCard embedded />);
  if (kind === 'found') {
    expect(screen.getByTestId('questions-lane-source-mark')).toBeTruthy();
    expect(screen.getByTestId('lane-icon-flask')).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(MachineSigil)).toHaveLength(0);
  } else {
    expect(screen.getByTestId('questions-source-mark')).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(MachineSigil)).toHaveLength(1);
  }
});

test.each([false, true])('shared footer covers first, middle, last and one unanswered page (embedded=%s)', (embedded) => {
  mockState = baseState({ sessions: [session(SESSION_B, 'Review')], notifications: ['first', 'middle', 'last'].map(id => durableQuestion(SESSION_B, id)) });
  const view = render(<QuestionDeckCard embedded={embedded} />);
  expect(screen.getByTestId('questions-next')).toBeTruthy();
  expect(screen.queryByTestId('questions-back')).toBeNull();
  fireEvent.press(screen.getByTestId('questions-option-1'));
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Submit 1 of 3');
  fireEvent.press(screen.getByTestId('questions-next'));
  expect(screen.getByTestId('questions-back')).toBeTruthy();
  expect(screen.getByTestId('questions-next')).toBeTruthy();
  fireEvent.press(screen.getByTestId('questions-option-1'));
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Submit 2 of 3');
  fireEvent.press(screen.getByTestId('questions-next'));
  expect(screen.queryByTestId('questions-next')).toBeNull();
  fireEvent.press(screen.getByTestId('questions-option-1'));
  expect(screen.getByTestId('questions-submit-label')).toHaveTextContent('Send all answers');
  view.unmount();
  questionCardStore.reset(); finalDurable();
  render(<QuestionDeckCard embedded={embedded} />);
  expect(screen.getByTestId('questions-unanswered-label')).toHaveTextContent('1 unanswered');
});
