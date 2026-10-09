import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { WorkLaneMember, WorkLanesInventory } from 'pentacle-chat-core';
import type { LaneCardViewModel, LaneUpdateEntry } from '../../services/workLanes';
import LaneCard from './LaneCard';
import LaneLog from './LaneLog';
import LaneMembers from './LaneMembers';
import LaneMemberDetail from './LaneMemberDetail';
import LanesMap from './LanesMap';
import { laneStyles as s } from './laneStyles';
import { emitHarnessUiTrace } from './lanesTelemetry';
import type { ReadWorkLaneShow } from './useWorkLaneShow';

type Subview = { view: 'members' | 'log'; laneId: string };
type Detail = { laneId: string; member: WorkLaneMember; inlineAtOpen?: WorkLaneMember };

function currentDetailMember(detail: Detail, inline: WorkLaneMember | undefined): WorkLaneMember {
  const selected = detail.member;
  if (!inline || JSON.stringify(inline) === JSON.stringify(detail.inlineAtOpen)) return selected;
  if (inline.obs_rev != null && selected.obs_rev != null && inline.obs_rev !== selected.obs_rev) {
    return inline.obs_rev > selected.obs_rev ? inline : selected;
  }
  const selectedAt = Date.parse(selected.observation?.observed_at || '');
  const inlineAt = Date.parse(inline.observation?.observed_at || '');
  if (Number.isFinite(inlineAt) && Number.isFinite(selectedAt) && inlineAt < selectedAt) return selected;
  // An inventory received after selection can change observation quality without
  // advancing the spec revision or its last successful observation timestamp.
  return inline;
}
export default function LanesOverlay({ lanes, inventory, assistantName, connected, updates, top, bottom, onChat, onClose, readShow }: {
  lanes: LaneCardViewModel[]; inventory: WorkLanesInventory | null | undefined; assistantName: string; connected: boolean;
  updates: LaneUpdateEntry[]; top: number; bottom: number; onChat(model: LaneCardViewModel): void; onClose(): void; readShow?: ReadWorkLaneShow;
}) {
  const [view, setView] = useState<'list' | 'map'>('list');
  const [focus, setFocus] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [subview, setSubview] = useState<Subview | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const model = lanes.find((entry) => entry.lane.lane_id === (detail?.laneId || subview?.laneId));
  const member = detail && currentDetailMember(detail, model?.members.find((item) => item.spec_id === detail.member.spec_id));
  useEffect(() => {
    if (!inventory) return;
    emitHarnessUiTrace('work_lanes_inventory_applied', {
      wire: inventory.lanes.some((lane) => lane.members !== undefined) || inventory.work_index !== undefined ? 'inc1' : 'v1',
      lane_ids: inventory.lanes.map((lane) => lane.lane_id), counts: inventory.counts,
      lanes_with_members: inventory.lanes.filter((lane) => lane.members !== undefined).length,
    });
  }, [inventory]);
  useEffect(() => {
    if (detail) emitHarnessUiTrace('work_lanes_view', { view: 'member_detail', lane_id: detail.laneId, spec_id: detail.member.spec_id });
    else if (subview?.view === 'members') emitHarnessUiTrace('work_lanes_view', { view: 'members', lane_id: subview.laneId });
    else if (!subview) emitHarnessUiTrace('work_lanes_view', { view });
  }, [view, subview, detail]);
  useEffect(() => {
    if (subview && !lanes.some((entry) => entry.lane.lane_id === subview.laneId)) setSubview(null);
    if (detail && !lanes.some((entry) => entry.lane.lane_id === detail.laneId)) setDetail(null);
  }, [lanes, subview, detail]);
  const openMember = (entry: LaneCardViewModel, nextMember: WorkLaneMember) => setDetail({ laneId: entry.lane.lane_id, member: nextMember, inlineAtOpen: entry.members.find((item) => item.spec_id === nextMember.spec_id) });
  const showAll = (entry: LaneCardViewModel) => setSubview({ view: 'members', laneId: entry.lane.lane_id });
  const showLog = (entry: LaneCardViewModel) => setSubview({ view: 'log', laneId: entry.lane.lane_id });
  const nested = !!subview || !!detail;
  return <View testID="lanes-overlay" style={s.root}>
    <View style={[s.header, { paddingTop: top }]}>
      <View style={s.row}><Text numberOfLines={2} accessibilityLabel={assistantName} style={[s.title, { flex: 1 }]}>{assistantName}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close lanes" onPress={onClose} style={s.button}><Text style={s.buttonText}>✕</Text></Pressable></View>
      {!nested ? <View testID="lanes-view-toggle" accessibilityValue={{ text: view }} style={s.row}>
        {(['list', 'map'] as const).map((value) => <Pressable key={value} testID={`lanes-view-${value}`} accessibilityRole="button"
          accessibilityLabel={`${value === 'list' ? 'List' : 'Map'} view`} accessibilityState={{ selected: view === value }}
          onPress={() => setView(value)} style={s.button}><Text style={s.buttonText}>{value === 'list' ? 'List' : 'Map'}</Text></Pressable>)}
      </View> : null}
      {inventory?.work_index?.available === false ? <Text testID="lanes-index-banner" style={s.muted}>Data as of {inventory.work_index.snapshot_at || 'unknown'}</Text> : null}
    </View>
    <View style={[styles.content, nested && styles.hidden]} accessibilityElementsHidden={nested} importantForAccessibility={nested ? 'no-hide-descendants' : 'auto'}>
      <View style={[styles.content, view !== 'list' && styles.hidden]} accessibilityElementsHidden={view !== 'list'} importantForAccessibility={view !== 'list' ? 'no-hide-descendants' : 'auto'}>
        <ScrollView contentContainerStyle={[s.body, { paddingBottom: bottom }]}>
          <Text style={s.label}>Open lanes · {inventory?.counts.open ?? 0}</Text>
          {lanes.length === 0 ? <Text style={s.muted}>No open lanes</Text> : null}
          {inventory?.truncated ? <Text style={s.muted}>Showing {lanes.length} of {inventory.counts.open} open lanes</Text> : null}
          {lanes.map((entry) => <LaneCard key={entry.lane.lane_id} model={entry} onOpenMember={openMember} onShowAll={showAll} onLog={showLog} onChat={onChat} />)}
        </ScrollView>
      </View>
      {view === 'map' ? <LanesMap lanes={lanes} assistantName={assistantName} focusedLaneId={focus} onFocusLane={setFocus} page={page} onPageChange={setPage}
        onOpenMember={openMember} onShowAll={showAll} onLog={showLog} onChat={onChat} /> : null}
    </View>
    {subview && model ? <View style={[styles.content, detail !== null && styles.hidden]} accessibilityElementsHidden={detail !== null} importantForAccessibility={detail ? 'no-hide-descendants' : 'auto'}>
      {subview.view === 'members' ? <LaneMembers model={model} connected={connected} onBack={() => setSubview(null)} onOpenMember={(nextMember) => openMember(model, nextMember)} readShow={readShow} bottom={bottom} />
        : <LaneLog model={model} connected={connected} updates={updates} onBack={() => setSubview(null)} readShow={readShow} bottom={bottom} />}
    </View> : null}
    {detail && model && member ? <LaneMemberDetail member={member} laneTitle={model.lane.title} onBack={() => setDetail(null)} bottom={bottom} /> : null}
  </View>;
}
const styles = StyleSheet.create({ content: { flex: 1 }, hidden: { display: 'none' } });
