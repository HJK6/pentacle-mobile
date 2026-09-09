import React, { useMemo } from 'react';
import { View } from 'react-native';
import { DashboardHeader, DataTable, MetricGrid, Panel, StageFlow, StalenessBadge, record, rows, text } from './DashboardUi';
import type { DashboardRecord, DashboardSnapshot } from './types';

function keyedRows(value: unknown, keyName: string): DashboardRecord[] {
  return Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, stats]) => ({ [keyName]: key, ...record(stats) }));
}

function queueJobs(value: unknown) {
  if (Array.isArray(value)) return rows(value);
  const queue = record(value);
  return rows(queue.jobs || queue.items);
}

export default function BusinessDashboardScreen({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const stages = useMemo(() => {
    const stageRows = rows(snapshot?.pipeline_stages);
    const definitions = [
      { stage: 'scrape', label: 'Scrape', countKey: 'scraped' },
      { stage: 'enrich', label: 'Enrich', countKey: snapshot?.enriched === undefined ? 'deduped' : 'enriched' },
      { stage: 'qualify', label: 'Qualify', countKey: 'qualified' },
      { stage: 'promote', label: 'Promote', countKey: 'promoted' },
    ];
    return definitions.map((definition) => ({
      ...definition,
      ...(stageRows.find((stage) => stage.stage === definition.stage) || {}),
      count: snapshot?.[definition.countKey],
    }));
  }, [snapshot]);
  const byArea = keyedRows(snapshot?.by_area, 'area');
  const bySource = keyedRows(snapshot?.by_source, 'source');
  const crm = record(snapshot?.crm_source_counts || snapshot?.crm_counts);
  const crmSources = [...new Set([...Object.keys(record(crm.staging)), ...Object.keys(record(crm.prod))])].sort();
  const crmRows = crmSources.map((source) => ({ source, staging: record(crm.staging)[source], prod: record(crm.prod)[source] }));
  const jobs = queueJobs(snapshot?.scraper_queue).filter((job) => ['pending', 'running', 'awaiting_async'].includes(text(job.status, '').toLowerCase()));
  const coverage = rows(snapshot?.coverage_reports);
  const errors = rows(snapshot?.recent_errors);

  return (
    <View testID="business-dashboard-screen">
      <DashboardHeader title="Business Pipeline" subtitle="Lead Lock acquisition, enrichment, qualification, and CRM promotion." />
      <StalenessBadge snapshot={snapshot} />
      <Panel title="Pipeline stages" testID="business-stage-panel"><StageFlow stages={stages} /></Panel>
      <Panel title="Totals" testID="business-totals">
        <MetricGrid testID="business-total" metrics={[
          { label: 'Scraped', value: snapshot?.scraped },
          { label: 'Deduped', value: snapshot?.deduped },
          { label: 'Qualified', value: snapshot?.qualified },
          { label: 'Promoted', value: snapshot?.promoted },
        ]} />
      </Panel>
      <Panel title="Batch funnel by metro">
        <DataTable testID="business-area-table" data={byArea} columns={[
          { key: 'area', label: 'Area' },
          { key: 'scraped', label: 'Scraped', width: 85 },
          { key: 'qualified', label: 'Qualified', width: 90 },
          { key: 'promoted', label: 'Promoted', width: 90 },
        ]} emptyText="No area data yet" />
      </Panel>
      <Panel title="Source breakdown">
        <DataTable testID="business-source-table" data={bySource} columns={[
          { key: 'source', label: 'Source' },
          { key: 'scraped', label: 'Scraped', width: 85 },
          { key: 'qualified', label: 'Qualified', width: 90 },
          { key: 'promoted', label: 'Promoted', width: 90 },
        ]} emptyText="No source data yet" />
      </Panel>
      <Panel title="CRM source counts">
        <DataTable data={crmRows} columns={[
          { key: 'source', label: 'Source' },
          { key: 'staging', label: 'Staging', width: 90 },
          { key: 'prod', label: 'Prod', width: 90 },
        ]} emptyText="No CRM source counts yet" />
      </Panel>
      <Panel title="Active scrape runs">
        <DataTable data={jobs} columns={[
          { key: 'run_id', label: 'Run', width: 150 },
          { key: 'platform', label: 'Platform' },
          { key: 'area', label: 'Metro' },
          { key: 'status', label: 'Status' },
          { key: 'pages', label: 'Pages', width: 80 },
          { key: 'records_ingested', label: 'Ingested', width: 90 },
          { key: 'errors', label: 'Errors', width: 80 },
        ]} emptyText="No active scrape runs" />
      </Panel>
      <Panel title="Coverage vs advertised">
        <DataTable data={coverage} columns={[
          { key: 'source', label: 'Platform' },
          { key: 'area', label: 'Metro' },
          { key: 'advertised_total', label: 'Advertised', width: 95 },
          { key: 'unique_ingested', label: 'Ingested', width: 90 },
          { key: 'coverage_pct', label: 'Coverage', width: 90 },
          { key: 'status', label: 'Status' },
        ]} emptyText="No coverage reports yet" />
      </Panel>
      <Panel title="Recent errors">
        <DataTable data={errors} columns={[
          { key: 'updated_at', label: 'Time', width: 170 },
          { key: 'platform', label: 'Platform' },
          { key: 'area', label: 'Metro' },
          { key: 'error', label: 'Error', width: 240 },
        ]} emptyText="No recent scrape errors" />
      </Panel>
    </View>
  );
}
