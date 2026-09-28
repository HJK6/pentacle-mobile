import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SettingsScreen, { buildMachineTabs } from '../../../app/(tabs)/settings';
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import useLimits, { useLimitsHealth } from '../../../src/hooks/useLimits';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../../src/services/pentacleStream';

const mockUseIsFocused = jest.fn(() => true);

jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockUseIsFocused() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    nativeAppVersion: '2.1.0',
    nativeBuildVersion: '1',
    expoConfig: {
      version: '2.1.0',
      ios: { buildNumber: '1' },
      extra: {},
    },
  },
}));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/hooks/useLimits', () => ({
  __esModule: true,
  default: jest.fn(),
  useLimitsHealth: jest.fn(),
}));
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  useConsentEnrollmentReady: () => false,
  usePentacleStreamSelectorWhen: jest.fn(),
}));

beforeEach(() => {
  mockUseIsFocused.mockReturnValue(true);
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test', clearToken: jest.fn() });
  (useLimits as jest.Mock).mockReturnValue([
    { id: 'claude', label: 'Claude', pct: 21, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'fable', label: 'Fable', pct: 31, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'codex', label: 'Codex', pct: 34, resets_at_iso: '2026-08-30T00:00:00Z', resets_text: 'Saturday' },
  ]);
  (useLimitsHealth as jest.Mock).mockReturnValue(null);
  (usePentacleStreamActions as jest.Mock).mockReturnValue({ reconnect: jest.fn() });
  (usePentacleStreamSelectorWhen as jest.Mock).mockReturnValue([{
    host: 'hostc',
    title: 'hostc',
    online: true,
    sessionCount: 1,
    statusLabel: 'Online',
    stats: freshStats('hostc'),
  }]);
});

const GiB = 1024 * 1024 * 1024;

test('an enrolled phone can reach approval-key enrollment from Settings', async () => {
  render(<SettingsScreen />);
  await act(async () => {});
  expect(screen.getByTestId('approval-key-settings')).toBeTruthy();
  expect(screen.queryByTestId('approval-enrollment-code')).toBeNull();
  expect(screen.getByText('Not active yet')).toBeTruthy();
});

function freshStats(host: string, over: Record<string, unknown> = {}) {
  return {
    host,
    cpu_load_1m: 1.5,
    memory_used_bytes: 8 * GiB,
    memory_total_bytes: 16 * GiB,
    disk_used_bytes: 100 * GiB,
    disk_total_bytes: 400 * GiB,
    uptime_seconds: 90000,
    sampled_at: new Date().toISOString(),
    ...over,
  };
}

test('cold renders one accessible Limits section with three fixed-order weekly rows', async () => {
  render(<SettingsScreen />);
  await act(async () => {});

  const section = screen.getByTestId('limits-section');
  expect(screen.getByText('Limits')).toBeTruthy();
  expect(Array.from(new Set(section.findAll((node) => String(node.props.testID || '').startsWith('limits-row-')).map((node) => node.props.testID)))).toEqual([
    'limits-row-claude',
    'limits-row-fable',
    'limits-row-codex',
  ]);
  const limitsText = section.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join(' ');
  expect(limitsText).not.toMatch(/5h|session|Sonnet/i);
  for (const id of ['claude', 'fable', 'codex']) {
    const row = screen.getByTestId(`limits-row-${id}`);
    expect(row.props.accessible).toBe(true);
    expect(row.props.accessibilityLabel).toMatch(/weekly limit/i);
  }
  expect(screen.getByText('App version')).toBeTruthy();
  expect(screen.getByText('v2.1.0')).toBeTruthy();
  expect(screen.getByText('Build 1')).toBeTruthy();
  expect(screen.getAllByText('hostc').length).toBeGreaterThan(0);
  expect(screen.getByText('LIVE')).toBeTruthy();
});

test('renders loading and unenrolled settings states', async () => {
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: false, token: null });
  const loading = render(<SettingsScreen />);
  expect(loading.toJSON()).toBeTruthy();
  loading.unmount();

  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: null });
  render(<SettingsScreen />);
  await act(async () => {});
  expect(screen.getByText('Pentacle settings are unavailable until this device is enrolled.')).toBeTruthy();
  expect(screen.getByText('v2.1.0')).toBeTruthy();
  expect(screen.getByText('Build 1')).toBeTruthy();
});

test('sign-out clears the stored Pentacle token', async () => {
  const clearToken = jest.fn().mockResolvedValue(undefined);
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test', clearToken });
  render(<SettingsScreen />);
  await act(async () => {});

  await act(async () => fireEvent.press(screen.getByTestId('settings-sign-out')));

  expect(clearToken).toHaveBeenCalledTimes(1);
});

test('pull-to-refresh reconnects the stream', async () => {
  jest.useFakeTimers();
  const reconnect = jest.fn();
  (usePentacleStreamActions as jest.Mock).mockReturnValue({ reconnect });
  const rendered = render(<SettingsScreen />);
  await act(async () => {});
  const scrollView = rendered.UNSAFE_getByType(require('react-native').ScrollView);

  await act(async () => {
    await scrollView.props.refreshControl.props.onRefresh();
  });
  act(() => {
    jest.advanceTimersByTime(700);
  });

  expect(reconnect).toHaveBeenCalled();
});

test('renders offline machine stats fallback when a host has no stats frame', async () => {
  (usePentacleStreamSelectorWhen as jest.Mock).mockReturnValue([{
    host: 'hostd',
    title: 'hostd',
    online: false,
    sessionCount: 0,
    statusLabel: 'Offline',
    error: 'No heartbeat',
    stats: undefined,
  }]);

  render(<SettingsScreen />);
  await act(async () => {});

  expect(screen.getAllByText('OFFLINE').length).toBeGreaterThan(0);
  expect(screen.getByText('No stats available')).toBeTruthy();
});

test('valid-null limit visibly renders an em dash with deterministic reset fallback', async () => {
  (useLimits as jest.Mock).mockReturnValue([
    { id: 'claude', label: 'Claude', pct: 21, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'fable', label: 'Fable', pct: null, resets_at_iso: null, resets_text: null },
    { id: 'codex', label: 'Codex', pct: 34, resets_at_iso: null, resets_text: null },
  ]);
  render(<SettingsScreen />);
  await act(async () => {});
  expect(screen.getByTestId('limits-row-fable')).toBeTruthy();
  expect(screen.getByText('—')).toBeTruthy();
  expect(screen.getAllByText('Reset unavailable')).toHaveLength(2);
});

test('renders Claude probe-error health as text without hiding the row', async () => {
  (useLimitsHealth as jest.Mock).mockReturnValue({
    schema_version: 1,
    claude: { outcome: 'provider_error', error: { message: 'Provider usage is unavailable' } },
  });
  render(<SettingsScreen />);
  await act(async () => {});
  // Row still present, and the health message renders beneath it.
  expect(screen.getByTestId('limits-row-claude')).toBeTruthy();
  expect(screen.getByTestId('limits-health-claude')).toBeTruthy();
  expect(screen.getByText('Provider usage is unavailable')).toBeTruthy();
  // Healthy providers show no health line.
  expect(screen.queryByTestId('limits-health-codex')).toBeNull();
});

test('renders daemon machine metrics, flags staleness, and switches among fleet tabs', async () => {
  (usePentacleStreamSelectorWhen as jest.Mock).mockReturnValue([
    {
      host: 'hostc', title: 'hostc', online: true, sessionCount: 2, statusLabel: 'Online',
      stats: freshStats('hostc'),
    },
    {
      host: 'hostb', title: 'hostb', online: true, sessionCount: 1, statusLabel: 'Online',
      stats: freshStats('hostb', { sampled_at: '2020-01-01T00:00:00Z' }),
    },
  ]);
  render(<SettingsScreen />);
  await act(async () => {});

  // Active tab defaults to the first fleet machine (hostc), a fresh sample.
  expect(screen.getByText('LIVE')).toBeTruthy();
  expect(screen.getByText('50% · 8 GB / 16 GB')).toBeTruthy();
  expect(screen.getByText('25% · 100 GB / 400 GB')).toBeTruthy();
  expect(screen.getByText('1.5')).toBeTruthy();
  expect(screen.getByText('1d 1h')).toBeTruthy();

  // A sample older than 90s renders stale from sampled_at.
  fireEvent.press(screen.getByLabelText('hostb Online'));
  expect(screen.getByText('STALE')).toBeTruthy();
});

test('unfocused empty fleet remains renderable with cached limits', async () => {
  mockUseIsFocused.mockReturnValue(false);
  (usePentacleStreamSelectorWhen as jest.Mock).mockReturnValue([]);
  render(<SettingsScreen />);
  await act(async () => {});
  expect((usePentacleStreamSelectorWhen as jest.Mock).mock.calls.at(-1)?.[0]).toBe(false);
  expect(screen.getByTestId('limits-row-claude')).toBeTruthy();
  expect(screen.queryByText('hosta')).toBeNull();
});

test('buildMachineTabs drops assistant-identity hosts from the machine stats tabs', async () => {
  const card = (host: string) => ({
    host, title: host, online: true, sessionCount: 0, statusLabel: 'Online', stats: freshStats(host),
  });
  const tabs = buildMachineTabs([card('hoste'), card('bart'), card('hostc'), card('hostb')] as never);
  // The retired hosta identity host never becomes a machine stats tab; real
  // fleet hosts are preserved in order and each is assigned a machine skin.
  expect(tabs.map((t) => t.host)).toEqual(['hoste', 'hostc', 'hostb']);
  expect(tabs.every((t) => typeof t.machineName === 'string')).toBe(true);
});

test('machine selector equality detects every UI-relevant fleet change', async () => {
  render(<SettingsScreen />);
  await act(async () => {});
  const comparator = (usePentacleStreamSelectorWhen as jest.Mock).mock.calls.at(-1)?.[2] as (
    left: Array<Record<string, unknown>>,
    right: Array<Record<string, unknown>>,
  ) => boolean;
  const stats = { ok: true };
  const base = { host: 'hostc', title: 'hostc', online: true, sessionCount: 1, statusLabel: 'Online', error: undefined, stats };
  expect(comparator([base], [{ ...base }])).toBe(true);
  expect(comparator([base], [])).toBe(false);
  for (const changed of [
    { host: 'hosta' },
    { title: 'Other' },
    { online: false },
    { sessionCount: 2 },
    { statusLabel: 'Busy' },
    { error: 'offline' },
    { stats: { ok: true } },
  ]) {
    expect(comparator([base], [{ ...base, ...changed }])).toBe(false);
  }
});

afterEach(async () => { await act(async () => {}); });
