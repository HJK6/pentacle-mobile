import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SummonModal from '../src/components/SummonModal';

// Defensive direct-render controls complement the validator. Malformed known
// empty provider maps must never restore hidden models from the full catalog.
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

test('an empty narrowed provider map cannot restore the full catalog', () => {
  // The validator would refuse this; the component must still render a usable
  // picker rather than a stranded empty list. Feed it straight to SummonModal.
  renderPicker({
    codex: {}, // empty narrowed map for the default provider
    claude: { 'claude-opus-4-8': def(['opus']) },
  });
  expect(screen.queryByTestId('summon-provider-codex')).toBeNull();
  expect(modelChipOrder()).toEqual(['claude-opus-4-8']);
  expect(screen.queryByTestId('summon-model-gpt-5.6-terra')).toBeNull();
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
