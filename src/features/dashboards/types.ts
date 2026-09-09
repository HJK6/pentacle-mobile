export type DashboardRecord = Record<string, unknown>;

export type DashboardEnvelope<T extends DashboardRecord = DashboardRecord> = {
  dashboard_id: string;
  schema_version: number;
  updated_at: string;
  server_received_at: string;
  freshness_ttl_sec: number;
  data: T;
};

export type DashboardSnapshot<T extends DashboardRecord = DashboardRecord> = T & {
  _updated_at: string;
  _server_received_at: string;
  _age_sec: number;
  _transport_stale: boolean;
  _data_stale: boolean;
};

export type DashboardConnectionState = 'idle' | 'connecting' | 'connected' | 'offline';

export type DashboardHubClientConfig = {
  url: string;
  deviceToken: string;
};

export type DashboardGate = 'open' | 'closed';

export type DashboardGateMutation = {
  batch: string;
  gate: DashboardGate;
  setting?: 'auto_submit_skipmatrix';
};

export type DashboardGateResult = {
  ok: true;
  batch: string;
  gate: DashboardGate;
  setting: string;
  changed: boolean;
  device_id: string;
  updated_at: string;
} | { ok: false; error: string };
