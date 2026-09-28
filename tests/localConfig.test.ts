import { getBackendWsUrl, getConfiguredHostOrder, getHostOrder, getHostTheme } from '../src/config/local';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function withExpoConfig(extra: Record<string, unknown>, run: () => void) {
  const previous = (globalThis as any).__PENTACLE_EXPO_CONFIG__;
  (globalThis as any).__PENTACLE_EXPO_CONFIG__ = { extra };
  try {
    run();
  } finally {
    (globalThis as any).__PENTACLE_EXPO_CONFIG__ = previous;
  }
}

test('getBackendWsUrl reads the configured websocket URL lazily', () => {
  withExpoConfig({ wsUrl: 'ws://127.0.0.1:7791', hosts: {} }, () => {
    expect(getBackendWsUrl()).toBe('ws://127.0.0.1:7791');
  });
});

test('getHostTheme returns configured host theme values', () => {
  withExpoConfig({
    wsUrl: 'ws://127.0.0.1:7791',
    hosts: {
      alpha: {
        label: 'Alpha Box',
        color: '#abcdef',
        accent: '#abcdef',
        surface: '#101010',
        border: '#202020',
        header: '#303030',
      },
    },
  }, () => {
    expect(getHostTheme('alpha')).toEqual({
      label: 'Alpha Box',
      color: '#abcdef',
      accent: '#abcdef',
      surface: '#101010',
      border: '#202020',
      header: '#303030',
    });
  });
});

test('getHostTheme titlecases unknown hosts and picks a stable fallback palette entry', () => {
  withExpoConfig({ wsUrl: 'ws://127.0.0.1:7791', hosts: {} }, () => {
    const first = getHostTheme('home-server');
    const second = getHostTheme('home-server');
    expect(first.label).toBe('Home Server');
    expect(first.color).toBe(second.color);
    expect(first.border).toBe(second.border);
  });
});

test('lazy accessors do not throw when Constants.expoConfig.extra is undefined', () => {
  const previous = (globalThis as any).__PENTACLE_EXPO_CONFIG__;
  (globalThis as any).__PENTACLE_EXPO_CONFIG__ = {};
  try {
    const theme = getHostTheme('home-server');
    expect(theme.label).toBe('Home Server');
    expect(theme.color).toBeTruthy();
    expect(getHostOrder()).toEqual([]);
    expect(getHostOrder({ hosts: {}, sessions: [], machineStats: {} })).toEqual([]);
  } finally {
    (globalThis as any).__PENTACLE_EXPO_CONFIG__ = previous;
  }
});

test('getHostOrder honors declared order before daemon emit order', () => {
  withExpoConfig({
    wsUrl: 'ws://127.0.0.1:7791',
    hosts: {},
    hostOrder: ['gamma', 'alpha'],
  }, () => {
    const order = getHostOrder({
      hosts: {
        beta: { host: 'beta', online: true, checked_at: '', session_count: 1 },
      },
      sessions: [
        {
          stream_id: 'delta:session-1',
          host: 'delta',
          provider: 'codex',
          session_name: 'session-1',
          last_event_at: '',
          last_text: '',
          last_kind: '',
          draft: '',
          pending: false,
          working: false,
          online: true,
        },
      ],
      machineStats: {
        epsilon: { host: 'epsilon', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
      },
    });

    expect(order).toEqual(['gamma', 'alpha', 'beta', 'delta', 'epsilon']);
  });
});

test('missing websocket configuration fails closed with an actionable enrollment error', () => {
  withExpoConfig({ wsUrl: '   ' }, () => {
    expect(() => getBackendWsUrl()).toThrow('Missing Pentacle backend wsUrl');
  });
});

test('configured host order normalizes values and rejects malformed configuration', () => {
  withExpoConfig({ hostOrder: [' Hostc ', null, 'hostc', 'Hosta'] }, () => {
    expect(getConfiguredHostOrder()).toEqual(['hostc', 'hostc', 'hosta']);
    expect(getHostOrder()).toEqual(['hostc', 'hosta']);
  });
  withExpoConfig({ hostOrder: 'hostc', hosts: [] }, () => {
    expect(getConfiguredHostOrder()).toEqual([]);
    expect(getHostTheme('')).toEqual(expect.objectContaining({ label: 'Unknown' }));
  });
});

test('partial configured themes receive complete safe palette fallbacks', () => {
  withExpoConfig({
    hosts: {
      alpha: { label: '', color: '', accent: '#123456', surface: '', border: '', header: '' },
      beta: { label: 'Beta', color: '#abcdef', accent: '', surface: '#111111', border: '#222222', header: '#333333' },
    },
  }, () => {
    expect(getHostTheme('alpha')).toEqual({
      label: 'Alpha',
      color: '#123456',
      accent: '#123456',
      surface: '#0c1827',
      border: '#2f6ca5',
      header: '#102a4a',
    });
    expect(getHostTheme('beta')).toEqual({
      label: 'Beta',
      color: '#abcdef',
      accent: '#abcdef',
      surface: '#111111',
      border: '#222222',
      header: '#333333',
    });
  });
});

test('runtime host discovery tolerates partial frames, deduplicates, and uses the stat host', () => {
  withExpoConfig({ hostOrder: ['hostc'] }, () => {
    expect(getHostOrder({
      hosts: undefined as never,
      sessions: undefined as never,
      machineStats: {
        one: { host: 'hosta', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
        two: { host: 'hostc', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
        empty: { host: '', cpu_load_1m: 0, memory_used_bytes: 1, memory_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 0, sampled_at: '' },
      },
    })).toEqual(['hostc', 'hosta']);
  });
});
