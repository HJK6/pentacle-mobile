import React from 'react';
import { StyleSheet } from 'react-native';
import { render, within } from '@testing-library/react-native';
import SummonModal from '../src/components/SummonModal';

// Operator report on build 1361 (2026-09-27): with the three-machine fleet the
// Summon picker put hoste full-width on top and hostb/hostc below. Every
// machine must sit in one horizontal row at the same width.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

beforeEach(() => {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = {
    extra: {
      wsUrl: 'ws://10.0.0.0:7791',
      hosts: {
        hoste: { label: 'hoste', color: '#ffd60a', sigil: 'ibis' },
        hostc: { label: 'hostc', color: '#4da3ff', sigil: 'mage' },
        hostb: { label: 'hostb', color: '#ff4d5e', sigil: 'sun' },
      },
      hostOrder: ['hoste', 'hostc', 'hostb'],
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

function renderModal(machines: { host: string; title: string; online: boolean }[]) {
  return render(
    <SummonModal
      visible
      machines={machines}
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

const fleet = [
  { host: 'hoste', title: 'hoste', online: true },
  { host: 'hostb', title: 'hostb', online: true },
  { host: 'hostc', title: 'hostc', online: true },
];

test('three machines share one row at equal width', () => {
  const view = renderModal(fleet);
  const cards = fleet.map((m) => view.getByTestId(`summon-machine-${m.host}`));
  const styles = cards.map((card) => StyleSheet.flatten(card.props.style));
  for (const style of styles) {
    expect(style.width).toBeUndefined();
    expect(style.flex).toBe(1);
  }
  const row = view.getByTestId('summon-machine-row-0');
  for (const m of fleet) expect(within(row).getByTestId(`summon-machine-${m.host}`)).toBeTruthy();
  expect(view.queryByTestId('summon-machine-row-1')).toBeNull();
  const rowStyle = StyleSheet.flatten(row.props.style);
  expect(rowStyle.flexDirection).toBe('row');
  expect(rowStyle.flexWrap ?? 'nowrap').toBe('nowrap');
  expect(view.queryByTestId('summon-machine-spacer')).toBeNull();
});

test('a larger fleet wraps into rows of three and keeps every card the same width', () => {
  const view = renderModal([
    ...fleet,
    { host: 'extra-a', title: 'Extra A', online: true },
    { host: 'extra-b', title: 'Extra B', online: true },
  ]);
  const cards = ['hoste', 'hostb', 'hostc', 'extra-a', 'extra-b'].map((h) => view.getByTestId(`summon-machine-${h}`));
  for (const card of cards) expect(StyleSheet.flatten(card.props.style).flex).toBe(1);
  expect(within(view.getByTestId('summon-machine-row-0')).getAllByTestId(/^summon-machine-(hoste|hostb|hostc)$/)).toHaveLength(3);
  const second = view.getByTestId('summon-machine-row-1');
  expect(within(second).getAllByTestId(/^summon-machine-extra-[ab]$/)).toHaveLength(2);
  expect(within(second).getAllByTestId('summon-machine-spacer')).toHaveLength(1);
});
