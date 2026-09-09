import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import {
  acknowledgeChatRowNavigationIntent,
  resetChatOpenNavigationIntents,
} from '../src/services/chatOpenNavigationIntent';

// Navigation contract:
// "open chat A -> back to the list -> tap A again" must open the same session.
// These drive the screen and its coordinator singleton; nothing here
// depends on a test-only reset between the presses under test.

let mockIsFocused = true;
const mockActions = {
  spawnSession: jest.fn(),
  reconnect: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  resolveNotification: jest.fn(),
  answerPrompt: jest.fn(),
  dismissQuestion: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
};
let mockState: any;

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
}));
jest.mock('../src/services/pentacleAssets', () => ({
  useSessionReports: () => [],
  reportUnreadCount: () => 0,
  listReports: jest.fn(),
  isReportSessionClosed: () => false,
}));

const STREAM = 'hostc:claude:reopen';
const ROW_SID = 'hostc-claude-reopen';
const HREF = `/pentacle/session/${encodeURIComponent(STREAM)}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFocused = true;
  resetChatOpenNavigationIntents();
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [{
      stream_id: STREAM,
      host: 'hostc',
      provider: 'claude',
      session_name: 'reopen',
      title: 'Reopen session',
      last_event_at: '2026-08-30T12:00:00.000Z',
      last_text: 'Reopen preview',
      last_kind: 'ASSIST',
      online: true,
    }],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation(
    (_enabled: boolean, selector: (state: unknown) => unknown) => selector(mockState),
  );
});

afterEach(() => {
  resetChatOpenNavigationIntents();
});

// Blur then re-focus the Chats list, exactly as a push to the session screen and
// a back gesture do.
function leaveAndReturnToList(rerender: (ui: React.ReactElement) => void) {
  mockIsFocused = false;
  rerender(<ChatsScreen />);
  mockIsFocused = true;
  rerender(<ChatsScreen />);
}

test('tapping the same chat again after visiting it navigates again', () => {
  const { router } = require('expo-router');
  const { rerender } = render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));
  expect(router.push).toHaveBeenCalledTimes(1);
  // Destination screen's focus effect acknowledges the intent, completing it.
  // (Production runs with the NOOP paint sink, so there is no correlation id to
  // hand back here — the ack's job in this path is completing the intent.)
  acknowledgeChatRowNavigationIntent(STREAM);

  leaveAndReturnToList(rerender);
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));

  expect(router.push).toHaveBeenCalledTimes(2);
  expect(router.push).toHaveBeenNthCalledWith(1, HREF);
  expect(router.push).toHaveBeenNthCalledWith(2, HREF);
});

test('returning to the list releases an intent the destination never acknowledged', () => {
  const { router } = require('expo-router');
  const { rerender } = render(<ChatsScreen />);

  // No ack at all — e.g. the user backed out before the session screen focused.
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));
  expect(router.push).toHaveBeenCalledTimes(1);

  leaveAndReturnToList(rerender);
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));

  expect(router.push).toHaveBeenCalledTimes(2);
});

test('a rapid double-tap on one row still navigates exactly once', () => {
  const { router } = require('expo-router');
  render(<ChatsScreen />);

  // Both taps land while the list is still focused and the intent is in flight —
  // no blur, no ack — which is the window the coordinator suppresses.
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));

  expect(router.push).toHaveBeenCalledTimes(1);
});
