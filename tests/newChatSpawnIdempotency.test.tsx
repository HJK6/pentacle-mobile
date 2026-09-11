// Regression coverage for public-test-spec:
// One user intent to start a chat must create exactly one chat.
//
// Several native taps can land in the same React commit window. Wrapping the presses in one
// `act` models that window: no commit happens between them, so every handler sees the stale
// `spawning === null` / `disabled=false` view.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen from '../app/(tabs)/chats';
import SummonModal from '../src/components/SummonModal';
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
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: { 'hostc': { host: 'hostc', online: true, checked_at: '', session_count: 0 } },
    sessions: [],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'TEST' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation(
    (_enabled: boolean, selector: (state: unknown) => unknown) => selector(mockState),
  );
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:codex:new' } });
  mockActions.getSpawnCatalog.mockResolvedValue(spawnCatalog);
});

async function openSummonSheet() {
  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-submit');
  await waitFor(() =>
    expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false),
  );
}

test('five taps inside one commit window spawn exactly one chat', async () => {
  // Regression scenario: one intent must not create duplicate chats.
  let resolveSpawn: (value: unknown) => void = () => {};
  mockActions.spawnSessionV2.mockImplementation(
    () => new Promise((resolve) => { resolveSpawn = resolve; }),
  );
  await openSummonSheet();
  const submit = screen.getByTestId('summon-submit');

  await act(async () => {
    for (let tap = 0; tap < 5; tap += 1) fireEvent.press(submit);
  });

  expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveSpawn({ session: { stream_id: 'hostc:codex:new' } });
  });
  expect(require('expo-router').router.push).toHaveBeenCalledTimes(1);
});

test('the submit control paints its pending state without waiting on the screen re-render', async () => {
  // The dead window that invites the extra taps. Driving SummonModal directly with a frozen
  // `submitting={false}` models the device exactly: the parent's expensive commit has not landed
  // yet, so the sheet itself must own the pending paint and refuse the queued taps.
  const onPick = jest.fn();
  render(
    <SummonModal
      visible
      machines={[{ host: 'hostc', title: 'hostc', online: true }]}
      catalog={spawnCatalog as any}
      catalogLoading={false}
      catalogError={null}
      submitting={false}
      submitError={null}
      onClose={() => {}}
      onRetryCatalog={() => {}}
      onPick={onPick}
    />,
  );
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-submit');
  await waitFor(() =>
    expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false),
  );

  fireEvent.press(screen.getByTestId('summon-submit'));

  expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(true);
  expect(screen.getByText('Starting…')).toBeTruthy();

  fireEvent.press(screen.getByTestId('summon-submit'));
  expect(onPick).toHaveBeenCalledTimes(1);

  // Let the sheet's pending release settle inside act so the assertion above is not racing it.
  await act(async () => {});
});

test('every spawn attempt carries a client intent id the daemon can dedupe on', async () => {
  await openSummonSheet();

  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(1));
  const call = mockActions.spawnSessionV2.mock.calls[0][0];
  expect(typeof call.idempotencyKey).toBe('string');
  expect(call.idempotencyKey.length).toBeGreaterThan(0);
  expect(call.idempotencyKey.length).toBeLessThanOrEqual(128);
});

test('a retry after an ambiguous transport failure reuses the same intent id', async () => {
  // Reconnect/timeout path: the daemon may already have created the chat, so the retry must
  // replay the same key rather than mint a second real chat.
  mockActions.spawnSessionV2.mockRejectedValueOnce(new Error('Pentacle stream is not connected'));
  await openSummonSheet();

  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });
  await screen.findByTestId('summon-submit-error');

  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(2));
  const [first, second] = mockActions.spawnSessionV2.mock.calls.map((call: any[]) => call[0]);
  expect(typeof first.idempotencyKey).toBe('string');
  expect(first.idempotencyKey).toBeTruthy();
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
});

test('a retry after a definitive server rejection mints a fresh intent id', async () => {
  // The daemon stores the failure under the key, so replaying it would replay the error forever.
  const rejected = Object.assign(new Error('spawn refused'), { errorCode: 'spawn_refused' });
  mockActions.spawnSessionV2.mockRejectedValueOnce(rejected);
  await openSummonSheet();

  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });
  await screen.findByTestId('summon-submit-error');

  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(2));
  const [first, second] = mockActions.spawnSessionV2.mock.calls.map((call: any[]) => call[0]);
  expect(first.idempotencyKey).toBeTruthy();
  expect(second.idempotencyKey).toBeTruthy();
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});
