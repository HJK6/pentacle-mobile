import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';

let mockState: any;
const mockAlert = jest.fn();
const mockActions = {
  spawnSession: jest.fn(),
  spawnSessionV2: jest.fn(),
  getSpawnCatalog: jest.fn(),
  reconnect: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  resolveNotification: jest.fn(),
  answerPrompt: jest.fn(),
  dismissQuestion: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
};

const spawnCatalog = {
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: {
    desktop_manual: {
      claude: ['claude-opus-4-8', 'high'],
      codex: ['gpt-5.6-sol', 'high'],
    },
  },
  models: {
    claude: {
      'claude-opus-4-8': { aliases: ['opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      'claude-opus-5': { aliases: ['opus-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      'claude-sonnet-5': { aliases: ['sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      'claude-fable-5': { aliases: ['fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    },
    codex: {
      'gpt-5.6-terra': { aliases: ['terra'], efforts: ['low', 'medium', 'high', 'xhigh'] },
      'gpt-5.6-sol': { aliases: ['sol'], efforts: ['low', 'medium', 'high', 'xhigh'] },
    },
  },
};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Alert') return { alert: mockAlert };
      return target[prop as keyof typeof target];
    },
  });
});
// Host sigils resolve from configured hosts (src/config/local.getHostMachineName);
// the stub's default hostOrder (['hosta','hostb','hostc']) skins each placeholder host
// to its positional machine, so the roster button for host 'hostc' is labeled 'hostc'.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
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

const statusCard = { goal: 'Track the batch', updated_at: '2026-07-11T11:00:00.000Z' };

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [],
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
  mockActions.spawnSession.mockResolvedValue({ stream_id: 'hostc:claude:new' });
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:codex:new' } });
  mockActions.getSpawnCatalog.mockResolvedValue(spawnCatalog);
});

afterEach(() => {
  jest.useRealTimers();
});

// --- List states ------------------------------------------------------------

test('initial hydration shows the summoning copy', () => {
  mockState.hasHydrated = false;
  mockState.connecting = true;
  render(<ChatsScreen />);
  expect(screen.getByText('SUMMONING CHATS…')).toBeTruthy();
});

test('hydrated empty shows summon guidance', () => {
  render(<ChatsScreen />);
  expect(screen.getByText('No sessions yet')).toBeTruthy();
  expect(screen.getByText('Summon an agent on a live machine to begin a transcript.')).toBeTruthy();
});

test('unreachable with no sessions shows a retry affordance', async () => {
  jest.useFakeTimers();
  mockState.hasHydrated = false;
  mockState.connecting = false;
  mockState.lastError = 'dial tcp: no route to host';
  render(<ChatsScreen />);

  expect(screen.getByTestId('chats-unreachable')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('chats-retry'));
  });
  expect(mockActions.reconnect).toHaveBeenCalledTimes(1);
  act(() => {
    jest.advanceTimersByTime(700);
  });
});

test('a connection error with populated sessions preserves the list non-destructively', () => {
  mockState.sessions = [session('hostc:claude:kept', 'Kept session')];
  mockState.lastError = 'stream dropped';
  render(<ChatsScreen />);

  expect(screen.getByText('Kept session')).toBeTruthy();
  expect(screen.getByTestId('chats-error-banner')).toBeTruthy();
  expect(screen.queryByTestId('chats-unreachable')).toBeNull();
});

// --- Deterministic expansion resets ------------------------------------------

test('changing the roster filter collapses the open expansion', () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 1 } };
  mockState.sessions = [session('hostc:claude:status', 'Status session', { status_card: statusCard })];
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-claude-status'));
  expect(screen.getByTestId('card-status-mini-hostc:claude:status')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('hostc online'));
  expect(screen.queryByTestId('card-status-mini-hostc:claude:status')).toBeNull();
});

test('opening a session collapses the open expansion', () => {
  mockState.sessions = [session('hostc:claude:status', 'Status session', { status_card: statusCard })];
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-claude-status'));
  fireEvent.press(screen.getByTestId('chat-row-hostc-claude-status'));
  expect(screen.queryByTestId('card-status-mini-hostc:claude:status')).toBeNull();
});

// --- Summon flow --------------------------------------------------------------

test('summon sends the selected catalog model and effort through the complete V2 action', async () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-provider-codex');
  fireEvent.press(screen.getByTestId('summon-model-gpt-5.6-terra'));
  await waitFor(() => expect(screen.getByTestId('summon-model-gpt-5.6-terra').props.accessibilityState?.selected).toBe(true));
  fireEvent.press(screen.getByTestId('summon-effort-xhigh'));
  // A top-level operator spawn carries no objective; the daemon derives it.
  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith({
    host: 'hostc',
    provider: 'codex',
    model: 'gpt-5.6-terra',
    effort: 'xhigh',
    spawnProfile: 'desktop_manual',
    catalogVersion: 'spawn-catalog-v1',
    resolutionSource: 'explicit_override',
    // One client intent id per submission; its rules are covered in tests/spawnIntent.test.ts.
    idempotencyKey: expect.any(String),
  }));
  // No objective flows from the top-level sheet (the serializer then omits the wire key —
  // see tests/summonObjective.test.tsx for the SpawnRequestV2 wire contract).
  expect(mockActions.spawnSessionV2.mock.calls[0][0].objective).toBeUndefined();
  expect(mockActions.spawnSession).not.toHaveBeenCalled();
  expect(require('expo-router').router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Anew');
});

test('summon picker offers every catalog model with short display labels', async () => {
  // Parity with the desktop picker: the mobile summon list is catalog-driven, so all four Claude
  // models the daemon serves (opus-4-8, opus-5, sonnet-5, fable-5) are selectable, and their labels
  // read identically to desktop ("Opus 4.8"/"Opus 5"/"Sonnet 5"/"Fable 5") — no lowercase drift.
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  // Wait for the catalog to load (its effect defaults the provider to codex) before switching,
  // otherwise the async catalog effect would overwrite an early provider press back to codex.
  await screen.findByTestId('summon-model-gpt-5.6-sol');
  expect(screen.getByTestId('summon-model-gpt-5.6-sol')).toHaveTextContent('5.6 Sol');
  fireEvent.press(screen.getByTestId('summon-provider-claude'));

  for (const model of ['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
    await screen.findByTestId(`summon-model-${model}`);
  }
  expect(screen.getByText('Opus 4.8')).toBeTruthy();
  expect(screen.getByText('Opus 5')).toBeTruthy();
  expect(screen.getByText('Sonnet 5')).toBeTruthy();
  expect(screen.getByText('Fable 5')).toBeTruthy();

  // The full effort range for a Claude-5 model is offered.
  fireEvent.press(screen.getByTestId('summon-model-claude-opus-5'));
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    await screen.findByTestId(`summon-effort-${effort}`);
  }
});

test('an in-flight summon disables duplicate submits', async () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  let resolveSpawn: (value: { stream_id: string }) => void = () => {};
  mockActions.spawnSessionV2.mockImplementation(
    () => new Promise((resolve) => { resolveSpawn = resolve; }),
  );
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-submit');
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  fireEvent.press(screen.getByTestId('summon-submit'));

  const fab = screen.getByTestId('new-chat-button');
  expect(fab.props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(fab);
  expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveSpawn({ session: { stream_id: 'hostc:codex:new' } } as unknown as { stream_id: string });
  });
  expect(screen.getByTestId('new-chat-button').props.accessibilityState?.disabled).not.toBe(true);
});

test('a failed V2 summon keeps the modal and selected tuple retryable', async () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  mockActions.spawnSessionV2.mockRejectedValueOnce(new Error('spawn refused'));
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-submit');
  fireEvent.press(screen.getByTestId('summon-model-gpt-5.6-terra'));
  await waitFor(() => expect(screen.getByTestId('summon-model-gpt-5.6-terra').props.accessibilityState?.selected).toBe(true));
  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  expect(await screen.findByTestId('summon-submit-error')).toHaveTextContent('spawn refused');
  expect(screen.getByTestId('summon-model-gpt-5.6-terra').props.accessibilityState?.selected).toBe(true);
  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });
  expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(2);
});

test('a malformed catalog surfaces recovery and never enables V2 submit', async () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  mockActions.getSpawnCatalog.mockResolvedValue({
    ...spawnCatalog,
    profiles: { desktop_manual: { ...spawnCatalog.profiles.desktop_manual, codex: ['missing-model', 'high'] } },
  });
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(await screen.findByTestId('summon-catalog-error')).toHaveTextContent(/incomplete/i);
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('summon-submit'));
  expect(mockActions.spawnSessionV2).not.toHaveBeenCalled();
});

test('catalog conflict invalidates stale submit until one refresh completes', async () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } };
  let resolveRefresh: (catalog: typeof spawnCatalog) => void = () => {};
  mockActions.getSpawnCatalog
    .mockResolvedValueOnce(spawnCatalog)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  const conflict = Object.assign(new Error('Refresh catalog'), { errorCode: 'spawn_catalog_version_conflict' });
  mockActions.spawnSessionV2.mockRejectedValueOnce(conflict);
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => fireEvent.press(screen.getByTestId('summon-submit')));

  expect(await screen.findByTestId('summon-catalog-loading')).toBeTruthy();
  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('summon-submit'));
  expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(1);

  await act(async () => resolveRefresh({ ...spawnCatalog, catalog_version: 'spawn-catalog-v2' }));
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => fireEvent.press(screen.getByTestId('summon-submit')));
  expect(mockActions.spawnSessionV2).toHaveBeenNthCalledWith(2, expect.objectContaining({ catalogVersion: 'spawn-catalog-v2' }));
});

test('the FAB is disabled when no machine is online and offline machines are disabled in the grid', () => {
  mockState.hosts = { hostc: { host: 'hostc', online: false, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);

  const fab = screen.getByTestId('new-chat-button');
  expect(fab.props.accessibilityState?.disabled).toBe(true);
  expect(fab.props.accessibilityLabel).toBe('Start agent');
});

test('an online machine renders its grid entry enabled and offline peers disabled', () => {
  mockState.hosts = { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 }, hosta: { host: 'hosta', online: false, checked_at: '', session_count: 0 } };
  render(<ChatsScreen />);

  fireEvent.press(screen.getByTestId('new-chat-button'));
  expect(screen.getByTestId('summon-machine-hostc').props.accessibilityState?.disabled).not.toBe(true);
  expect(screen.getByTestId('summon-machine-hosta').props.accessibilityState?.disabled).toBe(true);
});
