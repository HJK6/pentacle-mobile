import React from 'react';
import BusinessDashboardScreen from './BusinessDashboardScreen';
import ForeclosureDashboardScreen from './ForeclosureDashboardScreen';
import TestingDashboardScreen from './TestingDashboardScreen';
import { resolveBusinessDashboard, resolveForeclosureDashboard } from './dashboardData';
import { resolveDashboardSnapshot } from './dashboardHubClient';
import type { DashboardEnvelope, DashboardGateMutation, DashboardGateResult, DashboardSnapshot } from './types';

export type DashboardId = 'foreclosure' | 'business' | 'testing';

export type DashboardRendererProps = {
  snapshot: DashboardSnapshot | null;
  onSelectBatch: (batch: string) => void;
  onMutateGate: (mutation: DashboardGateMutation) => Promise<DashboardGateResult>;
};

type DashboardDefinition = {
  id: DashboardId;
  hubKey: string;
  label: string;
  render: React.ComponentType<DashboardRendererProps>;
  resolve: (envelope: DashboardEnvelope | null, connected: boolean, options: { batch: string }) => DashboardSnapshot | null;
};

export const DASHBOARD_REGISTRY: Record<DashboardId, DashboardDefinition> = {
  foreclosure: {
    id: 'foreclosure',
    hubKey: 'hosta.foreclosure',
    label: 'Foreclosure',
    render: ForeclosureDashboardScreen,
    resolve: (envelope, connected, options) => resolveForeclosureDashboard(envelope, options.batch, connected),
  },
  business: {
    id: 'business',
    hubKey: 'hosta.business',
    label: 'Business',
    render: ({ snapshot }) => <BusinessDashboardScreen snapshot={snapshot} />,
    resolve: (envelope, connected) => resolveBusinessDashboard(envelope, connected),
  },
  testing: {
    id: 'testing',
    hubKey: 'pentacle-mobile-testing',
    label: 'Testing',
    render: ({ snapshot }) => <TestingDashboardScreen snapshot={snapshot} />,
    resolve: (envelope, connected) => resolveDashboardSnapshot(envelope, connected),
  },
};

export const DASHBOARD_ORDER: DashboardId[] = ['foreclosure', 'business', 'testing'];
