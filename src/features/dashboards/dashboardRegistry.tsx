import React from 'react';
import { Text } from 'react-native';
import type { Catalog, CatalogBoard } from './catalogLoader';
import UnsupportedBoard from './UnsupportedBoard';
import type { DashboardEnvelope, DashboardGateMutation, DashboardGateResult, DashboardSnapshot } from './types';

// The Dashboards tab lists only current boards. The earlier hub boards (foreclosure, business,
// testing) are retired from the tab; the household boards and WMI briefs are added here when built.
export type DashboardId = string;

export type DashboardRendererProps = {
  snapshot: DashboardSnapshot | null;
  onSelectBatch: (batch: string) => void;
  onMutateGate: (mutation: DashboardGateMutation) => Promise<DashboardGateResult>;
  active?: boolean;
  refreshKey?: number;
};

export type DashboardDefinition = {
  id: DashboardId;
  hubKey: string;
  label: string;
  render: React.ComponentType<DashboardRendererProps>;
  resolve: (envelope: DashboardEnvelope | null, connected: boolean, options: { batch: string }) => DashboardSnapshot | null;
  catalogBoard?: CatalogBoard;
};

export const DASHBOARD_REGISTRY: Record<DashboardId, DashboardDefinition> = {};

export const DASHBOARD_ORDER: DashboardId[] = [];

// Never mutate the static registry: catalog entries use the app's asset connection,
// not a dashboard-hub key, subscription or polling timer.
export function mergeCatalogBoards(catalog: Catalog) {
  const registry = { ...DASHBOARD_REGISTRY };
  const order = [...DASHBOARD_ORDER];
  for (const board of catalog.boards) {
    const collision = Object.prototype.hasOwnProperty.call(registry, board.id);
    const key = collision ? `catalog:${board.id}` : board.id;
    registry[key] = {
      id: board.id,
      hubKey: '',
      label: board.name,
      catalogBoard: board,
      resolve: () => null,
      render: collision
        ? () => <Text style={{ color: '#ff8b7c', padding: 16 }} testID="dashboard-board-error">Board failed to load: board id {board.id} conflicts with a built-in</Text>
        : board.kind === 'report'
          ? ({ active, refreshKey }) => {
            // Defer asset/viewer imports until a configured report is selected.
            const ReportBoard = (require('./ReportBoard') as typeof import('./ReportBoard')).default;
            return <ReportBoard board={board} active={active} refreshKey={refreshKey} />;
          }
          : () => <UnsupportedBoard board={board} />,
    };
    order.push(key);
  }
  return { registry, order };
}
