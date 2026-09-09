import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ChatRow, cardActionAccessibilityLabel, selectCardAction } from '../app/(tabs)/chats';
import type { PentacleChatListItem } from 'pentacle-chat-core';
import type { SessionStatusCardSource } from '../src/components/SessionStatusCard';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

const mockReportsByStream: Record<string, Array<{ read?: boolean; read_at?: string | null }>> = {};
jest.mock('../src/services/pentacleAssets', () => ({
  useSessionReports: (streamId: string) => mockReportsByStream[streamId] ?? [],
  reportUnreadCount: (streamId: string) =>
    (mockReportsByStream[streamId] ?? []).filter((report) => report.read !== true && !report.read_at).length,
  listReports: jest.fn(),
  isReportSessionClosed: () => false,
}));

afterEach(() => {
  for (const key of Object.keys(mockReportsByStream)) delete mockReportsByStream[key];
});

// --- Pure priority matrix -------------------------------------------------

test('selectCardAction resolves question > unread report > caret for every input combination', () => {
  for (const openQuestionItemCount of [0, 1, 3]) {
    for (const hasReports of [false, true]) {
      for (const unread of [0, 1, 2]) {
        for (const hasStatusCard of [false, true]) {
          const action = selectCardAction({
            openQuestionItemCount,
            hasReports,
            reportUnreadCount: unread,
            hasStatusCard,
          });
          if (openQuestionItemCount > 0) {
            expect(action).toEqual({ kind: 'question', count: openQuestionItemCount, enabled: true });
          } else if (hasReports && unread > 0) {
            expect(action).toEqual({ kind: 'report', count: unread, enabled: true });
          } else {
            expect(action).toEqual({ kind: 'caret', enabled: hasStatusCard });
          }
        }
      }
    }
  }
});

test('answered questions and read reports fall through to the next action', () => {
  expect(selectCardAction({ openQuestionItemCount: 0, hasReports: true, reportUnreadCount: 2, hasStatusCard: true }).kind).toBe('report');
  expect(selectCardAction({ openQuestionItemCount: 0, hasReports: true, reportUnreadCount: 0, hasStatusCard: true })).toEqual({ kind: 'caret', enabled: true });
  expect(selectCardAction({ openQuestionItemCount: 0, hasReports: false, reportUnreadCount: 0, hasStatusCard: false })).toEqual({ kind: 'caret', enabled: false });
});

test('cardActionAccessibilityLabel names the action and count', () => {
  expect(cardActionAccessibilityLabel({ kind: 'question', count: 1, enabled: true }, false)).toBe('Answer 1 question');
  expect(cardActionAccessibilityLabel({ kind: 'question', count: 3, enabled: true }, false)).toBe('Answer 3 questions');
  expect(cardActionAccessibilityLabel({ kind: 'report', count: 1, enabled: true }, false)).toBe('Open 1 unread report');
  expect(cardActionAccessibilityLabel({ kind: 'report', count: 2, enabled: true }, false)).toBe('Open 2 unread reports');
  expect(cardActionAccessibilityLabel({ kind: 'caret', enabled: true }, false)).toBe('Expand chat row');
  expect(cardActionAccessibilityLabel({ kind: 'caret', enabled: true }, true)).toBe('Collapse chat row');
  expect(cardActionAccessibilityLabel({ kind: 'caret', enabled: false }, false)).toBe('No status available');
});

// --- Geometry and propagation ----------------------------------------------

type RowChat = PentacleChatListItem & SessionStatusCardSource;

function chatItem(overrides: Partial<RowChat> = {}): RowChat {
  return {
    streamId: 'hostc:claude:geometry',
    host: 'hostc',
    hostTitle: 'hostc',
    provider: 'claude',
    sessionName: 'geometry',
    title: 'Geometry probe',
    previewText: 'checking the footprint',
    status: 'idle',
    statusLabel: 'Idle',
    workingElapsedSeconds: null,
    sending: false,
    sendingImmediate: false,
    updatedLabel: '1m ago',
    draft: '',
    ...overrides,
  } as RowChat;
}

const legacyQuestion = {
  question_key: 'k1',
  prompt: 'Pick a lane',
  options: [{ index: 0, label: 'Lane A' }],
};

const freeTextQuestion = {
  question_key: 'free-text',
  prompt: 'What should the child do next?',
  options: [],
  free_text: true,
  response_mode: 'free_text',
};

function smartChat(overrides: Partial<RowChat> & { openQuestions?: unknown[] } = {}) {
  const { openQuestions = [], ...rest } = overrides;
  return {
    ...chatItem(rest as Partial<RowChat>),
    machineName: 'hostc',
    openQuestions,
    latestMessages: ['checking the footprint'],
    lastEventMs: 0,
  };
}

function renderRow(chat: ReturnType<typeof smartChat> | RowChat, handlers: Record<string, unknown> = {}) {
  return render(
    <ChatRow
      chat={chat as never}
      index={0}
      onOpen={jest.fn()}
      onRename={jest.fn()}
      onDelete={jest.fn()}
      onToggle={jest.fn()}
      onSubmitQuestions={jest.fn()}
      {...handlers}
    />,
  );
}

const ACTION_ID = 'chat-row-toggle-hostc-claude-geometry';

function actionFixtures() {
  return [
    {
      name: 'question',
      chat: smartChat({ openQuestions: [{ kind: 'legacy', id: 'legacy:q', question: legacyQuestion, host: 'hostc', sessionName: 'geometry' }] }),
      glyph: '?',
    },
    {
      name: 'report',
      chat: smartChat(),
      glyph: '!',
      seedReports: [{ read: false, read_at: null }],
    },
    {
      name: 'caret',
      chat: smartChat({ status_card: { goal: 'Probe goal', updated_at: '2026-07-11T00:00:00.000Z' } }),
      glyph: '⌄',
    },
    {
      name: 'disabled caret',
      chat: smartChat(),
      glyph: '⌄',
    },
  ];
}

test('every CardAction kind renders one 30x30 top-right footprint', () => {
  for (const fixture of actionFixtures()) {
    if (fixture.seedReports) mockReportsByStream['hostc:claude:geometry'] = fixture.seedReports;
    const rendered = renderRow(fixture.chat);
    const actions = screen.getAllByTestId(ACTION_ID);
    expect(actions).toHaveLength(1);
    const style = StyleSheet.flatten(actions[0].props.style);
    expect(style.width).toBe(30);
    expect(style.height).toBe(30);
    rendered.unmount();
    delete mockReportsByStream['hostc:claude:geometry'];
  }
});

test('pressing the action never opens the row (propagation isolated)', () => {
  for (const fixture of actionFixtures()) {
    if (fixture.seedReports) mockReportsByStream['hostc:claude:geometry'] = fixture.seedReports;
    const onOpen = jest.fn();
    const onToggle = jest.fn();
    const onOpenReports = jest.fn();
    const rendered = renderRow(fixture.chat, { onOpen, onToggle, onOpenReports });
    fireEvent.press(screen.getByTestId(ACTION_ID));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('chat-row-hostc-claude-geometry'));
    expect(onOpen).toHaveBeenCalledWith('hostc:claude:geometry');
    rendered.unmount();
    delete mockReportsByStream['hostc:claude:geometry'];
  }
});

test('question action toggles; report action opens reports for its own session; disabled caret is inert', () => {
  const onToggle = jest.fn();
  const onOpenReports = jest.fn();

  const question = renderRow(
    smartChat({ openQuestions: [{ kind: 'legacy', id: 'legacy:q', question: legacyQuestion, host: 'hostc', sessionName: 'geometry' }] }),
    { onToggle, onOpenReports },
  );
  fireEvent.press(screen.getByTestId(ACTION_ID));
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onOpenReports).not.toHaveBeenCalled();
  question.unmount();

  mockReportsByStream['hostc:claude:geometry'] = [{ read: false, read_at: null }, { read: false, read_at: null }];
  const report = renderRow(smartChat(), { onToggle, onOpenReports });
  const reportAction = screen.getByTestId(ACTION_ID);
  expect(reportAction.props.accessibilityLabel).toBe('Open 2 unread reports');
  expect(screen.getByTestId('chat-row-report-badge-hostc-claude-geometry')).toBeTruthy();
  fireEvent.press(reportAction);
  expect(onOpenReports).toHaveBeenCalledWith('hostc:claude:geometry');
  expect(onToggle).toHaveBeenCalledTimes(1);
  report.unmount();
  delete mockReportsByStream['hostc:claude:geometry'];

  const disabled = renderRow(smartChat(), { onToggle, onOpenReports });
  const disabledAction = screen.getByTestId(ACTION_ID);
  expect(disabledAction.props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(disabledAction);
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onOpenReports).toHaveBeenCalledTimes(1);
  disabled.unmount();
});

test('question outranks unread reports on the same card', () => {
  mockReportsByStream['hostc:claude:geometry'] = [{ read: false, read_at: null }];
  renderRow(
    smartChat({ openQuestions: [{ kind: 'legacy', id: 'legacy:q', question: legacyQuestion, host: 'hostc', sessionName: 'geometry' }] }),
  );
  expect(screen.getByTestId(ACTION_ID).props.accessibilityLabel).toBe('Answer 1 question');
  expect(screen.queryByTestId('chat-row-report-badge-hostc-claude-geometry')).toBeNull();
});

test('a row whose action flips to report while expanded drops stale expanded styling', () => {
  // Control: an expanded question row carries the accent expanded styling.
  const question = renderRow(
    smartChat({ openQuestions: [{ kind: 'legacy', id: 'legacy:q', question: legacyQuestion, host: 'hostc', sessionName: 'geometry' }] }),
    { expanded: true },
  );
  expect(StyleSheet.flatten(screen.getByTestId(ACTION_ID).props.style).backgroundColor).toBeDefined();
  question.unmount();

  // Same row after the last question resolves: action is now report, but the
  // container's expandedStreamId may not have been cleared yet. The stale
  // expanded accent must not render and the preview must return.
  mockReportsByStream['hostc:claude:geometry'] = [{ read: false, read_at: null }];
  renderRow(smartChat(), { expanded: true });
  const style = StyleSheet.flatten(screen.getByTestId(ACTION_ID).props.style);
  expect(style.backgroundColor).toBeUndefined();
  expect(screen.getByText('checking the footprint')).toBeTruthy();
  delete mockReportsByStream['hostc:claude:geometry'];
});

test('the collapsed chat-row question surface submits free text through its shared flow', async () => {
  const onSubmitQuestions = jest.fn().mockResolvedValue(undefined);
  const chat = smartChat({
    openQuestions: [{ kind: 'legacy', id: 'legacy:free', question: freeTextQuestion, host: 'hostc', sessionName: 'geometry' }],
  });
  renderRow(chat, { expanded: true, onSubmitQuestions });

  fireEvent.changeText(screen.getByTestId('smart-question-free-text'), 'Render the roster before the retry.');
  fireEvent.press(screen.getByTestId('smart-question-submit'));

  await waitFor(() => expect(onSubmitQuestions).toHaveBeenCalledWith(chat, [expect.objectContaining({
    answers: [{ text: 'Render the roster before the retry.' }],
  })]));
});
