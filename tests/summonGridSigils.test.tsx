import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SummonModal from '../src/components/SummonModal';

// hosta=djinni(#1fbf4a), hostb=sun(#ff2e3e), hostc=mage(#1f5bff), hostd=flower(#a377a1).
// With the owner-shaped host config (bart=djinni, merlin=mage, amaterasu=sun) the grid
// must skin merlin as the mage (blue #1f5bff) and amaterasu as the sun (red #ff2e3e) —
// the swap that the placeholder-keyed table produced is gone.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

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

const catalog = {
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-5.6-sol', 'high'] } },
  models: {
    claude: { 'claude-opus-4-8': { aliases: ['opus'], efforts: ['low', 'high'] } },
    codex: { 'gpt-5.6-sol': { aliases: ['sol'], efforts: ['low', 'high'] } },
  },
} as never;

const machines = [
  { host: 'bart', title: 'Bartimaeus', online: true },
  { host: 'merlin', title: 'Merlin', online: true },
  { host: 'amaterasu', title: 'Amaterasu', online: true },
];

function renderModal(availableMachines = machines) {
  return render(
    <SummonModal
      visible
      machines={availableMachines}
      catalog={catalog}
      catalogLoading={false}
      catalogError={null}
      submitting={false}
      submitError={null}
      onClose={() => {}}
      onRetryCatalog={() => {}}
      onPick={() => {}}
    />,
  );
}

function borderColorOf(testID: string): string {
  const style = screen.getByTestId(testID).props.style as Array<Record<string, unknown>>;
  const entry = style.find((s) => s && typeof s === 'object' && 'borderColor' in s);
  return String(entry?.borderColor ?? '');
}

test('summon grid skins merlin as the mage (blue) and amaterasu as the sun (red)', () => {
  renderModal();
  // enabled cards use `${accent}40` as the border color.
  expect(borderColorOf('summon-machine-merlin')).toBe('#1f5bff40');
  expect(borderColorOf('summon-machine-amaterasu')).toBe('#ff2e3e40');
  expect(borderColorOf('summon-machine-bart')).toBe('#1fbf4a40');
});

test('Configure agent step shows the selected machine sigil accent, not the first machine', () => {
  renderModal();
  fireEvent.press(screen.getByTestId('summon-machine-merlin'));
  // The back control tints with selectedMeta.accent; merlin resolves to the mage (#1f5bff).
  const back = screen.getByText('‹ back');
  const style = Array.isArray(back.props.style) ? back.props.style : [back.props.style];
  const tint = style.find((s: Record<string, unknown>) => s && 'color' in s);
  expect(String(tint?.color)).toBe('#1f5bff');
});

test('fifth ibis card spans the summon grid', () => {
  (globalThis as Record<string, any>).__PENTACLE_EXPO_CONFIG__ = {
    extra: { wsUrl: 'ws://10.0.0.0:7791', hosts: { hosta: { sigil: 'djinni' }, hostb: { sigil: 'sun' }, hostc: { sigil: 'mage' }, hostd: { sigil: 'flower' }, hoste: { sigil: 'ibis' } }, hostOrder: ["hosta", "hostb", "hostc", "hostd", "hoste"] },
  };
  renderModal([
    { host: 'hosta', title: 'Host A', online: true },
    { host: 'hostb', title: 'Host B', online: true },
    { host: 'hostc', title: 'Host C', online: true },
    { host: 'hostd', title: 'Host D', online: true },
    { host: 'hoste', title: 'Host E', online: true },
  ]);
  const style = screen.getByTestId('summon-machine-hoste').props.style as Array<Record<string, unknown>>;
  expect(style.some(entry => entry?.width === '100%')).toBe(true);
  expect(borderColorOf('summon-machine-hoste')).toBe('#ffd60a40');
});
