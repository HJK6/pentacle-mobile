import React from 'react';
import { act, fireEvent, render, screen, type RenderAPI } from '@testing-library/react-native';
import { ChatRow } from '../app/(tabs)/chats';
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

afterEach(() => {
  jest.useRealTimers();
});

function collectText(node: ReturnType<RenderAPI['toJSON']> | ReturnType<RenderAPI['toJSON']>[] | string | null): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  return (node.children || []).map(collectText).join('');
}

test('ChatRow renders chat metadata and opens the stream when pressed', () => {
  jest.useFakeTimers({ now: new Date('2026-06-18T12:00:00.000Z') });
  const chat: PentacleChatListItem = {
    streamId: 'alpha:codex:freeze-fix',
    host: 'alpha',
    hostTitle: 'Alpha',
    provider: 'codex',
    sessionName: 'freeze-fix',
    title: 'Freeze fix triage',
    previewText: 'Reviewing event flow without parent ticker churn',
    status: 'working',
    statusLabel: 'Working',
    workingElapsedSeconds: 65,
    sending: false,
    sendingImmediate: false,
    updatedLabel: '30s ago',
    draft: '',
  };
  const opened: string[] = [];

  const rendered = render(
    <ChatRow
      chat={chat}
      index={0}
      onOpen={(streamId) => opened.push(streamId)}
      onRename={() => {}}
      onDelete={() => {}}
    />,
  );
  const renderedText = collectText(rendered.toJSON());

  for (const value of [
    chat.title,
    'Codex',
    chat.updatedLabel,
    chat.previewText,
  ]) {
    expect(renderedText.includes(value)).toBe(true);
  }
  expect(renderedText.includes(chat.statusLabel)).toBe(false);
  expect(renderedText.includes('01:05')).toBe(true);
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByTestId('status-tag-elapsed').props.children).toBe('01:06');

  const row = screen.getByTestId('chat-row-alpha-codex-freeze-fix');
  expect(row.props.accessibilityLabel).toBe(`${chat.title}, ${chat.statusLabel}, ${chat.hostTitle}, ${chat.provider} · ${chat.updatedLabel}, ${chat.previewText}`);

  fireEvent.press(row);
  expect(opened).toEqual([chat.streamId]);
});

test('ChatRow renders the sending status glyph from the list item', () => {
  const chat: PentacleChatListItem = {
    streamId: 'alpha:codex:sending',
    host: 'alpha',
    hostTitle: 'Alpha',
    provider: 'codex',
    sessionName: 'sending',
    title: 'Sending case',
    previewText: 'Uploading image',
    status: 'sending',
    statusLabel: 'Sending',
    workingElapsedSeconds: null,
    sending: true,
    sendingImmediate: true,
    updatedLabel: 'now',
    draft: '',
  };

  render(
    <ChatRow
      chat={chat}
      index={0}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
    />,
  );

  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  expect(screen.queryByTestId('status-tag-elapsed')).toBeNull();
});

test('ChatRow renders unresponsive while retaining the last transcript preview', () => {
  const chat = statusChat({
    streamId: 'alpha:codex:tmux-timeout',
    title: 'Tmux timeout',
    previewText: 'Last good transcript reply',
    status: 'unresponsive',
    statusLabel: 'Unresponsive',
  });

  render(
    <ChatRow
      chat={chat}
      index={0}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
    />,
  );

  expect(screen.getByTestId('status-tag-unresponsive')).toBeTruthy();
  expect(screen.getByText('Unresponsive')).toBeTruthy();
  expect(screen.getByText('Last good transcript reply')).toBeTruthy();
});

function statusChat(overrides: Partial<PentacleChatListItem & SessionStatusCardSource> = {}): PentacleChatListItem & SessionStatusCardSource {
  return {
    streamId: 'alpha:codex:status-card',
    host: 'alpha',
    hostTitle: 'Alpha',
    provider: 'codex',
    sessionName: 'status-card',
    title: 'Status card',
    previewText: 'Previous transcript preview',
    status: 'working',
    statusLabel: 'Working',
    workingElapsedSeconds: null,
    sending: false,
    sendingImmediate: false,
    updatedLabel: 'now',
    draft: '',
    ...overrides,
  };
}

test('ChatRow expanded panel renders the inline status mini without issue details', () => {
  jest.useFakeTimers({ now: new Date('2026-07-09T12:10:00.000Z') });
  const rendered = render(
    <ChatRow
      chat={statusChat({
        status_card: {
          goal: 'Ship mobile status-card rendering',
          plan: [
            { text: 'types', status: 'done' },
            { text: 'mobile render', status: 'active' },
            { text: 'qa', status: 'pending' },
          ],
          update: 'ChatRow is under test',
          handoff_planned: true,
          updated_at: '2026-07-09T12:05:00.000Z',
        },
        context_tokens: 251000,
        model_context_window: 500000,
        context_level: 'advisory',
        spec_issues: [{ obligation_id: 'ob-1', detail: 'frontmatter drift' }],
      })}
      index={0}
      expanded
      onToggle={() => {}}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onSubmitQuestions={async () => {}}
    />,
  );
  const renderedText = collectText(rendered.toJSON());

  for (const value of [
    'Ship mobile status-card rendering',
    'mobile render',
    'ChatRow is under test',
    '5m ago',
    'handoff',
  ]) {
    expect(renderedText.includes(value)).toBe(true);
  }
  expect(screen.getByLabelText('1 of 3 plan steps complete')).toBeTruthy();
  expect(screen.getByTestId('status-card-context').props.accessibilityLabel).toBe('251k · 50%');
});

test('ChatRow status card hides absent rows and renders all-done plans', () => {
  jest.useFakeTimers({ now: new Date('2026-07-09T12:10:00.000Z') });
  const goalOnly = render(
    <ChatRow
      chat={statusChat({ status_card: { goal: 'Goal only card', updated_at: '2026-07-09T12:09:50.000Z' } })}
      index={0}
      expanded
      onToggle={() => {}}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onSubmitQuestions={async () => {}}
    />,
  );
  const goalText = collectText(goalOnly.toJSON());
  expect(goalText.includes('Goal only card')).toBe(true);
  expect(goalText.includes('just now')).toBe(true);
  expect(goalText.includes('handoff planned')).toBe(false);
  expect(goalText.includes('ctx ')).toBe(false);
  expect(goalText.includes('spec issue')).toBe(false);

  goalOnly.unmount();
  const planOnly = render(
    <ChatRow
      chat={statusChat({
        status_card: {
          plan: [
            { text: 'one', status: 'done' },
            { text: 'two', status: 'done' },
          ],
          updated_at: '2026-07-09T10:10:00.000Z',
        },
      })}
      index={0}
      expanded
      onToggle={() => {}}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onSubmitQuestions={async () => {}}
    />,
  );
  const planText = collectText(planOnly.toJSON());
  expect(planText.includes('2/2')).toBe(true);
  expect(planText.includes('2h ago')).toBe(true);
});

test('ChatRow does not fabricate a mini from context or legacy spec issues', () => {
  const rendered = render(
    <ChatRow
      chat={statusChat({
        context_tokens: 97000,
        spec_issues: [{ detail: 'missing AC' }, { detail: 'stale summary' }],
      })}
      index={0}
      expanded
      onToggle={() => {}}
      onOpen={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onSubmitQuestions={async () => {}}
    />,
  );
  const renderedText = collectText(rendered.toJSON());
  expect(renderedText.includes('ctx 97k')).toBe(false);
  expect(renderedText.includes('spec issue')).toBe(false);
});
