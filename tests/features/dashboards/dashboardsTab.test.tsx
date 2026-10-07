import React from 'react';
import { render, screen } from '@testing-library/react-native';
import DashboardsScreen from '../../../app/(tabs)/dashboards';
import { DASHBOARD_ORDER, DASHBOARD_REGISTRY } from '../../../src/features/dashboards/dashboardRegistry';
import { dashboardHubClient } from '../../../src/features/dashboards/dashboardHubClient';
import { loadDashboardHubRuntime } from '../../../src/features/dashboards/dashboardHubRuntime';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/components/Starfield', () => () => null);
jest.mock('../../../src/services/mobileTabsTelemetry', () => ({ logFocusedTab: jest.fn() }));
jest.mock('../../../src/features/dashboards/dashboardHubRuntime', () => ({
  loadDashboardHubRuntime: jest.fn(async () => ({ url: 'wss://hub.example.invalid', deviceToken: 'synthetic' })),
}));

describe('Dashboards tab with no current boards', () => {
  let connect: jest.SpyInstance;
  let refresh: jest.SpyInstance;
  beforeEach(() => {
    connect = jest.spyOn(dashboardHubClient, 'connect').mockImplementation(() => undefined);
    refresh = jest.spyOn(dashboardHubClient, 'refresh').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists no retired hub boards', () => {
    expect(DASHBOARD_ORDER).toEqual([]);
    expect(Object.keys(DASHBOARD_REGISTRY)).toEqual([]);
  });

  it('shows a clean empty state: no selector, no Foreclosure/Business/Testing, no connection label', () => {
    render(<DashboardsScreen />);
    expect(screen.getByTestId('dashboards-empty')).toBeTruthy();
    expect(screen.getByText('No dashboards yet')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-selector')).toBeNull();
    for (const label of ['Foreclosure', 'Business', 'Testing', 'DISCONNECTED', 'CONNECTED']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('never loads the hub runtime, connects or refreshes while empty', async () => {
    render(<DashboardsScreen />);
    await Promise.resolve();
    expect(loadDashboardHubRuntime).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
