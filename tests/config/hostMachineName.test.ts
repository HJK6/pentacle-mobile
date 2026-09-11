import { getHostMachineName } from '../../src/config/local';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));

function setConfig(hosts: Record<string, unknown>, hostOrder: string[]) {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = {
    extra: { wsUrl: 'ws://10.0.0.0:7791', hosts, hostOrder },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

// hosta=djinni, hostb=sun, hostc=mage, hostd=flower (constants/Colors MACHINES).
const OWNER_HOSTS = {
  bart: { label: 'Bartimaeus', color: '#ff7ab8', sigil: 'djinni' },
  merlin: { label: 'Merlin', color: '#4da3ff', sigil: 'mage' },
  amaterasu: { label: 'Amaterasu', color: '#ff4d5e', sigil: 'sun' },
};
const OWNER_ORDER = ['bart', 'merlin', 'amaterasu'];

test('configured sigil wins: owner-shaped config maps bart/merlin/amaterasu to djinni/mage/sun machines', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName('bart')).toBe('hosta');
  expect(getHostMachineName('merlin')).toBe('hostc');
  expect(getHostMachineName('amaterasu')).toBe('hostb');
});

test('host id is normalized before lookup (whitespace/case)', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName(' Merlin ')).toBe('hostc');
});

test('positional fallback (no sigils) reproduces old positions over hostOrder — documented, not desired', () => {
  const noSigils = {
    bart: { label: 'Bartimaeus', color: '#ff7ab8' },
    merlin: { label: 'Merlin', color: '#4da3ff' },
    amaterasu: { label: 'Amaterasu', color: '#ff4d5e' },
  };
  setConfig(noSigils, OWNER_ORDER);
  expect(getHostMachineName('bart')).toBe('hosta');
  expect(getHostMachineName('merlin')).toBe('hostb');
  expect(getHostMachineName('amaterasu')).toBe('hostc');
});

test('unknown host falls back to the first machine', () => {
  setConfig(OWNER_HOSTS, OWNER_ORDER);
  expect(getHostMachineName('daffodil')).toBe('hosta');
  expect(getHostMachineName('')).toBe('hosta');
});
