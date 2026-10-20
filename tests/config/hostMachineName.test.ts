import {
  getAssistantRole, getAssistantStreamId, getChatMachineName, getHostMachineName, getMachineHostCount, isIdentityHost,
} from '../../src/config/local';

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
  alpha: { label: 'hosta', color: '#ff7ab8', sigil: 'djinni' },
  hostc: { label: 'hostc', color: '#4da3ff', sigil: 'mage' },
  hostb: { label: 'hostb', color: '#ff4d5e', sigil: 'sun' },
};
const OWNER_ORDER = ['alpha', 'hostc', 'hostb'];

test('assistant-role pinning is off by default and accepts only a nonempty local role', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getAssistantRole()).toBe('');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantRole: ' assistant ' });
  expect(getAssistantRole()).toBe('assistant');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantRole: 7 });
  expect(getAssistantRole()).toBe('');
});

test('configured sigil wins: owner-shaped config maps alpha/hostc/hostb to djinni/mage/sun machines', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName('alpha')).toBe('hosta');
  expect(getHostMachineName('hostc')).toBe('hostc');
  expect(getHostMachineName('hostb')).toBe('hostb');
});

test('host id is normalized before lookup (whitespace/case)', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName(' hostc ')).toBe('hostc');
});

test('positional fallback (no sigils) reproduces old positions over hostOrder — documented, not desired', () => {
  const noSigils = {
    alpha: { label: 'hosta', color: '#ff7ab8' },
    hostc: { label: 'hostc', color: '#4da3ff' },
    hostb: { label: 'hostb', color: '#ff4d5e' },
  };
  setConfig(noSigils, OWNER_ORDER);
  expect(getHostMachineName('alpha')).toBe('hosta');
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

test('the assistant stream id defaults to the public id and accepts only a nonempty local id', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getAssistantStreamId()).toBe('home:assistant');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantStreamId: ' zed:assistant ' });
  expect(getAssistantStreamId()).toBe('zed:assistant');

  setConfig(OWNER_HOSTS, OWNER_ORDER, { assistantStreamId: '  ' });
  expect(getAssistantStreamId()).toBe('home:assistant');
});

test('with the default home:assistant id, host home is the identity host and wears djinni, even when unconfigured', () => {
  const noIdentity = {
    hoste: { label: 'hoste', sigil: 'ibis' },
    hostc: { label: 'hostc', sigil: 'mage' },
    hostb: { label: 'hostb', sigil: 'sun' },
  };
  setConfig(noIdentity, ['hoste', 'hostc', 'hostb']);
  expect(isIdentityHost('home')).toBe(true);
  expect(isIdentityHost(' Home ')).toBe(true);
  expect(isIdentityHost('hoste')).toBe(false);
  expect(getHostMachineName('home')).toBe('hosta');
  expect(getHostMachineName('hoste')).toBe('hoste');
});

test('with a configured <x>:assistant id, host <x> is the identity host and the default host is not', () => {
  const noIdentity = {
    hoste: { label: 'hoste', sigil: 'ibis' },
    hostc: { label: 'hostc', sigil: 'mage' },
  };
  setConfig(noIdentity, ['hoste', 'hostc'], { assistantStreamId: 'zed:assistant' });
  expect(isIdentityHost('zed')).toBe(true);
  expect(isIdentityHost('home')).toBe(false);
  expect(getHostMachineName('zed')).toBe('hosta');
  expect(getHostMachineName('home')).toBe('Unknown');
});

test('the identity host is not counted as a machine', () => {
  setConfig({ hoste: { label: 'hoste', sigil: 'ibis' } }, ['zed', 'hoste'], { assistantStreamId: 'zed:assistant' });
  expect(getMachineHostCount()).toBe(1);
  setConfig({ hoste: { label: 'hoste', sigil: 'ibis' } }, ['home', 'hoste']);
  expect(getMachineHostCount()).toBe(1);
});

test('getChatMachineName pins the composite assistant to djinni regardless of its host', () => {
  const noAssistant = {
    hoste: { label: 'hoste', sigil: 'ibis' },
    hostc: { label: 'hostc', sigil: 'mage' },
    hostb: { label: 'hostb', sigil: 'sun' },
  };
  setConfig(noAssistant, ['hoste', 'hostc', 'hostb']);
  // The daemon-owned assistant composite runs on an ordinary machine host (e.g. hoste),
  // but its chat surface stays djinni.
  expect(getChatMachineName('hoste', 'assistant_composite')).toBe('hosta');
  // An ordinary chat on the same host wears the host's own machine skin.
  expect(getChatMachineName('hoste', null)).toBe('hoste');
  expect(getChatMachineName('hostc', undefined)).toBe('hostc');
});
