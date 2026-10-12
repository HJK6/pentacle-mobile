import { selectSmartChatList } from '../app/(tabs)/chats';

// The smart chat list must skin each row from the row's host via the shared resolver.
// With the owner config (laptop=mage, desktop=sun, assistant=djinni) a laptop row is the
// mage (hostc), not the assistant djinni that the placeholder table forced onto every row.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

beforeEach(() => {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = {
    extra: {
      wsUrl: 'ws://10.0.0.0:7791',
      hosts: {
        assistant: { label: 'Zephyr', color: '#ff7ab8', sigil: 'djinni' },
        laptop: { label: 'Laptop', color: '#4da3ff', sigil: 'mage' },
        desktop: { label: 'Desktop', color: '#ff4d5e', sigil: 'sun' },
      },
      hostOrder: ['assistant', 'laptop', 'desktop'],
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

function session(host: string) {
  return {
    stream_id: `${host}:codex:s`,
    host,
    provider: 'codex',
    session_name: 's',
    title: `${host} chat`,
    last_event_at: '2026-09-05T12:00:00.000Z',
    last_text: 'preview',
    last_kind: 'ASSIST',
    online: true,
  };
}

function state() {
  return {
    sessions: [session('assistant'), session('laptop'), session('desktop')],
    notifications: [],
    events: [],
    drafts: {},
    workingByStream: {},
    turnsByStream: {},
    optimisticSends: {},
  } as any;
}

test('each chat row resolves its sigil from its own host (laptop=mage/hostc, desktop=sun/hostb, assistant=djinni/hosta)', () => {
  const rows = selectSmartChatList(state());
  const byHost = new Map(rows.map((r) => [r.host, r.machineName]));
  expect(byHost.get('laptop')).toBe('hostc');
  expect(byHost.get('desktop')).toBe('hostb');
  expect(byHost.get('assistant')).toBe('hosta');
});
