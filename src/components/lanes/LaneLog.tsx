import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Tokens } from '@/constants/Colors';
import type { LaneCardViewModel, LaneUpdateEntry } from '../../services/workLanes';
import { laneStyles as s } from './laneStyles';
import { emitHarnessUiTrace } from './lanesTelemetry';
import { useWorkLaneShow, type ReadWorkLaneShow } from './useWorkLaneShow';

export type LaneLogTab = 'updates' | 'spec-changes' | 'events';
export const LANE_LOG_PAGE_SIZE = 50;
const TABS: { id: LaneLogTab; label: string }[] = [
  { id: 'updates', label: 'Updates' }, { id: 'spec-changes', label: 'Spec changes' }, { id: 'events', label: 'Events' },
];

export default function LaneLog({ model, connected, updates = [], onBack, readShow, bottom = 18 }: {
  model: LaneCardViewModel; connected: boolean; updates?: LaneUpdateEntry[]; onBack(): void; readShow?: ReadWorkLaneShow; bottom?: number;
}) {
  const [tab, setTab] = useState<LaneLogTab>('updates');
  const [page, setPage] = useState(0);
  const { data, loading, error, retry } = useWorkLaneShow(model.lane.lane_id, connected, true, readShow);
  useEffect(() => { setPage(0); }, [data, tab]);
  const rows = useMemo(() => {
    if (!data) return [];
    if (tab === 'spec-changes') return data.spec_changes.map((row) => ({
      key: `${row.event_id}:${row.spec_id}:${row.field}`, at: row.created_at,
      label: `${row.title} · ${row.field}`, text: `${row.before} → ${row.after}`,
    }));
    if (tab === 'events') return data.events.map((row) => ({
      key: row.event_id, at: row.created_at, label: row.operation,
      text: row.summary || `${row.operation} · ${row.created_at}`,
    }));
    const published = new Map<string, string>();
    for (const entry of updates) {
      if (entry.update.lane_id === model.lane.lane_id && !published.has(entry.update.update_id)) {
        published.set(entry.update.update_id, entry.update.summary);
      }
    }
    const showUpdates = data.updates.length ? data.updates : model.lane.last_update ? [{
      ...model.lane.last_update, created_at: model.lane.last_update.ts, summary: null,
    }] : [];
    return showUpdates.map((row) => ({
      key: row.update_id, at: row.created_at || row.ts, label: row.kind,
      text: row.summary || published.get(row.update_id) || `${row.kind} · ${row.created_at || row.ts}`,
    }));
  }, [data, model.lane.lane_id, model.lane.last_update, tab, updates]);
  const pageCount = Math.max(1, Math.ceil(rows.length / LANE_LOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = rows.slice(currentPage * LANE_LOG_PAGE_SIZE, (currentPage + 1) * LANE_LOG_PAGE_SIZE);
  useEffect(() => { emitHarnessUiTrace('work_lanes_view', { view: 'log', lane_id: model.lane.lane_id, tab }); }, [model.lane.lane_id, tab]);
  useEffect(() => {
    if (data) emitHarnessUiTrace('work_lanes_log_rendered', {
      lane_id: model.lane.lane_id, tab, rows_rendered: shown.length, rows_total: rows.length,
    });
  }, [data, model.lane.lane_id, tab, currentPage, shown.length, rows.length]);
  return <View testID={`lane-log-${model.lane.lane_id}`} style={s.root}>
    <ScrollView key={`${tab}:${currentPage}`} contentContainerStyle={{ paddingBottom: bottom }}>
    <View style={s.header}>
      <Pressable testID="lane-log-back" accessibilityRole="button" accessibilityLabel={`Back to ${model.lane.title}`} onPress={onBack} style={s.button}>
        <Text numberOfLines={2} style={s.buttonText}>‹ {model.lane.title}</Text>
      </Pressable>
      <Text style={s.label}>{model.stateLabel}</Text>
      <View style={s.row}>{TABS.map((item) => <Pressable key={item.id} testID={`lane-log-tab-${item.id}`}
        accessibilityRole="button" accessibilityState={{ selected: tab === item.id }} onPress={() => { setTab(item.id); setPage(0); }}
        style={[s.button, tab === item.id && { borderColor: Tokens.palette.green }]}><Text style={s.buttonText}>{item.label}</Text></Pressable>)}</View>
    </View>
    <View style={s.body}>
      {loading ? <ActivityIndicator testID="lane-log-loading" color={Tokens.palette.green} /> : null}
      {error ? <View testID="lane-log-error" style={s.panel}><Text style={s.error}>{error}</Text>
        <Pressable testID="lane-log-retry" accessibilityRole="button" onPress={() => void retry()} style={s.button}><Text style={s.buttonText}>Retry</Text></Pressable>
      </View> : null}
      {!connected ? <Text style={s.muted}>Waiting for connection…</Text> : null}
      {data && !loading && !error && rows.length === 0 ? <Text testID="lane-log-empty" style={s.muted}>No {TABS.find((item) => item.id === tab)?.label.toLowerCase()}</Text> : null}
      {shown.map((row, index) => <View key={row.key} testID={`lane-log-row-${currentPage * LANE_LOG_PAGE_SIZE + index}`} style={s.panel}>
        <Text style={s.label}>{row.label}</Text><Text style={s.meta}>{row.at}</Text><Text style={s.text}>{row.text}</Text>
      </View>)}
      {currentPage + 1 < pageCount ? <Pressable testID="lane-log-older" accessibilityRole="button" accessibilityLabel="Load older lane log rows"
        onPress={() => setPage(currentPage + 1)} style={s.button}><Text style={s.buttonText}>Older · {currentPage + 1}/{pageCount}</Text></Pressable> : null}
    </View>
    </ScrollView>
  </View>;
}
