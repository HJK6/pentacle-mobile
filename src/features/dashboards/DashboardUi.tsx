import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import type { DashboardRecord, DashboardSnapshot } from './types';

const P = Tokens.palette;

export function text(value: unknown, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function count(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : '0';
}

export function rows(value: unknown): DashboardRecord[] {
  return Array.isArray(value) ? value.filter((item): item is DashboardRecord => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}

export function record(value: unknown): DashboardRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DashboardRecord : {};
}

export function DashboardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.eyebrow}>DASHBOARD HUB</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

export function StalenessBadge({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const offline = !snapshot || snapshot._transport_stale;
  const stale = !snapshot || snapshot._data_stale;
  const label = offline ? 'OFFLINE' : stale ? 'STALE' : 'LIVE';
  const detail = snapshot ? `${Math.round(snapshot._age_sec)}s old` : 'No snapshot';
  return (
    <View
      accessibilityLabel={`Dashboard data ${label.toLowerCase()}, ${detail}`}
      style={[styles.badge, offline ? styles.badgeOffline : stale ? styles.badgeStale : styles.badgeLive]}
      testID="dashboard-staleness-badge"
    >
      <Text style={styles.badgeText}>{label}</Text>
      <Text style={styles.badgeDetail}>{detail}</Text>
    </View>
  );
}

export function Panel({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.panel} testID={testID}>
      <Text style={styles.panelTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Empty({ children = 'No data yet' }: { children?: React.ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>;
}

export function MetricGrid({ metrics, testID }: { metrics: Array<{ label: string; value: unknown }>; testID?: string }) {
  return (
    <View style={styles.metricGrid}>
      {metrics.map((metric) => (
        <View key={metric.label} style={styles.metric}>
          <Text
            style={styles.metricValue}
            testID={testID ? `${testID}-${metric.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined}
          >
            {count(metric.value)}
          </Text>
          <Text style={styles.metricLabel}>{metric.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function StageFlow({ stages }: { stages: DashboardRecord[] }) {
  if (!stages.length) return <Empty>No pipeline stages yet</Empty>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator testID="dashboard-stage-flow">
      <View style={styles.stageRow}>
        {stages.map((stage, index) => {
          const state = text(stage.state, 'waiting').toLowerCase();
          return (
            <React.Fragment key={text(stage.stage, `stage-${index}`)}>
              {index > 0 ? <Text style={styles.arrow}>›</Text> : null}
              <View style={[styles.stage, state === 'running' && styles.stageRunning, state === 'complete' && styles.stageComplete, ['failed', 'blocked'].includes(state) && styles.stageFailed]}>
                <Text style={styles.stageName}>{text(stage.label || stage.stage)}</Text>
                <Text style={styles.stageState}>{state.toUpperCase()}</Text>
                {stage.count !== undefined ? <Text style={styles.stageCount}>{count(stage.count)}</Text> : null}
              </View>
            </React.Fragment>
          );
        })}
      </View>
    </ScrollView>
  );
}

export function DataTable({
  columns,
  data,
  emptyText = 'No rows yet',
  testID,
}: {
  columns: Array<{ key: string; label: string; width?: number; render?: (row: DashboardRecord) => unknown }>;
  data: DashboardRecord[];
  emptyText?: string;
  testID?: string;
}) {
  if (!data.length) return <Empty>{emptyText}</Empty>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator testID={testID}>
      <View>
        <View style={styles.tableRow}>
          {columns.map((column) => <Text key={column.key} style={[styles.tableHead, { width: column.width || 120 }]}>{column.label}</Text>)}
        </View>
        {data.map((row, rowIndex) => (
          <View key={`${text(row.id || row.run_id || row.title || row.stage, 'row')}-${rowIndex}`} style={styles.tableRow}>
            {columns.map((column) => (
              <Text
                key={column.key}
                numberOfLines={4}
                style={[styles.tableCell, { width: column.width || 120 }]}
                testID={testID ? `${testID}-row-${rowIndex}-${column.key}` : undefined}
              >
                {text(column.render ? column.render(row) : row[column.key])}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4, marginBottom: 12 },
  eyebrow: { color: P.green, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1.8 },
  title: { color: P.text, fontFamily: Fonts.cinzel.bold, fontSize: 25 },
  subtitle: { color: P.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 13, lineHeight: 19 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, borderWidth: 1, flexDirection: 'row', gap: 7, marginBottom: 12, paddingHorizontal: 10, paddingVertical: 5 },
  badgeLive: { backgroundColor: 'rgba(61,255,102,0.10)', borderColor: P.green },
  badgeStale: { backgroundColor: 'rgba(255,181,61,0.12)', borderColor: P.amber },
  badgeOffline: { backgroundColor: 'rgba(255,46,62,0.12)', borderColor: P.red },
  badgeText: { color: P.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 0.8 },
  badgeDetail: { color: P.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10 },
  panel: { backgroundColor: P.panel, borderColor: P.line, borderRadius: 10, borderWidth: 1, gap: 10, marginBottom: 12, overflow: 'hidden', padding: 12 },
  panelTitle: { color: P.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  empty: { color: P.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 12, paddingVertical: 8 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { backgroundColor: P.codePanel, borderColor: P.line, borderRadius: 8, borderWidth: 1, minWidth: '46%', padding: 10 },
  metricValue: { color: P.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 20 },
  metricLabel: { color: P.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 0.6, marginTop: 3, textTransform: 'uppercase' },
  stageRow: { alignItems: 'center', flexDirection: 'row', paddingBottom: 4 },
  stage: { backgroundColor: P.codePanel, borderColor: P.line, borderRadius: 8, borderWidth: 1, minHeight: 76, padding: 10, width: 120 },
  stageRunning: { borderColor: '#4da3ff' },
  stageComplete: { borderColor: P.green },
  stageFailed: { borderColor: P.red },
  stageName: { color: P.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 11 },
  stageState: { color: P.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, marginTop: 7 },
  stageCount: { color: P.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 16, marginTop: 4 },
  arrow: { color: P.muted, fontSize: 24, paddingHorizontal: 5 },
  tableRow: { borderBottomColor: P.line, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  tableHead: { color: P.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 0.4, paddingHorizontal: 7, paddingVertical: 7, textTransform: 'uppercase' },
  tableCell: { color: P.text, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, lineHeight: 15, paddingHorizontal: 7, paddingVertical: 8 },
});
