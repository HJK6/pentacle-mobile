import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ChatRow } from '../app/(tabs)/chats';
import type { PentacleChatListItem } from 'pentacle-chat-core';
import { Swipeable } from 'react-native-gesture-handler';

const mockLogTelemetry = jest.fn();
jest.mock('pentacle-chat-core', () => ({
  ...jest.requireActual('pentacle-chat-core'),
  logTelemetry: (...args: unknown[]) => mockLogTelemetry(...args),
}));

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

const chat: PentacleChatListItem = {
  streamId: 'alpha:codex:freeze-fix',
  host: 'alpha',
  hostTitle: 'Alpha',
  provider: 'codex',
  sessionName: 'freeze-fix',
  title: 'Freeze fix triage',
  previewText: 'Reviewing event flow',
  status: 'idle',
  statusLabel: 'Idle',
  workingElapsedSeconds: null,
  sending: false,
  sendingImmediate: false,
  updatedLabel: '30s ago',
  draft: '',
};

function renderRow(overrides: Partial<Parameters<typeof ChatRow>[0]> = {}) {
  const onOpen = jest.fn();
  const onRename = jest.fn();
  const onDelete = jest.fn();
  const view = render(
    <ChatRow chat={chat} index={0} onOpen={onOpen} onRename={onRename} onDelete={onDelete} {...overrides} />,
  );
  return { view, onOpen, onRename, onDelete };
}

beforeEach(() => mockLogTelemetry.mockClear());

test('swipe rename action invokes onRename with the chat', () => {
  const { onRename, onDelete, onOpen } = renderRow();
  const close = jest.spyOn(screen.UNSAFE_getByType(Swipeable).instance, 'close');
  onRename.mockImplementation(() => expect(close).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByTestId('chat-row-rename-alpha-codex-freeze-fix'));
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenCalledWith(chat);
  expect(onDelete).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

test('swipe delete action invokes onDelete with the chat', () => {
  const { onDelete, onRename } = renderRow();
  const close = jest.spyOn(screen.UNSAFE_getByType(Swipeable).instance, 'close');
  onDelete.mockImplementation(() => expect(close).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByTestId('chat-row-delete-alpha-codex-freeze-fix'));
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(onDelete).toHaveBeenCalledWith(chat);
  expect(onRename).not.toHaveBeenCalled();
});

test('pressing the row body still opens the chat', () => {
  const { onOpen } = renderRow();
  fireEvent.press(screen.getByTestId('chat-row-alpha-codex-freeze-fix'));
  expect(onOpen).toHaveBeenCalledWith(chat.streamId);
});

test('swipe rename/delete never fires the priority CardAction', () => {
  const onToggle = jest.fn();
  const onOpenReports = jest.fn();
  renderRow({ onToggle, onOpenReports } as Partial<Parameters<typeof ChatRow>[0]>);

  fireEvent.press(screen.getByTestId('chat-row-rename-alpha-codex-freeze-fix'));
  fireEvent.press(screen.getByTestId('chat-row-delete-alpha-codex-freeze-fix'));

  expect(onToggle).not.toHaveBeenCalled();
  expect(onOpenReports).not.toHaveBeenCalled();
});

test('settled endpoints emit tagged open and closed telemetry', () => {
  renderRow();
  const swipeable = screen.UNSAFE_getByType(Swipeable);

  act(() => swipeable.props.onSwipeableOpen('right', swipeable.instance));
  act(() => swipeable.props.onSwipeableClose('right', swipeable.instance));

  expect(mockLogTelemetry).toHaveBeenNthCalledWith(1, 'chat:row_swipe_settled', expect.objectContaining({
    subsystem: 'chat_list',
    bug_ref: 'swipe_action_snap',
    state: 'open',
  }));
  expect(mockLogTelemetry).toHaveBeenNthCalledWith(2, 'chat:row_swipe_settled', expect.objectContaining({
    subsystem: 'chat_list',
    bug_ref: 'swipe_action_snap',
    state: 'closed',
  }));
});

test('parent-list gesture handoff forces the row closed', () => {
  const { view, onOpen, onRename, onDelete } = renderRow({ swipeSettleToken: 0 });
  const swipeable = screen.UNSAFE_getByType(Swipeable);
  const close = jest.spyOn(swipeable.instance, 'close');

  view.rerender(
    <ChatRow
      chat={chat}
      index={0}
      onOpen={onOpen}
      onRename={onRename}
      onDelete={onDelete}
      swipeSettleToken={1}
    />,
  );

  expect(close).toHaveBeenCalledTimes(1);
  act(() => swipeable.props.onSwipeableClose('right', swipeable.instance));
  expect(mockLogTelemetry).toHaveBeenCalledWith('chat:row_swipe_settled', expect.objectContaining({
    state: 'closed',
    reason: 'parent_scroll',
  }));
});
