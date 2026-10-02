import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';

// Operator dispatch 7c2717e4 + PR#53 available_models: the mobile summon picker
// must OFFER only the models the daemon lists in catalog.available_models (an
// installation/daemon-config subset of the full models catalog), IN THAT LIST
// ORDER, while staying display-only — never gating a valid default/explicit
// tuple. Mirrors the web catalogForNewSession swap.

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

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const def = (aliases: string[]) => ({ aliases, efforts: EFFORTS });

// Full catalog in MODELS declaration order; available_models narrows + reorders.
const baseCatalog = () => ({
  schema_version: 'CatalogV1' as const,
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-6-luna', 'high'] } },
  models: {
    claude: {
      'claude-opus-4-8': def(['opus']),
      'claude-opus-5-5': def(['opus-5.5']),
      'claude-sonnet-5-5': def(['sonnet']),
      'claude-fable-5-1': def(['fable']),
    },
    codex: {
      'gpt-5.6-terra': def(['terra']),
      'gpt-5.6-sol': def([]),
      'gpt-6-sol': def([]),
      'gpt-6.1-sol': def(['sol']),
      'gpt-6-luna': def(['luna']),
      'gpt-6-astra': def(['astra']),
    },
  },
});

// Fleet-order narrowing: Codex Luna 6, Sol 6.1, Astra 6; Claude Opus 4.8, Opus 5.5, Fable 5.1.
const withAvailableModels = () => ({
  ...baseCatalog(),
  available_models: {
    codex: { 'gpt-6-luna': def(['luna']), 'gpt-6.1-sol': def(['sol']), 'gpt-6-astra': def(['astra']) },
    claude: { 'claude-opus-4-8': def(['opus']), 'claude-opus-5-5': def(['opus-5.5']), 'claude-fable-5-1': def(['fable']) },
  },
});

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
});

async function openPicker() {
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
}

function modelChipOrder(): string[] {
  return screen.getAllByTestId(/^summon-model-/).map((node) => String(node.props.testID).replace('summon-model-', ''));
}

test('picker offers only available_models for Codex, in config list order (operator 7c2717e4)', async () => {
  mockActions.getSpawnCatalog.mockResolvedValue(withAvailableModels());
  await openPicker();
  await screen.findByTestId('summon-model-gpt-6-luna');
  // Order follows the config list, not the full-catalog order.
  expect(modelChipOrder()).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
  // Hidden models are absent from the picker.
  expect(screen.queryByTestId('summon-model-gpt-5.6-terra')).toBeNull();
  expect(screen.queryByTestId('summon-model-gpt-6-sol')).toBeNull();
});

test('picker offers only available_models for Claude, in config list order, Fable visible', async () => {
  mockActions.getSpawnCatalog.mockResolvedValue(withAvailableModels());
  await openPicker();
  // Wait for the catalog to settle (codex chips present) before switching
  // provider — the catalog-load effect re-seeds the default provider until then.
  await screen.findByTestId('summon-model-gpt-6-luna');
  fireEvent.press(screen.getByTestId('summon-provider-claude'));
  await screen.findByTestId('summon-model-claude-opus-4-8');
  expect(modelChipOrder()).toEqual(['claude-opus-4-8', 'claude-opus-5-5', 'claude-fable-5-1']);
  expect(screen.queryByTestId('summon-model-claude-sonnet-5-5')).toBeNull();
});

test('absent available_models shows the full catalog (shipped public default)', async () => {
  mockActions.getSpawnCatalog.mockResolvedValue(baseCatalog());
  await openPicker();
  await screen.findByTestId('summon-model-gpt-6-luna');
  // Full catalog order (MODELS declaration order), hidden nothing.
  expect(modelChipOrder()).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
});

test('a hidden profile default never gates submission — falls back to first visible model', async () => {
  // Installation hides its own profile default (gpt-6-sol) from the picker.
  const catalog = withAvailableModels();
  catalog.profiles.desktop_manual.codex = ['gpt-6-sol', 'high'];
  mockActions.getSpawnCatalog.mockResolvedValue(catalog);
  await openPicker();
  await screen.findByTestId('summon-model-gpt-6-luna');
  // The hidden default is not offered…
  expect(screen.queryByTestId('summon-model-gpt-6-sol')).toBeNull();
  // …and submit is still enabled (no dead-end) and sends the first visible model.
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc', provider: 'codex', model: 'gpt-6-luna',
  })));
});
