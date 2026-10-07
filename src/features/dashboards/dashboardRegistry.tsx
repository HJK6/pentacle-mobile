import React from 'react';
import type { DashboardEnvelope, DashboardGateMutation, DashboardGateResult, DashboardSnapshot } from './types';

// The Dashboards tab lists only current boards. The earlier hub boards (foreclosure, business,
// testing) are retired from the tab; the household boards and WMI briefs are added here when built.
export type DashboardId = string;

export type DashboardRendererProps = {
  snapshot: DashboardSnapshot | null;
  onSelectBatch: (batch: string) => void;
  onMutateGate: (mutation: DashboardGateMutation) => Promise<DashboardGateResult>;
};

export type DashboardDefinition = {
  id: DashboardId;
  hubKey: string;
  label: string;
  render: React.ComponentType<DashboardRendererProps>;
  resolve: (envelope: DashboardEnvelope | null, connected: boolean, options: { batch: string }) => DashboardSnapshot | null;
};

export const DASHBOARD_REGISTRY: Record<DashboardId, DashboardDefinition> = {};

export const DASHBOARD_ORDER: DashboardId[] = [];
