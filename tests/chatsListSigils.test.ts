import { selectSmartChatList } from '../app/(tabs)/chats';

// The smart chat list must skin each row from the row's host via the shared resolver.
// With the owner config (merlin=mage, amaterasu=sun, bart=djinni) a merlin row is the
// mage (hostc), not the Bart djinni that the placeholder table forced onto every row.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

beforeEach(() => {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = {
    extra: {
      wsUrl: 'ws://10.0.0.0:7791',
      hosts: {
        bart: { label: 'Bartimaeus', color: '#ff7ab8', sigil: 'djinni' },
        merlin: { label: 'Merlin', color: '#4da3ff', sigil: 'mage' },
        amaterasu: { label: 'Amaterasu', color: '#ff4d5e', sigil: 'sun' },
      },
      hostOrder: ['bart', 'merlin', 'amaterasu'],
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
    sessions: [session('bart'), session('merlin'), session('amaterasu')],
    notifications: [],
    events: [],
    drafts: {},
    workingByStream: {},
    turnsByStream: {},
    optimisticSends: {},
  } as any;
}

test('each chat row resolves its sigil from its own host (merlin=mage/hostc, amaterasu=sun/hostb, bart=djinni/hosta)', () => {
  const rows = selectSmartChatList(state());
  const byHost = new Map(rows.map((r) => [r.host, r.machineName]));
  expect(byHost.get('merlin')).toBe('hostc');
  expect(byHost.get('amaterasu')).toBe('hostb');
  expect(byHost.get('bart')).toBe('hosta');
});
