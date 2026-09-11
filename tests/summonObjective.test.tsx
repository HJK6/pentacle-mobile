import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { OBJECTIVE_MAX_CODE_POINTS, validateSpawnObjective } from '../src/services/spawnObjective';

// The mobile new-chat sheet is an operator top-level spawn. Objectives are a child-agent
// concept surfaced on the parent's status-card roster, so the sheet collects none: submit is
// enabled once machine/provider/model are chosen, and the daemon derives the objective exactly
// as it does for desktop spawns. validateSpawnObjective is retained for the programmatic
// (harness/child) path that still passes an explicit objective.

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

test('the sheet renders no objective input and submit is enabled once machine/provider/model are chosen', async () => {
  await openConfigured();
  expect(screen.queryByTestId('summon-objective')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
});

test('a top-level spawn sends SpawnRequestV2 with no objective (daemon derives)', async () => {
  await openConfigured();
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc', provider: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh',
  })));
  // No objective flows from the sheet; the serializer then omits the wire key
  // (asserted against the real serializer in pentacleStream.spawnDiagnostics.test.ts).
  expect(mockActions.spawnSessionV2.mock.calls[0][0].objective).toBeUndefined();
});

test('a configured host outside the example palette can spawn using its exact identity', async () => {
  mockState.hosts = { local: { host: 'local', online: true, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-local'));
  await screen.findByTestId('summon-model-gpt-5.6-sol');
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({ host: 'local' })));
});

// Retained programmatic-objective validation (harness/child path). The UI no longer collects
// an objective, but a caller that passes one must still be validated the way the daemon measures.
describe('validateSpawnObjective (programmatic path)', () => {
  test('rejects an empty objective', () => {
    expect(validateSpawnObjective('   ').ok).toBe(false);
  });
  test('accepts a one-line objective and trims it', () => {
    expect(validateSpawnObjective('  Investigate the freeze  ')).toEqual({ ok: true, value: 'Investigate the freeze', error: null });
  });
  test('rejects a multi-line objective', () => {
    expect(validateSpawnObjective('line one\nline two').ok).toBe(false);
  });
  test('enforces the cap in code points, accepting exactly 120 astral emoji', () => {
    expect(validateSpawnObjective('😀'.repeat(OBJECTIVE_MAX_CODE_POINTS)).ok).toBe(true);
    expect(validateSpawnObjective('x'.repeat(OBJECTIVE_MAX_CODE_POINTS + 1)).ok).toBe(false);
  });
});
