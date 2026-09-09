import {
  getHostOrder,
  getHostTheme,
  setHostConfigProvider,
} from 'pentacle-chat-core';
import {
  getHostOrder as getMobileHostOrder,
  getHostTheme as getMobileHostTheme,
} from '../src/config/local';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

afterEach(() => {
  setHostConfigProvider({
    getHostOrder: getMobileHostOrder,
    getHostTheme: getMobileHostTheme,
  });
});

test('default host provider derives a stable deduplicated order from partial live state', () => {
  setHostConfigProvider(null);
  expect(getHostOrder()).toEqual([]);
  expect(getHostOrder({
    hosts: {
      'hostc': { host: ' hostc ', online: true, checked_at: '', session_count: 1 },
      empty: { host: '', online: false, checked_at: '', session_count: 0 },
    },
    sessions: [
      { host: 'hostc' },
      { host: 'hosta' },
    ] as never,
    machineStats: {
      one: { host: 'hostb', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
      two: { host: 'hosta', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
      empty: { host: '', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
    },
  })).toEqual(['hostc', 'hosta', 'hostb']);
});

test('default themes titlecase normalized example host names and remain safe for empty ids', () => {
  setHostConfigProvider(undefined);
  expect(getHostTheme('example_host.one')).toEqual({ label: 'Example Host One', color: '' });
  expect(getHostTheme('')).toEqual({ label: 'Unknown', color: '' });
});

test('injected provider controls both ordering and theme delegation until reset', () => {
  const provider = {
    getHostOrder: jest.fn(() => ['custom']),
    getHostTheme: jest.fn((host: string) => ({ label: `Label ${host}`, color: '#123456' })),
  };
  setHostConfigProvider(provider);
  expect(getHostOrder()).toEqual(['custom']);
  expect(getHostTheme('node')).toEqual({ label: 'Label node', color: '#123456' });
  expect(provider.getHostOrder).toHaveBeenCalledWith(undefined);
  expect(provider.getHostTheme).toHaveBeenCalledWith('node');
});

