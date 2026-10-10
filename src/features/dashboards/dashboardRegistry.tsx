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

// The registry only resolves code; catalog array order and visibility own the list.
// Reports/adapters/hosted entries never activate the old dashboard hub.
export function mergeCatalogBoards(catalog: Catalog) {
  const registry: Record<DashboardId, DashboardDefinition> = {};
  const order: DashboardId[] = [];
  for (const board of catalog.boards) {
    if (board.visible === false) continue;
    const builtIn = board.kind === 'built-in' && Object.prototype.hasOwnProperty.call(DASHBOARD_REGISTRY, board.id)
      ? DASHBOARD_REGISTRY[board.id] : undefined;
    registry[board.id] = builtIn ? { ...builtIn, label: board.name } : {
      id: board.id,
      hubKey: '',
      label: board.name,
      catalogBoard: board,
      resolve: () => null,
      render: board.kind === 'built-in'
        ? () => <Text style={{ color: '#ff8b7c', padding: 16 }} testID="dashboard-board-error">Dashboard unavailable on this client: {board.name}</Text>
        : board.kind === 'report'
          ? ({ active, refreshKey }) => {
            // Defer asset/viewer imports until a configured report is selected.
            const ReportBoard = (require('./ReportBoard') as typeof import('./ReportBoard')).default;
            return <ReportBoard board={board} active={active} refreshKey={refreshKey} />;
          }
          : () => <UnsupportedBoard board={board} />,
    };
    order.push(board.id);
  }
  return { registry, order };
}
