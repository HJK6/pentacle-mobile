import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';

// The live daemon (window A, SpawnRequestV2 objective cutover) refuses an objective-less
// spawn with objective_required. Mobile must collect a required one-line objective
// (1–120 code points), block submit before it is valid with a local explanation, and
// serialize it on SpawnRequestV2. question_free_text_contract.

let mockState: any;
const mockActions = {
  spawnSession: jest.fn(),
  spawnSessionV2: jest.fn(),
  getSpawnCatalog: jest.fn(),
  reconnect: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  resolveNotification: jest.fn(),
  dismissQuestion: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
};

const spawnCatalog = {
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-5.6-sol', 'high'] } },
  models: {
    claude: { 'claude-opus-4-8': { aliases: ['opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    codex: { 'gpt-5.6-terra': { aliases: ['terra'], efforts: ['low', 'medium', 'high', 'xhigh'] }, 'gpt-5.6-sol': { aliases: ['sol'], efforts: ['low', 'medium', 'high', 'xhigh'] } },
  },
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

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    connected: true, connecting: false, hasHydrated: true, lastError: undefined,
    hosts: { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } },
    sessions: [], drafts: {}, events: [], machineStats: {}, updates: [], notifications: [], workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_e: boolean, selector: (s: unknown) => unknown) => selector(mockState));
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:codex:new' } });
  mockActions.getSpawnCatalog.mockResolvedValue(spawnCatalog);
});

async function openConfigured() {
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-model-gpt-5.6-terra');
  fireEvent.press(screen.getByTestId('summon-model-gpt-5.6-terra'));
  fireEvent.press(screen.getByTestId('summon-effort-xhigh'));
}

test('submit is blocked until a non-empty objective is entered', async () => {
  await openConfigured();
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
  fireEvent.changeText(screen.getByTestId('summon-objective'), '   ');
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
});

test('a valid objective enables submit and is serialized on SpawnRequestV2', async () => {
  await openConfigured();
  fireEvent.changeText(screen.getByTestId('summon-objective'), 'Investigate the freeze regression on chat open');
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc', provider: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh',
    objective: 'Investigate the freeze regression on chat open',
  })));
});

test('an over-cap objective (121 code points) blocks submit with a local explanation', async () => {
  await openConfigured();
  fireEvent.changeText(screen.getByTestId('summon-objective'), 'x'.repeat(121));
  expect(screen.getByTestId('summon-objective-error')).toBeTruthy();
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
});

test('exactly 120 code points of astral emoji is accepted (code points, not UTF-16 units)', async () => {
  await openConfigured();
  fireEvent.changeText(screen.getByTestId('summon-objective'), '😀'.repeat(120));
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
});

test('a multi-line objective is rejected (single line only)', async () => {
  await openConfigured();
  fireEvent.changeText(screen.getByTestId('summon-objective'), 'line one\nline two');
  expect(screen.getByTestId('summon-objective-error')).toBeTruthy();
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
});


test('a configured host outside the example palette can spawn using its exact identity', async () => {
  mockState.hosts = { local: { host: 'local', online: true, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-local'));
  await screen.findByTestId('summon-model-gpt-5.6-sol');
  fireEvent.changeText(screen.getByTestId('summon-objective'), 'Verify the public client');
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({host: 'local'})));
});
