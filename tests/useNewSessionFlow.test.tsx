// The shared new-session flow used by the Chats + button and the Bart drawer + button
// (docs/bart_home_contracts.md § New session).
import React from 'react';
import { Alert, Pressable, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useNewSessionFlow } from '../src/components/useNewSessionFlow';
import type { SummonMachine } from '../src/components/SummonModal';

const mockActions = { spawnSessionV2: jest.fn(), getSpawnCatalog: jest.fn() };
jest.mock('../src/services/pentacleStream', () => ({ usePentacleStreamActions: () => mockActions }));

const spawnCatalog = {
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-5.6-sol', 'high'] } },
  models: {
    claude: { 'claude-opus-4-8': { aliases: ['opus'], efforts: ['low', 'high'] } },
    codex: { 'gpt-5.6-sol': { aliases: ['sol'], efforts: ['low', 'high'] } },
  },
};

function Drawer({ machines, onOpened }: { machines: SummonMachine[]; onOpened: (id: string) => void }) {
  const flow = useNewSessionFlow({ machines, onOpened });
  return <>
    <Pressable testID="drawer-new" disabled={!flow.canStart} onPress={flow.start}><Text>+</Text></Pressable>
    {flow.modal}
  </>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActions.getSpawnCatalog.mockResolvedValue(spawnCatalog);
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:claude:new' } });
});

test('a second surface can start a session through the shared flow and receives the new stream', async () => {
  const onOpened = jest.fn();
  render(<Drawer machines={[{ host: 'hostc', title: 'Host C', online: true }]} onOpened={onOpened} />);
  fireEvent.press(screen.getByTestId('drawer-new'));
  expect(mockActions.getSpawnCatalog).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => { fireEvent.press(screen.getByTestId('summon-submit')); });
  expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc', spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1',
  }));
  expect(onOpened).toHaveBeenCalledWith('hostc:claude:new');
});

test('without a live machine the flow cannot start', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  render(<Drawer machines={[{ host: 'hostc', title: 'Host C', online: false }]} onOpened={jest.fn()} />);
  expect(screen.getByTestId('drawer-new').props.accessibilityState?.disabled).toBe(true);
  expect(mockActions.getSpawnCatalog).not.toHaveBeenCalled();
  alert.mockRestore();
});
