import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { WorkLaneMember } from 'pentacle-chat-core';
import { Fonts, Tokens, type MachineSigilKind } from '@/constants/Colors';
import type { LaneCardViewModel } from '../../services/workLanes';
import MachineSigil from '../MachineSigil';
import { emitHarnessUiTrace } from './lanesTelemetry';

type Props = {
  lanes: LaneCardViewModel[];
  assistantName: string;
  assistantSigil?: MachineSigilKind;
  focusedLaneId: string | null;
  onFocusLane: (laneId: string | null) => void;
  /** Zero-based page, retained by the overlay while a detail or log is open. */
  page: number;
  onPageChange: (page: number) => void;
  onOpenMember: (model: LaneCardViewModel, member: WorkLaneMember) => void;
  onShowAll: (model: LaneCardViewModel) => void;
  onLog: (model: LaneCardViewModel) => void;
  onChat: (model: LaneCardViewModel) => void;
};

const PAGE_SIZE = 8;
const NODE_SIZE = 52;
const GAP = 8;
// Clockwise perimeter slots leave each full label and its hit target disjoint,
// including at narrow widths and large accessibility text sizes.
const ORBIT_SLOTS = [[1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1], [0, 0]] as const;

function memberStatus(member: WorkLaneMember): string {
  return member.status ? member.status.replace(/_/g, ' ') : 'Status unavailable';
}

function memberColor(model: LaneCardViewModel, member: WorkLaneMember): string {
  const segment = model.segments.find((entry) => entry.specId === member.spec_id);
  if (segment?.unresolved) return Tokens.palette.red;
  switch (member.status) {
    case 'missing':
    case 'ambiguous': return Tokens.palette.red;
    case 'in_progress': return Tokens.palette[model.stateTone];
    case 'completed': return Tokens.palette.green;
    case 'needs_qa': return Tokens.palette.text;
    case 'ready_for_dev':
    case 'analysis': return Tokens.palette.dim;
    default: return Tokens.palette.muted;
  }
}

function LaneNode({ model, selected, onPress, position }: {
  model: LaneCardViewModel;
  selected: boolean;
  onPress: () => void;
  position: { left: number; top: number; width: number; height: number };
}) {
  const { lane } = model;
  const color = Tokens.palette[model.stateTone];
  const counts = model.membersPending ? '—/—' : `${model.completed}/${model.total}`;
  const working = lane.state === 'active' && lane.lead?.presence.working === true;
  return <Pressable testID={`lanes-map-lane-${lane.lane_id}`} accessibilityRole="button"
    accessibilityLabel={`${lane.title}, ${model.stateLabel}, ${counts}`}
    accessibilityHint={model.waitingOnYouLabel ?? undefined}
    accessibilityState={{ selected }} onPress={onPress} style={[styles.node, position]}>
    <View style={[styles.nodeRing, { borderColor: color }, selected && styles.selectedRing]}>
      <MachineSigil kind="rune" size={30} color={color} />
      {working ? <View testID={`lanes-map-working-${lane.lane_id}`} style={[styles.working, { backgroundColor: color }]} /> : null}
      {model.waitingOnYou > 0 ? <Text testID={`lanes-map-waiting-${lane.lane_id}`} allowFontScaling={false}
        style={styles.questionBadge}>?{model.waitingOnYou}</Text> : null}
    </View>
    <Text style={styles.nodeTitle} numberOfLines={2}>{lane.title}</Text>
    <Text style={[styles.nodeMeta, { color }]} numberOfLines={1}>{counts}</Text>
  </Pressable>;
}

function Spoke({ x, y, cx, cy, color }: { x: number; y: number; cx: number; cy: number; color: string }) {
  const dx = x - cx;
  const dy = y - cy;
  const length = Math.sqrt(dx * dx + dy * dy);
  return <View pointerEvents="none" style={{ position: 'absolute', height: 1, width: length,
    left: (x + cx - length) / 2, top: (y + cy) / 2, backgroundColor: color, opacity: 0.28,
    transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
}

export default function LanesMap({ lanes, assistantName, assistantSigil = 'djinni', focusedLaneId, onFocusLane,
  page, onPageChange, onOpenMember, onShowAll, onLog, onChat }: Props) {
  const dimensions = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const openLanes = lanes.filter((model) => model.lane.state !== 'done');
  const pageCount = Math.max(1, Math.ceil(openLanes.length / PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(Math.floor(page) || 0, pageCount - 1));
  const pageLanes = openLanes.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const focused = openLanes.find((model) => model.lane.lane_id === focusedLaneId);
  const members = focused && !focused.membersPending && !focused.lane.no_spec_reason
    ? focused.members.slice(0, PAGE_SIZE) : [];
  const moreCount = focused && !focused.membersPending && !focused.lane.no_spec_reason && focused.membersTotal > PAGE_SIZE
    ? focused.membersTotal - members.length : 0;
  const width = Math.max(160, (measuredWidth ?? dimensions.width) - 24);
  const nodeWidth = (width - GAP * 2) / 3;
  const fontScale = Math.max(1, dimensions.fontScale || 1);
  const nodeHeight = NODE_SIZE + 22 + 44 * fontScale;
  const canvasHeight = nodeHeight * 3 + GAP * 2;
  const center = { left: nodeWidth + GAP, top: nodeHeight + GAP, width: nodeWidth, height: nodeHeight };
  const cx = center.left + nodeWidth / 2;
  const cy = center.top + NODE_SIZE / 2;
  const positions = (focused ? members : pageLanes).map((_, index, entries) => {
    const [column, row] = ORBIT_SLOTS[Math.floor(index * PAGE_SIZE / entries.length)];
    return { left: column * (nodeWidth + GAP), top: row * (nodeHeight + GAP), width: nodeWidth, height: nodeHeight };
  });
  const color = focused ? Tokens.palette[focused.stateTone] : Tokens.palette.green;
  const renderedLaneIds = focused ? [focused.lane.lane_id] : pageLanes.map((model) => model.lane.lane_id);
  const renderedMemberIds = members.map((member) => member.spec_id);

  useEffect(() => {
    if (currentPage !== page) onPageChange(currentPage);
  }, [currentPage, page, onPageChange]);

  useEffect(() => {
    if (focusedLaneId !== null && !focused) onFocusLane(null);
  }, [focusedLaneId, focused, onFocusLane]);

  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [focused?.lane.lane_id, currentPage]);

  useEffect(() => {
    emitHarnessUiTrace('work_lanes_map_render', {
      page: currentPage + 1, page_count: pageCount, lane_nodes: renderedLaneIds.length,
      focused_lane_id: focused?.lane.lane_id ?? null,
      member_nodes: members.length + (moreCount > 0 ? 1 : 0), more_count: moreCount,
    });
  }, [currentPage, pageCount, renderedLaneIds.join('|'), renderedMemberIds.join('|'), focused?.lane.lane_id, moreCount]);

  return <ScrollView ref={scroll} testID="lanes-map" style={styles.root} contentContainerStyle={styles.content}
    onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}>
    {focused ? <Pressable testID="lanes-map-back" accessibilityRole="button" accessibilityLabel="Back to all lanes"
      onPress={() => onFocusLane(null)} style={styles.back}>
      <Text style={styles.actionText}>‹ All lanes</Text>
    </Pressable> : <Text style={styles.hint}>Choose a lane to explore its specs</Text>}
    {!focused && pageLanes.some((model) => model.membersPending)
      ? <Text testID="lanes-map-members-pending" style={styles.hint}>Specs arrive when the daemon updates</Text> : null}

    <View testID="lanes-map-orbit" style={{ width, height: canvasHeight, alignSelf: 'center' }}>
      <View pointerEvents="none" style={[styles.orbit, { left: nodeWidth / 2, top: NODE_SIZE / 2,
        width: (nodeWidth + GAP) * 2, height: (nodeHeight + GAP) * 2, borderColor: color }]} />
      {positions.map((position, index) => <Spoke key={index} x={position.left + nodeWidth / 2}
        y={position.top + NODE_SIZE / 2} cx={cx} cy={cy}
        color={focused ? memberColor(focused, members[index]) : Tokens.palette[pageLanes[index].stateTone]} />)}
      {focused ? <LaneNode model={focused} selected onPress={() => onFocusLane(focused.lane.lane_id)} position={center} />
        : <Pressable testID="lanes-map-assistant" accessibilityRole="button" accessibilityLabel={assistantName}
          accessibilityHint="All lanes" accessibilityState={{ selected: false }} onPress={() => onFocusLane(null)}
          style={[styles.node, center]}>
          <View style={[styles.nodeRing, styles.assistantRing]}><MachineSigil kind={assistantSigil} size={34} /></View>
          <Text style={styles.nodeTitle} numberOfLines={2}>{assistantName}</Text>
        </Pressable>}
      {focused ? members.map((member, index) => {
        const tone = memberColor(focused, member);
        const title = member.title || member.spec_id;
        const quality = member.observation?.quality;
        return <Pressable key={member.spec_id} testID={`lanes-map-member-${member.spec_id}`}
          accessibilityRole="button" accessibilityLabel={`${title}, ${memberStatus(member)}`}
          accessibilityState={{ selected: false }} onPress={() => onOpenMember(focused, member)}
          style={[styles.node, positions[index]]}>
          <View style={[styles.nodeRing, { borderColor: tone }, quality && quality !== 'fresh' && styles.observationRing]}>
            <Text style={[styles.memberGlyph, { color: tone }]} allowFontScaling={false}>
              {member.status === 'completed' ? '✓' : member.status === 'missing' || member.status === 'ambiguous' ? '!'
                : member.status === 'needs_qa' ? '◉' : '○'}
            </Text>
          </View>
          <Text style={styles.nodeTitle} numberOfLines={2}>{title}</Text>
          <Text style={[styles.nodeMeta, { color: tone }]} numberOfLines={1}>
            {member.ac_checked != null && member.ac_total != null ? `${member.ac_checked}/${member.ac_total}` : '—'}
          </Text>
        </Pressable>;
      }) : pageLanes.map((model, index) => <LaneNode key={model.lane.lane_id} model={model} selected={false}
        onPress={() => onFocusLane(model.lane.lane_id)} position={positions[index]} />)}
    </View>

    {focused ? <>
      {moreCount > 0 ? <Pressable testID={`lanes-map-more-${focused.lane.lane_id}`} accessibilityRole="button"
        accessibilityLabel={`Show all ${focused.membersTotal} specs`} accessibilityState={{ selected: false }}
        onPress={() => onShowAll(focused)} style={styles.more}>
        <Text style={styles.actionText}>+{moreCount} more</Text>
      </Pressable> : null}
      <View style={[styles.detail, { borderColor: `${color}66` }]}>
        <Text style={[styles.state, { color }]}>{focused.stateLabel}</Text>
        <Text style={styles.title}>{focused.lane.title}</Text>
        {focused.lane.summary ? <Text style={styles.body}>{focused.lane.summary}</Text> : null}
        <Text style={styles.meta}>{focused.leadHost ? `${focused.leadHost} · ` : ''}{focused.presenceLabel} · {focused.freshnessLabel}</Text>
        {focused.blockerLabel ? <Text style={styles.warning}>{focused.blockerLabel}</Text> : null}
        {focused.waitingOnYouLabel && focused.waitingOnYouLabel !== focused.blockerLabel
          ? <Text style={styles.warning}>? {focused.waitingOnYouLabel}</Text> : null}
        <Text testID={`lanes-map-progress-${focused.lane.lane_id}`} style={styles.progress}>{focused.progressLabel}</Text>
        {focused.membersPending ? <Text testID={`lanes-map-members-pending-${focused.lane.lane_id}`} style={styles.body}>
          Specs arrive when the daemon updates
        </Text> : null}
        {focused.segments.length > 0 && !focused.lane.no_spec_reason ? <View style={styles.segments}>
          {focused.segments.map((segment) => <View key={segment.specId} style={[styles.segment,
            segment.unresolved && { backgroundColor: `${Tokens.palette.red}44` }]}>
            <View style={{ height: '100%', width: `${segment.fraction * 100}%`, backgroundColor: Tokens.palette[segment.tone] }} />
          </View>)}
        </View> : null}
        {focused.lastUpdateText ? <Text style={styles.body}>{focused.lastUpdateText}</Text> : null}
        <Pressable testID={`lanes-map-log-${focused.lane.lane_id}`} accessibilityRole="button" accessibilityLabel="Open lane log"
          onPress={() => onLog(focused)} style={styles.action}>
          <Text style={styles.actionText}>Lane log ›</Text>
        </Pressable>
        <Pressable testID={`lanes-map-chat-${focused.lane.lane_id}`} accessibilityRole="button"
          accessibilityLabel={focused.tap.action === 'unavailable' ? 'Chat unavailable' : 'See chat'}
          accessibilityState={{ disabled: focused.tap.action === 'unavailable' }} disabled={focused.tap.action === 'unavailable'}
          onPress={() => onChat(focused)} style={styles.action}>
          <Text style={[styles.actionText, focused.tap.action === 'unavailable' && styles.unavailable]}>
            {focused.tap.action === 'unavailable' ? 'Chat unavailable' : focused.tap.action === 'history' ? 'View closed chat ›' : 'See chat ›'}
          </Text>
        </Pressable>
      </View>
    </> : <>
      {openLanes.length === 0 ? <Text style={styles.empty}>No open lanes</Text> : null}
      <View style={styles.pager}>
        <Pressable testID="lanes-map-page-prev" accessibilityRole="button" accessibilityLabel="Previous lanes page"
          disabled={currentPage === 0} accessibilityState={{ disabled: currentPage === 0 }}
          onPress={() => onPageChange(currentPage - 1)} style={styles.pageButton}>
          <Text style={[styles.actionText, currentPage === 0 && styles.unavailable]}>‹</Text>
        </Pressable>
        <Text testID="lanes-map-page-label" accessibilityLabel={`Page ${currentPage + 1} of ${pageCount}`} style={styles.pageLabel}>
          {currentPage + 1}/{pageCount}
        </Text>
        <Pressable testID="lanes-map-page-next" accessibilityRole="button" accessibilityLabel="Next lanes page"
          disabled={currentPage >= pageCount - 1} accessibilityState={{ disabled: currentPage >= pageCount - 1 }}
          onPress={() => onPageChange(currentPage + 1)} style={styles.pageButton}>
          <Text style={[styles.actionText, currentPage >= pageCount - 1 && styles.unavailable]}>›</Text>
        </Pressable>
      </View>
    </>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  content: { paddingVertical: 12, paddingBottom: 28 },
  hint: { marginHorizontal: 16, marginBottom: 12, fontFamily: Fonts.rajdhani.medium, fontSize: 14, color: Tokens.palette.dim },
  orbit: { position: 'absolute', borderWidth: 1, borderStyle: 'dashed', borderRadius: 120, opacity: 0.18 },
  node: { position: 'absolute', alignItems: 'center', minWidth: 44, minHeight: 44 },
  nodeRing: { width: NODE_SIZE, height: NODE_SIZE, borderRadius: NODE_SIZE / 2, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: Tokens.palette.panel },
  selectedRing: { borderWidth: 3 },
  assistantRing: { borderColor: Tokens.palette.green, backgroundColor: Tokens.palette.ink },
  nodeTitle: { fontFamily: Fonts.rajdhani.bold, fontSize: 13, lineHeight: 15, color: Tokens.palette.text,
    textAlign: 'center', marginTop: 6, paddingHorizontal: 2, maxWidth: '100%' },
  nodeMeta: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, lineHeight: 14, marginTop: 3, maxWidth: '100%' },
  working: { width: 9, height: 9, borderRadius: 5, position: 'absolute', top: 0, right: 0 },
  questionBadge: { position: 'absolute', top: -3, left: -5, minWidth: 27, paddingHorizontal: 3, height: 20, textAlign: 'center',
    fontFamily: Fonts.jetBrainsMono.bold, fontSize: 13, color: Tokens.palette.amber, backgroundColor: Tokens.palette.ink,
    borderColor: Tokens.palette.amber, borderWidth: 1, borderRadius: 10 },
  memberGlyph: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 25 },
  observationRing: { borderStyle: 'dashed' },
  back: { minHeight: 44, minWidth: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 16, marginBottom: 8 },
  more: { alignSelf: 'center', minWidth: 100, minHeight: 44, justifyContent: 'center', alignItems: 'center',
    borderColor: Tokens.palette.line, borderWidth: 1, borderRadius: 22, paddingVertical: 10, paddingHorizontal: 16, marginBottom: 16 },
  detail: { backgroundColor: Tokens.palette.panel, borderTopWidth: 1, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    padding: 16, gap: 10 },
  state: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1 },
  title: { fontFamily: Fonts.rajdhani.bold, fontSize: 21, color: Tokens.palette.text },
  body: { fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, color: Tokens.palette.dim },
  meta: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, color: Tokens.palette.muted },
  warning: { fontFamily: Fonts.rajdhani.bold, fontSize: 14.5, color: Tokens.palette.amber },
  progress: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 13, color: Tokens.palette.text },
  segments: { flexDirection: 'row', gap: 3 },
  segment: { flex: 1, height: 5, borderRadius: 2, overflow: 'hidden', backgroundColor: Tokens.palette.line },
  action: { minWidth: 44, minHeight: 44, borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4,
    paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  actionText: { fontFamily: Fonts.rajdhani.bold, fontSize: 16, color: Tokens.palette.green },
  unavailable: { color: Tokens.palette.muted },
  empty: { fontFamily: Fonts.rajdhani.medium, fontSize: 16, color: Tokens.palette.dim, textAlign: 'center' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 16 },
  pageButton: { minWidth: 44, minHeight: 44, padding: 10, alignItems: 'center', justifyContent: 'center' },
  pageLabel: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 12, color: Tokens.palette.dim, flexShrink: 1 },
});
