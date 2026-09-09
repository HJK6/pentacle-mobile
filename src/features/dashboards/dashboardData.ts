import { resolveDashboardSnapshot } from './dashboardHubClient';
import type { DashboardEnvelope, DashboardRecord, DashboardSnapshot } from './types';

function record(value: unknown): DashboardRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DashboardRecord : {};
}

function records(value: unknown): DashboardRecord[] {
  return Array.isArray(value) ? value.filter((item): item is DashboardRecord => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function mergeMetricMap(target: DashboardRecord, source: unknown) {
  Object.entries(record(source)).forEach(([name, value]) => {
    const bucket = record(target[name]);
    Object.entries(record(value)).forEach(([key, metric]) => {
      bucket[key] = (Number(bucket[key]) || 0) + (Number(metric) || 0);
    });
    target[name] = bucket;
  });
}

export function resolveForeclosureDashboard(
  envelope: DashboardEnvelope | null,
  batch: string,
  connected: boolean,
  nowMs = Date.now(),
): DashboardSnapshot | null {
  const data = resolveDashboardSnapshot(envelope, connected, nowMs);
  if (!data) return null;
  const snapshots = record(data.snapshots);
  if (!Object.keys(snapshots).length) return data;
  const defaultBatch = String(data.default_batch || '');
  const wanted = batch || defaultBatch;
  const selected = record(snapshots[wanted] || snapshots[defaultBatch]);
  if (!Object.keys(selected).length) return data;
  return {
    ...selected,
    all_batches: data.all_batches,
    all_batches_meta: data.all_batches_meta,
    default_batch: defaultBatch,
    _missing_batch: batch && !snapshots[batch] ? batch : null,
    _updated_at: data._updated_at,
    _server_received_at: data._server_received_at,
    _age_sec: data._age_sec,
    _transport_stale: data._transport_stale,
    _data_stale: data._data_stale,
  };
}

const BUSINESS_STAGE_KEYS = ['scrape', 'enrich', 'qualify', 'promote'];
const BUSINESS_NUMERIC_KEYS = ['scraped', 'deduped', 'enriched', 'qualified', 'promoted', 'skipped'];
const BUSINESS_QUEUE_KEYS = ['pending', 'running', 'completed', 'failed', 'cancelled', 'total', 'total_scraped', 'total_ingested', 'total_duped'];

function mergedState(states: string[]) {
  for (const state of ['failed', 'blocked', 'running', 'waiting']) if (states.includes(state)) return state;
  return states.length && states.every((state) => state === 'complete') ? 'complete' : states[0] || 'waiting';
}

export function resolveBusinessDashboard(
  envelope: DashboardEnvelope | null,
  connected: boolean,
  nowMs = Date.now(),
): DashboardSnapshot | null {
  const data = resolveDashboardSnapshot(envelope, connected, nowMs);
  if (!data) return null;
  const snapshots = record(data.snapshots);
  const snapshotList = Object.values(snapshots).map(record).filter((item) => Object.keys(item).length);
  if (!snapshotList.length) return data;
  const aggregate: DashboardRecord = {
    batch: 'All leads',
    all_leads: true,
    all_batches: data.all_batches,
    all_batches_meta: data.all_batches_meta,
    default_batch: data.default_batch,
    by_area: {},
    by_source: {},
    _missing_batch: null,
  };
  BUSINESS_NUMERIC_KEYS.forEach((key) => {
    aggregate[key] = snapshotList.reduce((sum, snapshot) => sum + (Number(snapshot[key]) || 0), 0);
  });
  snapshotList.forEach((snapshot) => {
    mergeMetricMap(record(aggregate.by_area), snapshot.by_area);
    mergeMetricMap(record(aggregate.by_source), snapshot.by_source);
  });
  aggregate.pipeline_stages = BUSINESS_STAGE_KEYS.map((stageKey) => {
    const stageRows = snapshotList.flatMap((snapshot) => records(snapshot.pipeline_stages)).filter((stage) => stage.stage === stageKey);
    const metrics: DashboardRecord = {};
    stageRows.forEach((stage) => {
      Object.entries(record(stage.metrics)).forEach(([key, value]) => {
        metrics[key] = (Number(metrics[key]) || 0) + (Number(value) || 0);
      });
    });
    return {
      stage: stageKey,
      state: mergedState(stageRows.map((stage) => String(stage.state || 'waiting'))),
      metrics,
      error: stageRows.find((stage) => stage.error)?.error || null,
    };
  });
  const queue: DashboardRecord = { jobs: [], failed_jobs: [], by_area: {}, running_job: null };
  BUSINESS_QUEUE_KEYS.forEach((key) => {
    queue[key] = snapshotList.reduce((sum, snapshot) => sum + (Number(record(snapshot.scraper_queue)[key]) || 0), 0);
  });
  snapshotList.forEach((snapshot) => {
    const source = record(snapshot.scraper_queue);
    mergeMetricMap(record(queue.by_area), source.by_area);
    if (!queue.running_job && source.running_job) queue.running_job = source.running_job;
    const sourceJobs = records(source.jobs);
    const fallbackJobs = [source.running_job, ...records(source.failed_jobs)].filter(Boolean) as DashboardRecord[];
    (queue.jobs as DashboardRecord[]).push(...(sourceJobs.length ? sourceJobs : fallbackJobs));
    (queue.failed_jobs as DashboardRecord[]).push(...records(source.failed_jobs));
  });
  aggregate.scraper_queue = queue;
  aggregate.coverage_reports = [...records(data.coverage_reports), ...snapshotList.flatMap((snapshot) => records(snapshot.coverage_reports))];
  aggregate.recent_errors = [...records(data.recent_errors), ...snapshotList.flatMap((snapshot) => records(snapshot.recent_errors))];
  aggregate.crm_source_counts = data.crm_source_counts || data.crm_counts || {};
  return {
    ...aggregate,
    _updated_at: data._updated_at,
    _server_received_at: data._server_received_at,
    _age_sec: data._age_sec,
    _transport_stale: data._transport_stale,
    _data_stale: data._data_stale,
  } as DashboardSnapshot;
}
