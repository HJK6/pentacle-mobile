import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SummonModal from '../src/components/SummonModal';

// Non-vacuity companion to summonModelPickerFilter.test.tsx. Those tests route
// an empty available_models provider map through validateSpawnCatalog, which
// REFUSES it — so they never reach SummonModal's own defensive guard (the
// "empty narrowed map => fall back to full models" branch, SummonModal.tsx
// lines ~119-121). This renders SummonModal DIRECTLY with catalogs the
// validator would reject, exercising that guard's BOTH branches independently
// of validation. Deleting the guard makes the fallback test fail.
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

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const def = (aliases: string[]) => ({ aliases, efforts: EFFORTS });

// Full catalog in MODELS declaration order; the profile default (gpt-6-luna) is
// present in the full codex map so a valid selection seeds regardless.
const fullModels = {
  claude: {
    'claude-opus-4-8': def(['opus']),
    'claude-opus-5-5': def(['opus-5.5']),
    'claude-sonnet-5-5': def(['sonnet']),
    'claude-fable-5-1': def(['fable']),
  },
  codex: {
    'gpt-5.6-terra': def(['terra']),
    'gpt-6-sol': def([]),
    'gpt-6.1-sol': def(['sol']),
    'gpt-6-luna': def(['luna']),
    'gpt-6-astra': def(['astra']),
  },
};

const catalogWith = (availableModels?: Record<string, unknown>) => ({
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-6-luna', 'high'] } },
  models: fullModels,
  ...(availableModels ? { available_models: availableModels } : {}),
}) as never;

function renderPicker(availableModels?: Record<string, unknown>) {
  render(
    <SummonModal
      visible
      machines={[{ host: 'hostc', title: 'hostc', online: true }]}
      catalog={catalogWith(availableModels)}
      catalogLoading={false}
      catalogError={null}
      submitting={false}
      submitError={null}
      onClose={() => {}}
      onRetryCatalog={() => {}}
      onPick={() => {}}
    />,
  );
  // Into the configure view: provider defaults to codex (profile.codex present).
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
}

function modelChipOrder(): string[] {
  return screen.getAllByTestId(/^summon-model-/).map((node) => String(node.props.testID).replace('summon-model-', ''));
}

test('an empty narrowed provider map falls back to the full catalog (guard, not an empty picker)', () => {
  // The validator would refuse this; the component must still render a usable
  // picker rather than a stranded empty list. Feed it straight to SummonModal.
  renderPicker({
    codex: {}, // empty narrowed map for the default provider
    claude: { 'claude-opus-4-8': def(['opus']) },
  });
  // Codex falls back to the FULL models catalog, in declaration order…
  expect(modelChipOrder()).toEqual(['gpt-5.6-terra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
  // …including a model that only exists in the full map, proving the fallback
  // fired (removing the guard narrows this to [] and fails the assertion above).
  expect(screen.getByTestId('summon-model-gpt-5.6-terra')).toBeTruthy();
});

test('a non-empty narrowed provider map still narrows + reorders (guard keeps the filter)', () => {
  // Contrast branch: the guard must not over-broaden a real narrowed set.
  renderPicker({
    codex: { 'gpt-6-luna': def(['luna']), 'gpt-6-astra': def(['astra']) },
  });
  expect(modelChipOrder()).toEqual(['gpt-6-luna', 'gpt-6-astra']);
  expect(screen.queryByTestId('summon-model-gpt-5.6-terra')).toBeNull();
  expect(screen.queryByTestId('summon-model-gpt-6-sol')).toBeNull();
});
