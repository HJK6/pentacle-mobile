import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SummonModal from '../src/components/SummonModal';
import { validateSpawnCatalog } from '../src/services/spawnCatalog';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

const definition = { efforts: ['medium', 'high'] };
const base = () => ({
  schema_version: 'CatalogV1', catalog_version: 'visibility-test',
  profiles: { desktop_manual: { claude: ['opus', 'high'], codex: ['sol', 'high'] } },
  models: { claude: { opus: definition }, codex: { sol: definition } },
});

function props(catalog: unknown, onPick = jest.fn()) {
  return {
    visible: true, machines: [{ host: 'hostc', title: 'Host C', online: true }],
    catalog: validateSpawnCatalog(catalog), catalogLoading: false, catalogError: null,
    submitting: false, submitError: null, onClose: jest.fn(), onRetryCatalog: jest.fn(), onPick,
  };
}

test('omitted Codex stays hidden and the offered provider owns submission', async () => {
  const onPick = jest.fn();
  render(<SummonModal {...props({ ...base(), available_models: { claude: { opus: definition } } }, onPick)} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.queryByTestId('summon-provider-codex')).toBeNull();
  expect(screen.getByTestId('summon-provider-claude').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('summon-model-sol')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  expect(onPick).toHaveBeenCalledWith('hostc', expect.objectContaining({ provider: 'claude', model: 'opus' }));
});

test('additive Gemini is accepted but never offered or used to restore hidden providers', () => {
  const input = { ...base(), available_models: { gemini: { pro: definition }, claude: { opus: definition } } };
  render(<SummonModal {...props(input)} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.queryByTestId('summon-provider-gemini')).toBeNull();
  expect(screen.queryByTestId('summon-provider-codex')).toBeNull();
  expect(screen.getAllByTestId(/^summon-provider-/)).toHaveLength(1);
});

test.each([{}, { gemini: { pro: definition } }])('no supported advertised providers disables submission: %p', (available_models) => {
  const onPick = jest.fn();
  render(<SummonModal {...props({ ...base(), available_models }, onPick)} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.queryAllByTestId(/^summon-provider-/)).toHaveLength(0);
  expect(screen.getByTestId('summon-no-providers')).toBeTruthy();
  expect(screen.getByTestId('summon-submit').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('summon-submit'));
  expect(onPick).not.toHaveBeenCalled();
});

test('open catalog refresh cannot submit the previously selected hidden tuple', async () => {
  const onPick = jest.fn();
  const view = render(<SummonModal {...props(base(), onPick)} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.getByTestId('summon-provider-codex').props.accessibilityState.selected).toBe(true);
  view.rerender(<SummonModal {...props({ ...base(), available_models: { claude: { opus: definition } } }, onPick)} />);
  expect(screen.queryByTestId('summon-provider-codex')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  expect(onPick).toHaveBeenCalledWith('hostc', expect.objectContaining({ provider: 'claude', model: 'opus' }));
});

test('advertised provider order is retained; legacy full catalog still defaults to Codex', () => {
  const view = render(<SummonModal {...props({ ...base(), available_models: { codex: { sol: definition }, claude: { opus: definition } } })} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.getAllByTestId(/^summon-provider-/).map(node => node.props.testID)).toEqual(['summon-provider-codex', 'summon-provider-claude']);
  view.rerender(<SummonModal {...props(base())} />);
  expect(screen.getByTestId('summon-provider-codex').props.accessibilityState.selected).toBe(true);
});

test('known advertised efforts must belong to the full model', () => {
  expect(() => validateSpawnCatalog({ ...base(), available_models: { codex: { sol: { efforts: ['bogus'] } } } })).toThrow(/incomplete/);
});

test('a visible model with a hidden default effort uses its offered effort without mutating full definitions', async () => {
  const input = { ...base(), available_models: { codex: { sol: { efforts: ['medium'] } } } };
  const before = JSON.stringify(input);
  const onPick = jest.fn();
  render(<SummonModal {...props(input, onPick)} />);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  expect(screen.queryByTestId('summon-effort-high')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  expect(onPick).toHaveBeenCalledWith('hostc', expect.objectContaining({ model: 'sol', effort: 'medium' }));
  expect(JSON.stringify(input)).toBe(before);
  expect(input.models.codex.sol.efforts).toContain('high');
});
