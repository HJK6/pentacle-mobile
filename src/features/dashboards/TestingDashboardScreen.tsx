import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import { DashboardHeader, DataTable, Empty, Panel, StalenessBadge, record, rows, text } from './DashboardUi';
import type { DashboardRecord, DashboardSnapshot } from './types';

function PanelState({ panel }: { panel: DashboardRecord }) {
  const status = text(panel.status, 'unavailable');
  if (status === 'ok') return null;
  return (
    <View style={[styles.sourceState, status === 'unavailable' && styles.unavailable]}>
      <Text style={styles.sourceStateText}>{status === 'partial' ? 'Partial source visibility' : 'UNKNOWN — source unreadable'}</Text>
      <Text style={styles.sourceCodes}>{Array.isArray(panel.error_codes) ? panel.error_codes.join(', ') : 'source_unavailable'}</Text>
    </View>
  );
}

function TestingPanel({ title, id, panel, children }: { title: string; id: string; panel: DashboardRecord; children: React.ReactNode }) {
  return (
    <Panel title={title} testID={`testing-panel-${id}`}>
      <Text style={styles.updated}>{text(panel.updated_at, 'not observed')}</Text>
      <PanelState panel={panel} />
      {children}
    </Panel>
  );
}

export default function TestingDashboardScreen({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const panels = record(snapshot?.panels);
  const now = record(panels.now_running);
  const gates = record(panels.latest_gate_runs);
  const left = record(panels.whats_left);
  const times = record(panels.time_estimates);
  const analytics = record(panels.per_test_analytics);
  const closures = record(panels.recent_closures);
  const acceptance = Array.isArray(left.unchecked_acceptance) ? left.unchecked_acceptance : [];

  return (
    <View testID="testing-dashboard-screen">
      <DashboardHeader title="Pentacle Mobile Testing" subtitle="Live test execution, remaining work, and timing analytics." />
      <StalenessBadge snapshot={snapshot} />
      <TestingPanel title="Now Running" id="now-running" panel={now}>
        <DataTable data={rows(now.lanes)} columns={[
          { key: 'title', label: 'Lane', width: 210 },
          { key: 'state', label: 'State' },
          { key: 'phase', label: 'Phase' },
          { key: 'last_update', label: 'Last update', width: 170 },
        ]} emptyText="No active lanes" />
        <Text style={styles.subhead}>SIMULATOR QUEUE</Text>
        <Text style={styles.json}>{text(now.sim_queue, 'UNKNOWN — sim-queue unreadable')}</Text>
        <Text style={styles.subhead}>GATE PROCESSES</Text>
        <DataTable data={rows(now.gate_processes)} columns={[
          { key: 'pid', label: 'PID', width: 75 },
          { key: 'kind', label: 'Kind' },
          { key: 'elapsed', label: 'Elapsed' },
          { key: 'artifact_dir', label: 'Artifacts', width: 240 },
        ]} emptyText="No gate processes" />
      </TestingPanel>
      <TestingPanel title="Latest Gate Runs" id="latest-gate-runs" panel={gates}>
        <DataTable testID="testing-latest-gates-table" data={rows(gates.items)} columns={[
          { key: 'run_id', label: 'Run', width: 170 },
          { key: 'sha', label: 'SHA' },
          { key: 'status', label: 'Verdict' },
          { key: 'started_at', label: 'Started', width: 170 },
          { key: 'artifact_path', label: 'Artifacts', width: 240 },
        ]} emptyText="No gate runs observed" />
      </TestingPanel>
      <TestingPanel title="What's Left" id="whats-left" panel={left}>
        <Text style={styles.json}>{text(left.state_counts, '{}')}</Text>
        <Text style={styles.subhead}>UNCHECKED ACCEPTANCE CRITERIA</Text>
        {acceptance.length ? acceptance.slice(0, 100).map((item, index) => <Text key={`${text(item)}-${index}`} style={styles.listItem}>• {text(item)}</Text>) : <Empty>No unchecked criteria observed</Empty>}
        <DataTable data={rows(left.items)} columns={[
          { key: 'status', label: 'State' },
          { key: 'title', label: 'Work item', width: 260 },
        ]} emptyText="No remaining work items" />
      </TestingPanel>
      <TestingPanel title="Time Estimates" id="time-estimates" panel={times}>
        <DataTable data={[{ ...record(times.estimate), last_actual_ms: times.last_actual_ms, estimate_error_ms: times.estimate_error_ms }]} columns={[
          { key: 'total_estimate_ms', label: 'Estimate ms' },
          { key: 'last_actual_ms', label: 'Last actual ms' },
          { key: 'estimate_error_ms', label: 'Error ms' },
        ]} />
        <DataTable data={rows(times.stage_medians)} columns={[
          { key: 'stage', label: 'Stage', width: 180 },
          { key: 'samples', label: 'Samples', width: 80 },
          { key: 'median_ms', label: 'Median ms' },
          { key: 'last_ms', label: 'Last ms' },
        ]} emptyText="No stage timings" />
      </TestingPanel>
      <TestingPanel title="Per-Test Analytics" id="per-test-analytics" panel={analytics}>
        <DataTable testID="testing-per-test-table" data={rows(analytics.items)} columns={[
          { key: 'test_id', label: 'Test', width: 260 },
          { key: 'samples', label: 'Samples', width: 80 },
          { key: 'median_ms', label: 'Median' },
          { key: 'p90_ms', label: 'P90' },
          { key: 'last_ms', label: 'Last' },
          { key: 'estimate_error_ms', label: 'Error' },
        ]} emptyText="No test analytics" />
      </TestingPanel>
      <TestingPanel title="Recent Closures" id="recent-closures" panel={closures}>
        <DataTable data={rows(closures.items)} columns={[
          { key: 'completed_at', label: 'Completed', width: 170 },
          { key: 'title', label: 'Work item', width: 260 },
        ]} emptyText="No recent closures" />
      </TestingPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  updated: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9 },
  sourceState: { backgroundColor: 'rgba(255,181,61,0.12)', borderColor: Tokens.palette.amber, borderRadius: 7, borderWidth: 1, gap: 3, padding: 8 },
  unavailable: { backgroundColor: 'rgba(255,46,62,0.12)', borderColor: Tokens.palette.red },
  sourceStateText: { color: Tokens.palette.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 },
  sourceCodes: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9 },
  subhead: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 0.6, marginTop: 6 },
  json: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, lineHeight: 15 },
  listItem: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.medium, fontSize: 11, lineHeight: 17 },
});
