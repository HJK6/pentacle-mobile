import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';

let mockState: any;
const mockActions = {
  spawnSession: jest.fn(),
  reconnect: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  resolveNotification: jest.fn(),
  dismissQuestion: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
  readThread: jest.fn(),
  answerPrompt: jest.fn(),
};

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
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

const STREAM = 'hostc:claude:status';
const ROW_SID = 'hostc-claude-status';

function session(streamId: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    stream_id: streamId,
    host: 'hostc',
    provider: 'claude',
    session_name: streamId.split(':').at(-1) || streamId,
    title,
    last_event_at: '2026-07-11T12:00:00.000Z',
    last_text: `${title} preview`,
    last_kind: 'ASSIST',
    online: true,
    ...overrides,
  };
}

const statusCard = {
  goal: 'Ship the batch integration',
  plan: [
    { text: 'merge branches', status: 'done' },
    { text: 'implement chat list', status: 'active' },
  ],
  update: 'container underway',
  updated_at: '2026-07-11T11:55:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [session(STREAM, 'Status session', { status_card: statusCard })],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled: boolean, selector: (state: unknown) => unknown) => selector(mockState));
});

test('caret toggles CardStatusMini inline and never mounts StatusOverlay in the container', () => {
  render(<ChatsScreen />);
  const action = screen.getByTestId(`chat-row-toggle-${ROW_SID}`);
  expect(action.props.accessibilityLabel).toBe('Expand chat row');

  fireEvent.press(action);
  expect(screen.getByTestId(`card-status-mini-${STREAM}`)).toBeTruthy();
  expect(screen.getByText('Ship the batch integration')).toBeTruthy();
  expect(screen.queryByTestId('status-overlay')).toBeNull();

  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  expect(screen.queryByTestId(`card-status-mini-${STREAM}`)).toBeNull();
});

test('pressing the mini clears expansion and navigates with one-shot openStatus=1', () => {
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  fireEvent.press(screen.getByTestId(`card-status-mini-${STREAM}`));

  expect(require('expo-router').router.push).toHaveBeenCalledWith({
    pathname: '/pentacle/session/[streamId]',
    params: { streamId: STREAM, openStatus: '1' },
  });
  expect(screen.queryByTestId(`card-status-mini-${STREAM}`)).toBeNull();
  expect(screen.queryByTestId('status-overlay')).toBeNull();
});

test('expansion is mutually exclusive across rows and resets when the row leaves the list', () => {
  mockState.sessions = [
    session(STREAM, 'Status session', { status_card: statusCard }),
    session('hostc:claude:other', 'Other status', { status_card: statusCard }),
  ];
  const rendered = render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  expect(screen.getByTestId(`card-status-mini-${STREAM}`)).toBeTruthy();

  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-claude-other'));
  expect(screen.queryByTestId(`card-status-mini-${STREAM}`)).toBeNull();
  expect(screen.getByTestId('card-status-mini-hostc:claude:other')).toBeTruthy();

  mockState.sessions = [session(STREAM, 'Status session', { status_card: statusCard })];
  rendered.rerender(<ChatsScreen />);
  expect(screen.queryByTestId('card-status-mini-hostc:claude:other')).toBeNull();
  expect(screen.queryByTestId(`card-status-mini-${STREAM}`)).toBeNull();
});

test('row body press still opens the session while a mini is expanded', () => {
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  fireEvent.press(screen.getByTestId(`chat-row-${ROW_SID}`));

  expect(require('expo-router').router.push).toHaveBeenCalledWith(
    `/pentacle/session/${encodeURIComponent(STREAM)}`,
  );
});

test('an expanded parent row exposes child status and enters the shared status/history stack', async () => {
  const childStreamId = 'hostc:codex:child';
  mockState.sessions = [session(STREAM, 'Parent session', {
    role: 'nexus',
    agents: [{
      stream_id: childStreamId,
      session_generation: 'child-generation',
      display_name: 'Implementation child',
      role: 'worker',
      objective: 'Render the history surface',
      state: 'blocked',
      model: 'gpt-5.6-luna',
      since: '2026-09-08T12:00:00.000Z',
    }],
  })];
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  expect(screen.getByTestId(`agent-status-row-${childStreamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`)).toBeTruthy();

  fireEvent.press(screen.getByTestId(`agent-thread-open-${childStreamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`));
  expect(require('expo-router').router.push).toHaveBeenCalledWith({
    pathname: '/pentacle/session/[streamId]',
    params: { streamId: STREAM, openStatus: '1', agentHistory: childStreamId, agentHistoryGeneration: 'child-generation' },
  });
});

test('the parent roster is role-gated and the no-card parent row still has a reachable status surface', () => {
  const child = {
    stream_id: 'hostc:codex:child', session_generation: 'child-generation', display_name: 'Child',
    role: 'worker', objective: null, state: 'working', model: 'gpt-5.6-luna', since: null,
  };
  mockState.sessions = [session(STREAM, 'Worker parent', { role: 'worker', agents: [child] })];
  const rendered = render(<ChatsScreen />);
  expect(screen.getByTestId(`chat-row-toggle-${ROW_SID}`).props.accessibilityState).toEqual({ disabled: true });
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  expect(screen.queryByTestId(`agent-status-rows-${ROW_SID}`)).toBeNull();

  mockState.sessions = [session(STREAM, 'Parent without children', { role: 'nexus', agents: [] })];
  rendered.rerender(<ChatsScreen />);
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  expect(screen.getByTestId(`nexus-status-unavailable-${ROW_SID}`)).toBeTruthy();
});

test('a chat history entry passes the exact direct-child generation to the shared status/history stack', async () => {
  const childStreamId = 'hostc:codex:child';
  const child = {
    stream_id: childStreamId, session_generation: 'child-generation', display_name: 'Child',
    role: 'worker', objective: null, state: 'working', model: 'gpt-5.6-luna', since: null,
  };
  mockState.sessions = [session(STREAM, 'Parent', { role: 'nexus', session_generation: 'parent-generation', agents: [child] })];
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId(`chat-row-toggle-${ROW_SID}`));
  fireEvent.press(screen.getByTestId(`agent-thread-open-${childStreamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`));
  expect(require('expo-router').router.push).toHaveBeenCalledWith(expect.objectContaining({
    params: expect.objectContaining({ agentHistory: childStreamId, agentHistoryGeneration: 'child-generation' }),
  }));
});
