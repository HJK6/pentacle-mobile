import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DashboardsScreen from '../../../app/(tabs)/dashboards';
import { dashboardHubClient } from '../../../src/features/dashboards/dashboardHubClient';
import { loadDashboardHubRuntime } from '../../../src/features/dashboards/dashboardHubRuntime';

// Only native built-ins referenced by the catalog bring back hub behavior.
jest.mock('../../../src/features/dashboards/dashboardRegistry', () => {
  const { Text: RNText } = require('react-native');
  const board = (id: string, label: string) => ({
    id,
    hubKey: `synthetic.${id}`,
    label,
    render: ({ snapshot }: { snapshot: unknown }) => <RNText testID={`board-${id}`}>{snapshot ? 'has snapshot' : `${label} body`}</RNText>,
    resolve: () => null,
  });
  const actual = jest.requireActual('../../../src/features/dashboards/dashboardRegistry');
  actual.DASHBOARD_REGISTRY.alpha = board('alpha', 'Synthetic Alpha');
  actual.DASHBOARD_REGISTRY.beta = board('beta', 'Synthetic Beta');
  return actual;
});
jest.mock('../../../src/features/dashboards/catalogLoader', () => ({
  ...jest.requireActual('../../../src/features/dashboards/catalogLoader'),
  getCatalogSpecId: () => 'example__catalog',
  createCatalogLoader: () => ({ cancel: jest.fn(), refresh: jest.fn(async () => ({
    status: 'ready', cached: false, catalog: { boards: [
      { id: 'alpha', name: 'Synthetic Alpha', kind: 'built-in' },
      { id: 'beta', name: 'Synthetic Beta', kind: 'built-in' },
    ] },
  })) }),
}));
jest.mock('../../../src/services/pentacleAssets', () => ({ listReportsBySpec: jest.fn(), getReportByOwner: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/components/Starfield', () => () => null);
jest.mock('../../../src/services/mobileTabsTelemetry', () => ({ logFocusedTab: jest.fn() }));
jest.mock('../../../src/features/dashboards/dashboardHubRuntime', () => ({
  loadDashboardHubRuntime: jest.fn(async () => ({ url: 'wss://hub.example.invalid', deviceToken: 'synthetic' })),
}));

// RefreshControl renders without props in the test renderer; read it from the ScrollView.
const refreshControl = () => screen.getByTestId('dashboards-scroll').props.refreshControl.props;

describe('Dashboards tab with registered boards', () => {
  let connect: jest.SpyInstance;
  let refresh: jest.SpyInstance;
  beforeEach(() => {
    connect = jest.spyOn(dashboardHubClient, 'connect').mockImplementation(() => undefined);
    jest.spyOn(dashboardHubClient, 'configure').mockImplementation(() => undefined);
    refresh = jest.spyOn(dashboardHubClient, 'refresh').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the selector with the first board active, no empty state, and connects + refreshes it on focus', async () => {
    render(<DashboardsScreen />);
    await screen.findByTestId('board-alpha');
    expect(screen.queryByTestId('dashboards-empty')).toBeNull();
    expect(screen.getByTestId('dashboard-selector')).toBeTruthy();
    expect(screen.getByTestId('dashboard-selector-alpha').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-alpha')).toBeTruthy();
    expect(refresh).toHaveBeenCalledWith('synthetic.alpha', {});
    await waitFor(() => expect(loadDashboardHubRuntime).toHaveBeenCalled());
    await waitFor(() => expect(connect).toHaveBeenCalled());
  });

  it('switching boards refreshes the newly selected board', async () => {
    render(<DashboardsScreen />);
    await screen.findByTestId('board-alpha');
    fireEvent.press(screen.getByTestId('dashboard-selector-beta'));
    expect(screen.getByTestId('board-beta')).toBeTruthy();
    expect(refresh).toHaveBeenLastCalledWith('synthetic.beta', {});
  });

  it('pull-to-refresh refreshes the active board', async () => {
    render(<DashboardsScreen />);
    await screen.findByTestId('board-alpha');
    refresh.mockClear();
    await act(async () => refreshControl().onRefresh());
    expect(refresh).toHaveBeenCalledWith('synthetic.alpha', {});
  });
});
