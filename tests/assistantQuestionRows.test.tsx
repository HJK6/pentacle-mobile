import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import { initialPentacleStreamState, type PentacleNotification } from 'pentacle-chat-core';
import { ChatRow, selectSmartChatList, selectVisibleChatList } from '../app/(tabs)/chats';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null), setItemAsync: jest.fn() }));
jest.mock('../src/services/pentacleAssets', () => ({
  useSessionReports: () => [], reportUnreadCount: () => 0, listReports: jest.fn(), isReportSessionClosed: () => false,
}));

const composite = 'example:assistant';
// The same committed test can replay a real producer locally without publishing it.
const producer = process.env.CARD_ROW_PRODUCER_STREAM_ID || 'hosta:v2-bound';

function card(index: number, overrides: Record<string, unknown> = {}): PentacleNotification {
  return {
    notification_id: `card-${index}`, producer: 'agent_question.v1', state: 'open',
    title: `Synthetic decision ${index}`, body: 'Choose a fixture path.',
    created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z',
    severity: 'info', dedup_key: `card-${index}`, actions: [{ kind: 'yes_no' }],
    answer_to_stream_id: producer, surfaced_to_stream_id: composite,
    question: { question_id: `question-${index}`, producer_stream_id: producer,
      response_mode: 'single_choice', options: [{ label: 'Proceed', value: 'proceed' }], state: 'open', answer: null },
    resolution: null, ttl_seconds: 0, expires_at: '', resolved_at: null,
    ...overrides,
  } as PentacleNotification;
}

function state(notifications: PentacleNotification[] = [1, 2, 3, 4].map((i) => card(i))) {
  return {
    ...initialPentacleStreamState, connected: true, hasHydrated: true, notifications,
    sessions: [{ stream_id: composite, host: 'example', provider: 'composite', session_name: 'assistant',
      display_name: 'Example assistant', session_kind: 'assistant_composite', role: 'assistant_composite',
      visibility: 'default', online: true, last_event_at: '2026-10-05T12:00:00Z', last_text: 'Assistant preview', last_kind: 'ASSIST' }],
  } as any;
}

function renderRows(input: ReturnType<typeof state>) {
  const rows = selectSmartChatList(input);
  render(<>{rows.map((chat, index) => <ChatRow key={chat.streamId} chat={chat} index={index}
    onOpen={jest.fn()} onRename={jest.fn()} onDelete={jest.fn()} onToggle={jest.fn()} onSubmitQuestions={jest.fn()} />)}</>);
  return rows;
}

test('the actual producer under a narrowed inventory has four questions on one composite row', () => {
  const input = state();
  const rows = renderRows(input);
  expect(rows.map((row) => row.streamId)).toEqual([composite]);
  expect(rows[0].openQuestions).toHaveLength(4);
  expect(rows[0].machineName).toBe('hosta');
  expect(rows[0].provider.toLowerCase()).toBe('composite');
  expect(screen.getByLabelText('Answer 4 questions')).toBeTruthy();
  expect(screen.getByText('Assistant')).toBeTruthy();
  expect(screen.queryByText('Codex')).toBeNull();
  expect(screen.queryByText('Synthetic decision 1')).toBeNull();
  expect(input.notifications.every((n: PentacleNotification) => n.question?.producer_stream_id === producer && n.answer_to_stream_id === producer)).toBe(true);
});

test('a different hidden seat keeps its own row and an unknown provider never becomes Codex', () => {
  const other = card(5, { surfaced_to_stream_id: null, answer_to_stream_id: 'hostb:v2-other',
    question: { ...card(5).question, producer_stream_id: 'hostb:v2-other' } });
  const input = state([card(1), other]);
  const rows = renderRows(input);
  expect(rows.map((row) => row.streamId)).toEqual([composite, 'hostb:v2-other']);
  expect(rows.map((row) => row.openQuestions.length)).toEqual([1, 1]);
  expect(screen.getByText('Synthetic decision 5')).toBeTruthy();
  expect(screen.queryByText('Codex')).toBeNull();
  expect(screen.getByText('Agent')).toBeTruthy();
});

test.each(['claude', 'codex'])('a question-bearing seat uses its inventory provider %s', (provider) => {
  const other = card(5, { surfaced_to_stream_id: null, answer_to_stream_id: 'hostb:v2-other',
    question: { ...card(5).question, producer_stream_id: 'hostb:v2-other' } });
  const input = state([card(1), other]);
  input.sessions.push({ stream_id: 'hostb:v2-other', host: 'hostb', session_name: 'v2-other',
    provider, title: 'Other seat', visibility: 'hidden', online: true });
  input.sessions.push({ stream_id: 'hostb:v2-unrelated', host: 'hostb', session_name: 'unrelated',
    provider: 'codex', title: 'Hidden unrelated seat', visibility: 'hidden', online: true });
  const rows = renderRows(input);
  expect(rows.map((row) => row.streamId)).toEqual([composite, 'hostb:v2-other']);
  expect(selectVisibleChatList(input, 'hostb').map((row) => row.streamId)).toEqual(['hostb:v2-other']);
  expect(screen.queryByText('Hidden unrelated seat')).toBeNull();
  const otherRow = screen.getByTestId('chat-row-hostb-v2-other');
  expect(within(otherRow).getByText(provider === 'claude' ? 'Claude' : 'Codex')).toBeTruthy();
});

test.each(['claude', 'codex'])('an absent seat inventory uses explicit question provider %s', (provider) => {
  const notification = card(5, { surfaced_to_stream_id: null, answer_to_stream_id: 'hostb:v2-other',
    question: { ...card(5).question, producer_stream_id: 'hostb:v2-other', producer_provider: provider } });
  const rows = renderRows(state([notification]));
  expect(rows.find((row) => row.streamId === 'hostb:v2-other')?.provider.toLowerCase()).toBe(provider);
  expect(screen.getByText(provider === 'claude' ? 'Claude' : 'Codex')).toBeTruthy();
});

test('a legacy three-part seat retains its explicit provider without inventory', () => {
  const notification = card(5, { surfaced_to_stream_id: null, answer_to_stream_id: 'hostb:claude:other',
    question: { ...card(5).question, producer_stream_id: 'hostb:claude:other' } });
  renderRows(state([notification]));
  expect(screen.getByText('Claude')).toBeTruthy();
  expect(screen.queryByText('Codex')).toBeNull();
});
