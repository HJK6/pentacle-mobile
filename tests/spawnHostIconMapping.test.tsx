jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import SummonModal, { type SummonMachine } from '../src/components/SummonModal';
import MachineSigil from '../src/components/MachineSigil';
import { MACHINES, MACHINE_ORDER } from '../constants/Colors';

// Regression guard for the operator-reported spawn host-icon swap
// (spec_pentacle_mobile__spawn_host_icon_mapping_2026_09).
//
// The bug was never in source — constants/Colors.ts has mapped Hostb->'sun'
// (the flame) and Hostc->'mage' (the wizard) since the sigil library landed —
// but the picker's per-machine glyph had no assertion, so a future swap of those
// constants (or of the ArcaneRingFrame -> MachineSigil render chain) would ship
// green. This locks each spawn-picker card to the sigil kind and accent its
// machine is supposed to show, on the real SummonModal grid.

// Every machine online so the full grid renders and every card is selectable.
const machines: SummonMachine[] = MACHINE_ORDER.map((name) => ({
  host: name.toLowerCase(),
  title: name,
  online: true,
}));

function renderPicker() {
  return render(
    <SummonModal
      visible
      machines={machines}
      catalog={null}
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

test('each spawn-picker card shows its own machine sigil and accent', () => {
  renderPicker();

  for (const name of MACHINE_ORDER) {
    const card = screen.getByTestId(`summon-machine-${name.toLowerCase()}`);
    const sigil = within(card).UNSAFE_getByType(MachineSigil);
    expect(sigil.props.kind).toBe(MACHINES[name].kind);
    expect(sigil.props.color).toBe(MACHINES[name].accent);
    // The label under the glyph must name the same machine.
    expect(within(card).getByText(name)).toBeTruthy();
  }
});

test('Hostb shows the flame and Hostc shows the wizard (not swapped)', () => {
  renderPicker();

  const hostb = within(screen.getByTestId('summon-machine-hostb')).UNSAFE_getByType(MachineSigil);
  expect(hostb.props.kind).toBe('sun'); // the flame
  expect(hostb.props.color).toBe('#ff2e3e');

  const hostc = within(screen.getByTestId('summon-machine-hostc')).UNSAFE_getByType(MachineSigil);
  expect(hostc.props.kind).toBe('mage'); // the wizard
  expect(hostc.props.color).toBe('#1f5bff');

  // Explicitly fail if the two are ever swapped.
  expect(hostb.props.kind).not.toBe(hostc.props.kind);
});

beforeEach(() => {
  (globalThis as any).__PENTACLE_EXPO_CONFIG__ = { extra: {
    hosts: Object.fromEntries(MACHINE_ORDER.map(name => [name.toLowerCase(), { label: name, sigil: MACHINES[name].kind }])),
    hostOrder: MACHINE_ORDER.map(name => name.toLowerCase()),
  } };
});
afterEach(() => { delete (globalThis as any).__PENTACLE_EXPO_CONFIG__; });
