import { useCallback, useEffect, useReducer } from 'react';
import { dashboardHubClient } from './dashboardHubClient';
import { loadDashboardHubRuntime } from './dashboardHubRuntime';
import type { DashboardRecord } from './types';

export function useDashboardHub(active: boolean) {
  const [, render] = useReducer((value) => value + 1, 0);

  useEffect(() => dashboardHubClient.subscribe(render), []);

  useEffect(() => {
    if (!active) {
      dashboardHubClient.disconnect();
      return;
    }
    let cancelled = false;
    void loadDashboardHubRuntime().then((runtime) => {
      if (cancelled || !runtime.url || !runtime.deviceToken) return;
      dashboardHubClient.configure(runtime);
      dashboardHubClient.connect();
    });
    const stalenessTimer = setInterval(render, 15000);
    return () => {
      cancelled = true;
      clearInterval(stalenessTimer);
      dashboardHubClient.disconnect();
    };
  }, [active]);

  const refresh = useCallback((dashboardId?: string, params: DashboardRecord = {}) => {
    dashboardHubClient.refresh(dashboardId, params);
    render();
  }, []);

  return {
    client: dashboardHubClient,
    connectionState: dashboardHubClient.getState(),
    refresh,
  };
}
