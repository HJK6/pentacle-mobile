import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SessionScreen from '../../../app/pentacle/session/[streamId]';
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../../src/services/pentacleStream';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: any;
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(() => 'optimistic_hostc_codex_one_1'),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_hostc_codex_one_1'),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  retryPendingClose: jest.fn(),
  cancelPendingClose: jest.fn(),
  forcePendingClose: jest.fn(),
  renameSession: jest.fn(),
};
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});
let mockReports = [
  { asset_id: 'report-1', title: 'Report', content_type: 'report', read: false, read_at: null },
];
const mockListReports = jest.fn().mockResolvedValue(mockReports);

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
  const mock = require('../../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/components/ReportViewerModal', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return ({ visible }: { visible: boolean }) => visible ? React.createElement(Text, { testID: 'mock-report-viewer' }, 'Reports') : null;
});
jest.mock('../../../src/services/pentacleAssets', () => ({
  listReports: (...args: unknown[]) => mockListReports(...args),
  reportUnreadCount: () => mockReports.filter((report) => report.read !== true && !report.read_at).length,
  useSessionReports: () => mockReports,
}));
jest.mock('../../../src/services/pentacleStream', () => ({
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
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      title: 'Migration plan',
      last_event_at: '2026-05-08T00:00:00Z',
      last_text: 'Previous answer',
      last_kind: 'ASSIST',
      online: true,
    }],
    drafts: {},
    events: [],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  mockActions.closeSession.mockResolvedValue(undefined);
  mockActions.retryPendingClose.mockResolvedValue(true);
  mockActions.cancelPendingClose.mockResolvedValue(true);
  mockActions.forcePendingClose.mockResolvedValue({ closed: true });
  mockActions.renameSession.mockResolvedValue(undefined);
  mockReports = [{ asset_id: 'report-1', title: 'Report', content_type: 'report', read: false, read_at: null }];
  mockListReports.mockClear();
});

test('kebab opens an action menu with Rename and Delete', () => {
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));

  expect(screen.getByTestId('chat-action-rename')).toBeTruthy();
  expect(screen.getByTestId('chat-action-delete')).toBeTruthy();
  expect(screen.queryByText('Chat options')).toBeNull();
});

test('report inventory drives the header badge and Reports overflow row', () => {
  render(<SessionScreen />);
  expect(screen.getByTestId('session-report-unread-badge')).toHaveTextContent('1');
  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  expect(screen.getByTestId('chat-action-reports')).toBeTruthy();
  expect(screen.getByText('1 from child agents · 1 unread')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-action-reports'));
  expect(screen.getByTestId('mock-report-viewer')).toBeTruthy();
});

test('Rename → modal → Save calls renameSession with the new display name', async () => {
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  fireEvent.press(screen.getByTestId('chat-action-rename'));

  fireEvent.changeText(screen.getByTestId('rename-chat-input'), 'Renamed plan');
  await act(async () => {
    fireEvent.press(screen.getByTestId('rename-chat-save'));
  });

  await waitFor(() =>
    expect(mockActions.renameSession).toHaveBeenCalledWith({
      host: 'hostc',
      sessionName: 'one',
      displayName: 'Renamed plan',
    }),
  );
});

test('Rename Save is a no-op when the name is unchanged', async () => {
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  fireEvent.press(screen.getByTestId('chat-action-rename'));
  // value is prefilled with the current title; Save should be disabled / no-op.
  await act(async () => {
    fireEvent.press(screen.getByTestId('rename-chat-save'));
  });

  expect(mockActions.renameSession).not.toHaveBeenCalled();
});

test('Delete → confirm calls closeSession and returns to chats', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  fireEvent.press(screen.getByTestId('chat-action-delete'));

  // Confirm dialog presented; fire its destructive action.
  expect(alertSpy).toHaveBeenCalled();
  const buttons = alertSpy.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>;
  const confirm = buttons.find((b) => b.text === 'Delete');
  expect(confirm).toBeTruthy();
  await act(async () => {
    confirm?.onPress?.();
  });

  await waitFor(() =>
    expect(mockActions.closeSession).toHaveBeenCalledWith({
      host: 'hostc',
      sessionName: 'one',
      streamId: 'hostc:codex:one',
    }),
  );
  alertSpy.mockRestore();
});

test('first delete of an offline host surfaces the offline state and Force delete immediately', async () => {
  mockActions.closeSession.mockRejectedValueOnce(Object.assign(new Error('ssh_unreachable'), { errorCode: 'ssh_unreachable' }));
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  fireEvent.press(screen.getByTestId('chat-action-delete'));
  const confirm = (alertSpy.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>).find((b) => b.text === 'Delete');
  await act(async () => { await confirm?.onPress?.(); });

  // The rejection is not shown as a raw error; the second alert is the honest offline prompt.
  const offline = alertSpy.mock.calls[1];
  expect(String(offline[0])).toMatch(/is offline$/);
  const buttons = offline[2] as Array<{ text?: string; onPress?: () => void }>;
  expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Force delete']);
  await act(async () => { buttons.find((b) => b.text === 'Force delete')?.onPress?.(); });
  expect(mockActions.forcePendingClose).toHaveBeenCalledWith('hostc:codex:one');
  alertSpy.mockRestore();
});

test('a stalled pending delete exposes Retry, Cancel, and Force actions on the detail screen', async () => {
  mockState.sessions[0].pending_close = {
    streamId: 'hostc:codex:one', host: 'hostc', sessionName: 'one', requestId: 'close-1',
    requestedAt: Date.now() - 10 * 60_000, attempt: 6, nextAttemptAt: 0,
    state: 'exhausted', errorCode: 'retry_exhausted', errorMessage: 'Automatic retries expired.',
  };
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<SessionScreen />);

  fireEvent.press(screen.getByTestId('session-header-menu-button'));
  fireEvent.press(screen.getByTestId('chat-action-delete'));

  expect(alertSpy).toHaveBeenCalledWith(
    'Delete stalled',
    'Automatic retries expired.',
    expect.any(Array),
  );
  const buttons = alertSpy.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>;
  expect(buttons.map((button) => button.text)).toEqual(['Retry', 'Cancel delete', 'Force delete']);
  await act(async () => {
    buttons.forEach((button) => button.onPress?.());
  });
  expect(mockActions.retryPendingClose).toHaveBeenCalledWith('hostc:codex:one');
  expect(mockActions.cancelPendingClose).toHaveBeenCalledWith('hostc:codex:one');
  expect(mockActions.forcePendingClose).toHaveBeenCalledWith('hostc:codex:one');
  expect(mockActions.closeSession).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});
