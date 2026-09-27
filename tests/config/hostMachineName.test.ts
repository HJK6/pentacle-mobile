import { getAssistantRole, getChatMachineName, getHostMachineName } from '../../src/config/local';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));

function setConfig(hosts: Record<string, unknown>, hostOrder: string[], features?: Record<string, unknown>) {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = {
    extra: { wsUrl: 'ws://10.0.0.0:7791', hosts, hostOrder, ...(features ? { features } : {}) },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

// hosta=djinni, hostb=sun, hostc=mage, hostd=flower (constants/Colors MACHINES).
const OWNER_HOSTS = {
  bart: { label: 'hosta', color: '#ff7ab8', sigil: 'djinni' },
  hostc: { label: 'hostc', color: '#4da3ff', sigil: 'mage' },
  hostb: { label: 'hostb', color: '#ff4d5e', sigil: 'sun' },
};
const OWNER_ORDER = ['bart', 'hostc', 'hostb'];

test('assistant-role pinning is off by default and accepts only a nonempty local role', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getAssistantRole()).toBe('');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantRole: ' assistant ' });
  expect(getAssistantRole()).toBe('assistant');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantRole: 7 });
  expect(getAssistantRole()).toBe('');
});

test('configured sigil wins: owner-shaped config maps bart/hostc/hostb to djinni/mage/sun machines', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName('bart')).toBe('hosta');
  expect(getHostMachineName('hostc')).toBe('hostc');
  expect(getHostMachineName('hostb')).toBe('hostb');
});

test('host id is normalized before lookup (whitespace/case)', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName(' hostc ')).toBe('hostc');
});

test('positional fallback (no sigils) reproduces old positions over hostOrder — documented, not desired', () => {
  const noSigils = {
    bart: { label: 'hosta', color: '#ff7ab8' },
    hostc: { label: 'hostc', color: '#4da3ff' },
    hostb: { label: 'hostb', color: '#ff4d5e' },
  };
  setConfig(noSigils, OWNER_ORDER);
  expect(getHostMachineName('bart')).toBe('hosta');
  expect(getHostMachineName('hostc')).toBe('hostb');
  expect(getHostMachineName('hostb')).toBe('hostc');
});

test('an unknown host resolves to the neutral placeholder, never the first machine', () => {
  // Regression guard: an unconfigured host must NOT silently wear the first
  // machine's skin (that made an unconfigured hoste render as hosta/djinni).
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName('hostd')).toBe('Unknown');
  expect(getHostMachineName('someNewBox')).toBe('Unknown');
  expect(getHostMachineName('')).toBe('Unknown');
});

test('the Bart assistant identity host maps to djinni explicitly, even when unconfigured', () => {
  // "bart" is the assistant identity, not a fleet machine, so it is not in the
  // shipping host config — but a chat carrying it must still wear the djinni skin.
  const noBart = {
    hoste: { label: 'hoste', sigil: 'ibis' },
    hostc: { label: 'hostc', sigil: 'mage' },
    hostb: { label: 'hostb', sigil: 'sun' },
  };
  setConfig(noBart, ['hoste', 'hostc', 'hostb']);
  expect(getHostMachineName('bart')).toBe('hosta');
  expect(getHostMachineName('hoste')).toBe('hoste');
});

test('getChatMachineName pins the composite assistant to djinni regardless of its host', () => {
  const noBart = {
    hoste: { label: 'hoste', sigil: 'ibis' },
    hostc: { label: 'hostc', sigil: 'mage' },
    hostb: { label: 'hostb', sigil: 'sun' },
  };
  setConfig(noBart, ['hoste', 'hostc', 'hostb']);
  // The daemon-owned Bart composite runs on an ordinary machine host (e.g. hoste),
  // but its chat surface stays djinni.
  expect(getChatMachineName('hoste', 'assistant_composite')).toBe('hosta');
  // An ordinary chat on the same host wears the host's own machine skin.
  expect(getChatMachineName('hoste', null)).toBe('hoste');
  expect(getChatMachineName('hostc', undefined)).toBe('hostc');
});
