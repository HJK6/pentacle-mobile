import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DashboardsScreen from '../../../app/(tabs)/dashboards';
import { dashboardHubClient } from '../../../src/features/dashboards/dashboardHubClient';
import { loadDashboardHubRuntime } from '../../../src/features/dashboards/dashboardHubRuntime';

// A board registered later (as the runtime catalog will) brings the selector and hub behaviour back.
jest.mock('../../../src/features/dashboards/dashboardRegistry', () => {
  const { Text: RNText } = require('react-native');
  const board = (id: string, label: string) => ({
    id,
    hubKey: `synthetic.${id}`,
    label,
    render: ({ snapshot }: { snapshot: unknown }) => <RNText testID={`board-${id}`}>{snapshot ? 'has snapshot' : `${label} body`}</RNText>,
    resolve: () => null,
  });
  return {
    DASHBOARD_ORDER: ['alpha', 'beta'],
    DASHBOARD_REGISTRY: { alpha: board('alpha', 'Synthetic Alpha'), beta: board('beta', 'Synthetic Beta') },
  };
});
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
    expect(screen.queryByTestId('dashboards-empty')).toBeNull();
    expect(screen.getByTestId('dashboard-selector')).toBeTruthy();
    expect(screen.getByTestId('dashboard-selector-alpha').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-alpha')).toBeTruthy();
    expect(refresh).toHaveBeenCalledWith('synthetic.alpha', {});
    await waitFor(() => expect(loadDashboardHubRuntime).toHaveBeenCalled());
    await waitFor(() => expect(connect).toHaveBeenCalled());
  });

  it('switching boards refreshes the newly selected board', () => {
    render(<DashboardsScreen />);
    fireEvent.press(screen.getByTestId('dashboard-selector-beta'));
    expect(screen.getByTestId('board-beta')).toBeTruthy();
    expect(refresh).toHaveBeenLastCalledWith('synthetic.beta', {});
  });

  it('pull-to-refresh refreshes the active board', () => {
    render(<DashboardsScreen />);
    refresh.mockClear();
    act(() => refreshControl().onRefresh());
    expect(refresh).toHaveBeenCalledWith('synthetic.alpha', {});
  });
});
