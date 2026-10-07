import React from 'react';
import { Keyboard, Modal, PanResponder, ScrollView } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { initialPentacleStreamState } from 'pentacle-chat-core';
import { selectSmartChatList } from '../../../app/(tabs)/chats';
import ChatsDrawer from '../../../src/components/bart/ChatsDrawer';
import { resetChatOpenNavigationIntents } from '../../../src/services/chatOpenNavigationIntent';

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const close = jest.fn();
const newSession = jest.fn();
const chats = selectSmartChatList({ ...initialPentacleStreamState, connected: true, hasHydrated: true, sessions: [{
  stream_id: 'hostc:codex:drawer', host: 'hostc', provider: 'codex', session_name: 'drawer', title: 'Synthetic session',
  last_event_at: '2026-10-07T12:00:00Z', last_text: 'Synthetic preview', last_kind: 'ASSIST', draft: '', pending: false,
  working: false, online: true,
}] });
const groups = [{ title: 'NEEDS YOU' as const, chats }];
const draw = (open = true) => <ChatsDrawer open={open} groups={groups} canStart onClose={close} onNewSession={newSession} />;

beforeEach(() => { jest.useFakeTimers(); resetChatOpenNavigationIntents(); });
afterEach(() => resetChatOpenNavigationIntents());

test('drawer keeps approved row content, dimensions, and amber attention preview', () => {
  const view = render(draw());
  expect(view.getByText('Sessions')).toBeTruthy();
  expect(view.getByText('NEEDS YOU · 1')).toBeTruthy();
  expect(view.getByText('Synthetic session')).toHaveStyle({ fontSize: 15.5 });
  expect(view.getByText('Synthetic preview')).toHaveStyle({ fontSize: 12.5, color: '#ffb53d' });
  expect(view.getByText('Synthetic preview').props.numberOfLines).toBe(1);
  expect(view.getByTestId('bart-drawer-panel')).toHaveStyle({ width: '86%', backgroundColor: '#0d1411' });
  expect(view.getByLabelText('New session')).toHaveStyle({ width: 32, height: 32, backgroundColor: '#3dff66' });
  expect(view.queryByText('✕')).toBeNull();
});

test('scrim and system back close the drawer; completed exit removes it and reopening works', () => {
  const view = render(draw());
  fireEvent.press(view.getByLabelText('Close sessions'));
  expect(close).toHaveBeenCalledTimes(1);
  act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(close).toHaveBeenCalledTimes(2);
  view.rerender(draw(false));
  act(() => jest.advanceTimersByTime(400));
  expect(view.queryByText('Sessions')).toBeNull();
  view.rerender(draw());
  act(() => jest.advanceTimersByTime(400));
  expect(view.getByText('Sessions')).toBeTruthy();
});

test('swipe capture respects vertical scrolling and requires strictly more than 50px left', () => {
  const create = jest.spyOn(PanResponder, 'create');
  render(draw());
  const pan = create.mock.calls[0][0];
  const gesture = (dx: number, dy = 0) => ({ dx, dy } as any);
  expect(pan.onMoveShouldSetPanResponder?.({} as any, gesture(-20, 60))).toBe(false);
  expect(pan.onMoveShouldSetPanResponder?.({} as any, gesture(-20))).toBe(true);
  act(() => pan.onPanResponderRelease?.({} as any, gesture(-50)));
  expect(close).not.toHaveBeenCalled();
  act(() => pan.onPanResponderRelease?.({} as any, gesture(-51)));
  expect(close).toHaveBeenCalledTimes(1);
  create.mockRestore();
});

test('row dispatch is duplicate-safe and closes before pushing; plus opens the supplied flow once', () => {
  const view = render(draw());
  const row = view.getByTestId('bart-drawer-row-hostc:codex:drawer');
  fireEvent.press(row);
  fireEvent.press(row);
  const router = require('expo-router').router;
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Adrawer');
  expect(close).toHaveBeenCalledTimes(1);
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(router.push.mock.invocationCallOrder[0]);
  fireEvent.press(view.getByLabelText('New session'));
  fireEvent.press(view.getByLabelText('New session'));
  expect(newSession).not.toHaveBeenCalled();
  view.rerender(draw(false));
  act(() => jest.advanceTimersByTime(400));
  act(() => view.UNSAFE_getByType(Modal).props.onDismiss());
  expect(newSession).toHaveBeenCalledTimes(1);
});


test('opening dismisses the composer keyboard and lets a row handle the first tap', () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const view = render(draw());
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(view.UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');
  fireEvent.press(view.getByTestId('bart-drawer-row-hostc:codex:drawer'));
  expect(require('expo-router').router.push).toHaveBeenCalledTimes(1);
  dismiss.mockRestore();
});


test('plus is disabled when the shared flow cannot start', () => {
  const view = render(<ChatsDrawer open groups={groups} canStart={false} onClose={close} onNewSession={newSession} />);
  expect(view.getByLabelText('New session')).toBeDisabled();
  fireEvent.press(view.getByLabelText('New session'));
  expect(close).not.toHaveBeenCalled();
  expect(newSession).not.toHaveBeenCalled();
});
