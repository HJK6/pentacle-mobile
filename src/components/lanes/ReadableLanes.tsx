import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, LayoutAnimation, Pressable, ScrollView, Text, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import {
  derivedDefaultGoal, readableAge, readableDay, readableDots, readableHomeCounts, readableHours, readableItemKind, readableItemOrder, readableLaneClass,
  readableLeadGoals, readableRoad, readableSeatCount, readableSentence, readableStopWord, readableTrouble,
  type ItemKind, type LaneClass, type RoadStop, type WorkLane, type WorkLaneMember, type WorkLaneRecent, type WorkLanesInventory,
} from 'pentacle-chat-core';
import { Fonts } from '@/constants/Colors';
import HeaderVoiceMic from '../voice/HeaderVoiceMic';
import MachineSigil from '../MachineSigil';
import Starfield from '../Starfield';
import QuestionDeckCard from '../questions/QuestionDeckCard';
import { laneQuestionCardStore } from '../questions/questionCardStore';
import { laneNeedsYou, laneWorking, type LaneCardViewModel } from '../../services/workLanes';
import { useVoiceSurface } from '../../services/voicePresentation';
import { body, Icon, label, LaneMark, LeafLoading, LeafText, mono, p } from './LaneAtoms';
import LanesConstellation, { type ConstellationNode } from './LanesConstellation';
import { GoalDots, ItemMark, NumRing, RoadBar, ringTone, Spark } from './RoadMarks';
import { StackView, useScreenStack, type Box } from './LanesStack';
import { useReduceMotion, useWorkingMotion } from './useWorkingMotion';
import { useWorkLaneShow, type ReadWorkLaneShow } from './useWorkLaneShow';
import { useLaneMembers } from './useLaneMembers';

type Entry = { kind: 'home' } | { kind: 'parked' } | { kind: 'lane'; laneId: string }
  | { kind: 'goal'; laneId: string; goalId: string | null } | { kind: 'item'; laneId: string; goalId: string | null; memberId: string };
type Open = (entry: Entry, event?: GestureResponderEvent, hero?: { node: React.ReactNode; ref: React.RefObject<View | null> }) => void;
type Motion = { phase: Animated.Value; moving: boolean };
const titleStyle = { ...body, color: p.text, fontFamily: Fonts.rajdhani.bold, fontSize: 16 };
const stageLabels: Record<string, string> = { analysis: 'Planning', in_progress: 'Building', needs_qa: 'In review', blocked: 'Blocked', backlog: 'Queued', ready_for_dev: 'Queued', completed: 'Done' };
const memberTitle = (member: WorkLaneMember) => member.title || member.spec_id;
const hasQuestion = (member: WorkLaneMember) => (member.open_questions?.count ?? 0) > 0;
const ago = (at: string | null | undefined) => { const age = readableAge(at); return age ? `${age} ago` : null; };
const goalKey = (goalId: string | null) => goalId ?? 'default';
const yellowKind = (kind: ItemKind) => kind === 'blocked' || kind === 'needs';
const quietClass = (cls: LaneClass) => cls === 'idle' || cls === 'paused' || cls === 'parked';

function Header({ hero, title, crumb, sub, subTone, onBack, onClose, onHero, heroHidden }: {
  hero: React.ReactNode; title: string; crumb?: string | null; sub?: string | null; subTone?: string; onBack?(): void; onClose(): void; onHero?(box: Box): void; heroHidden?: boolean;
}) {
  return <View style={{ paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, borderColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
    {onBack ? <Pressable testID="lanes-back" accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center' }}><Icon kind="back" /></View></Pressable> : null}
    <View testID="lanes-header-hero" onLayout={e => onHero?.(e.nativeEvent.layout)} style={{ opacity: heroHidden ? 0 : 1 }}>{hero}</View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text testID="readable-header-title" numberOfLines={2} style={{ ...titleStyle, fontSize: 18, lineHeight: 21 }}>{title}</Text>
      {crumb || sub ? <Text numberOfLines={1} style={{ ...mono, letterSpacing: 0.3, marginTop: 2 }}>{crumb ? <Text>{crumb}</Text> : null}{crumb && sub ? ' · ' : null}{sub ? <Text style={{ color: subTone ?? p.muted }}>{sub}</Text> : null}</Text> : null}
    </View>
    <HeaderVoiceMic /><Pressable testID="lanes-close" accessibilityRole="button" accessibilityLabel="Close lanes" onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center' }}><Icon kind="close" /></View></Pressable>
  </View>;
}
function Badge({ kind, tone }: { kind: 'parked' | 'spec' | 'home'; tone: string }) {
  return <View style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: tone, alignItems: 'center', justifyContent: 'center' }}>
    {kind === 'home' ? <MachineSigil kind="djinni" size={20} color={tone} /> : <Icon kind={kind} size={17} color={kind === 'parked' ? p.muted : p.text} />}
  </View>;
}
function Section({ name, count, tone = p.muted }: { name: string; count?: number; tone?: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, marginBottom: 2 }}>
    <Text testID={`readable-section-${name.toLowerCase().replace(/\s+/g, '-')}`} style={{ ...label, color: tone, letterSpacing: 1.6, fontSize: 10 }}>{name}{count != null ? ` · ${count}` : ''}</Text>
    <View style={{ flex: 1, height: 1, backgroundColor: p.line }} />
  </View>;
}
function Fold({ id, text, onPress }: { id: string; text: string; onPress(): void }) {
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderColor: p.line }}>
    <Text style={{ ...body, fontSize: 14.5, color: p.muted, flex: 1 }}>{text}</Text><Icon kind="chevron" size={13} color={p.muted} />
  </Pressable>;
}
/** The one row: mark, title, age, one sentence. Small rows carry the title only. */
function ItemRow({ member, small = false, pulse, first, onPress }: { member: WorkLaneMember; small?: boolean; pulse: Motion; first?: boolean; onPress(e: GestureResponderEvent): void }) {
  const kind = readableItemKind(member), sentence = small ? null : readableSentence(member);
  const right = kind === 'done' ? readableDay(member.progress_at) : readableAge(member.progress_at);
  return <Pressable testID={`spec-row-${member.spec_id}`} accessibilityRole="button" onPress={onPress}
    style={{ flexDirection: 'row', gap: 10, paddingVertical: small ? 8 : 11, minHeight: 44, borderTopWidth: first ? 0 : 1, borderColor: p.line }}>
    <ItemMark kind={kind} testID={`item-mark-${member.spec_id}-${kind}`} pulse={kind === 'working' && pulse.moving ? pulse.phase : null} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text numberOfLines={2} style={{ flex: 1, fontFamily: small ? Fonts.rajdhani.medium : Fonts.rajdhani.bold, fontSize: small ? 14.5 : 15.5, lineHeight: 19, color: small ? p.dim : p.text }}>{memberTitle(member)}</Text>
        {right ? <Text style={{ ...mono, letterSpacing: 0.6 }}>{right}</Text> : null}
      </View>
      {sentence ? <Text style={{ ...body, marginTop: 3, color: yellowKind(kind) ? p.yellow : p.dim }}>{sentence}</Text> : null}
    </View>
  </Pressable>;
}
/** A list that really opens: the first `cap` rows, then the rest in place; a closed list opens on tap. */
function ItemList({ id, members, cap, small, closed, pulse, onItem }: { id: string; members: WorkLaneMember[]; cap: number; small?: boolean; closed?: string; pulse: Motion; onItem(m: WorkLaneMember, e: GestureResponderEvent): void }) {
  const [all, setAll] = useState(false), [shut, setShut] = useState(!!closed);
  if (shut) return <Fold id={`${id}-open`} text={`Show ${members.length} ${closed}`} onPress={() => setShut(false)} />;
  return <>{(all ? members : members.slice(0, cap)).map((m, i) => <ItemRow key={m.spec_id} first={i === 0} member={m} small={small} pulse={pulse} onPress={e => onItem(m, e)} />)}
    {members.length > cap && !all ? <Fold id={`${id}-more`} text={`Show ${members.length - cap} more`} onPress={() => setAll(true)} /> : null}</>;
}
function Recent({ entries, members }: { entries?: WorkLaneRecent[]; members: WorkLaneMember[] }) {
  if (!entries?.length) return null;
  return <><Section name="Recent" />{entries.map((entry, index) => {
    const member = members.find(m => m.spec_id === entry.spec_id);
    const text = entry.kind === 'note' ? entry.text : entry.kind === 'checks' ? `${entry.count ?? 0} checks passed` : entry.kind === 'done' ? member ? `✓ ${memberTitle(member)}` : null : entry.text ? `Blocked on ${entry.text}` : 'Blocked';
    if (!text) return null;
    return <Text key={`${entry.at}-${entry.spec_id}-${index}`} style={{ ...body, paddingVertical: 4 }}>{text}{readableAge(entry.at) ? ` · ${readableAge(entry.at)}` : ''}</Text>;
  })}</>;
}
function GoalRing({ stop, size, yellow, muted, spark }: { stop: RoadStop; size: number; yellow?: boolean; muted?: boolean; spark?: Motion | null }) {
  const { goal } = stop;
  return <NumRing testID={`goal-ring-${goalKey(goal.goal_id)}`} n={stop.number} tone={ringTone(stop.goalClass, stop.position)} size={size}
    fraction={goal.total ? goal.done / goal.total : 0} hatch={stop.goalClass === 'blocked'} yellow={yellow} muted={muted}>
    {spark?.moving ? <Spark size={size} phase={spark.phase} testID={`motion-spark-${goalKey(goal.goal_id)}`} /> : null}
  </NumRing>;
}

/* ---------- home ---------- */
function LaneCard({ model, cls, spark, expanded, first, onToggle, onOpen, questionCard }: {
  model: LaneCardViewModel; first: boolean; cls: LaneClass; spark: Motion; expanded: boolean; onToggle(): void; onOpen: Open; questionCard: React.ReactNode;
}) {
  const { lane } = model, road = readableRoad(lane, { legacy: true }), lead = readableLeadGoals(lane, road), dots = readableDots(lane, road);
  const quiet = quietClass(cls), age = readableAge(cls === 'paused' ? lane.state_at : lane.progress_at);
  const next = quiet ? road.find(stop => stop.position === 'next') : undefined;
  const more = (lane.goal_counts?.[0] ?? 0) - lead.length, question = laneNeedsYou(lane), mark = useRef<View>(null);
  const line = (stop: RoadStop) => { const blocked = stop.goalClass === 'blocked'; return <View key={goalKey(stop.goal.goal_id)} testID={`lane-goal-line-${lane.lane_id}-${goalKey(stop.goal.goal_id)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 7 }}>
    <GoalRing stop={stop} size={18} spark={stop.goalClass === 'working' ? spark : null} />
    <Text numberOfLines={1} style={{ ...body, fontSize: 15, flex: 1, color: stop.goalClass === 'working' ? p.text : p.dim }}>{stop.goal.title}</Text>
    <Text style={{ ...mono, color: blocked ? p.yellow : p.muted }}>{blocked ? 'blocked · ' : ''}{stop.goal.done}/{stop.goal.total}</Text>
  </View>; };
  const open = (e: GestureResponderEvent) => onOpen({ kind: 'lane', laneId: lane.lane_id }, e, { ref: mark, node: <LaneMark lane={lane} quiet={quiet} size={34} /> });
  return <View style={{ borderTopWidth: first ? 0 : 1, borderColor: p.line }}>
    {/* iOS folds the question button into this row for VoiceOver, so the row also carries it as an action. */}
    <Pressable testID={`lane-row-${lane.lane_id}`} accessibilityRole="button" onPress={open} style={{ flexDirection: 'row', gap: 12, paddingVertical: 15 }}
      accessibilityActions={question ? [{ name: 'question', label: expanded ? 'Hide question' : 'Show question' }] : undefined}
      onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'question') onToggle(); }}>
      <View ref={mark} collapsable={false}><LaneMark lane={lane} quiet={quiet} size={36} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={2} style={{ ...titleStyle, fontSize: 18, lineHeight: 21, flexShrink: 1 }}>{lane.title}</Text>
          {question ? <Pressable testID={`lane-question-button-${lane.lane_id}`} accessibilityRole="button" accessibilityLabel={expanded ? 'Hide question' : 'Show question'}
            accessibilityState={{ expanded }} hitSlop={14} onPress={onToggle}
            style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: p.yellow, alignItems: 'center', justifyContent: 'center' }}>
            <Text allowFontScaling={false} style={{ fontFamily: Fonts.rajdhani.bold, fontSize: 13, lineHeight: 18, color: '#1a1600' }}>?</Text></Pressable> : null}
          <View style={{ flex: 1 }} />
          {age ? <Text style={{ ...mono, letterSpacing: 0.6, color: cls === 'working' ? p.green : p.muted }}>{age}</Text> : null}
        </View>
        <GoalDots dots={dots.dots} more={dots.more} testID={`lane-dots-${lane.lane_id}`} />
        {quiet ? next ? line(next) : null : lead.map(line)}
        {!quiet && more > 0 ? <Text style={{ ...mono, marginTop: 8 }}>+{more} more in progress</Text> : null}
      </View>
    </Pressable>
    {expanded ? <View testID={`lane-question-expanded-${lane.lane_id}`} style={{ marginTop: -6, paddingBottom: 12 }}>{questionCard}</View> : null}
  </View>;
}
function Home({ lanes, classes, inventory, assistantName, connected, active, expanded, setExpanded, questionCard, onOpen, onClose }: {
  lanes: LaneCardViewModel[]; classes: Map<string, LaneClass>; inventory?: WorkLanesInventory | null; assistantName: string; connected: boolean; active: boolean;
  expanded: string | null; setExpanded(id: string | null): void; questionCard(model: LaneCardViewModel): React.ReactNode; onOpen: Open; onClose(): void;
}) {
  const { width } = useWindowDimensions();
  const by = (cls: LaneClass) => lanes.filter(m => classes.get(m.lane.lane_id) === cls);
  const counts = readableHomeCounts(lanes.map(m => classes.get(m.lane.lane_id)!));
  const working = by('working'), moving = by('moving'), parked = by('parked');
  const anyWorking = lanes.some(m => classes.get(m.lane.lane_id) === 'working');
  const mapMotion = useWorkingMotion(active, anyWorking, 1100), spark = useWorkingMotion(active, anyWorking, 2600);
  const busy = lanes.filter(m => ['working', 'moving'].includes(classes.get(m.lane.lane_id)!));
  const quiet = [...busy.slice(8), ...lanes.filter(m => ['idle', 'paused'].includes(classes.get(m.lane.lane_id)!))];
  const node = (model: LaneCardViewModel): ConstellationNode => {
    const cls = classes.get(model.lane.lane_id)!, inner = cls === 'working' || cls === 'moving';
    const age = readableAge(cls === 'paused' ? model.lane.state_at : model.lane.progress_at);
    return { id: model.lane.lane_id, title: model.lane.title, lane: model.lane, kind: cls === 'working' ? 'working' : inner ? 'moving' : 'quiet',
      state: inner ? (age ? `${age} ago` : '') : [cls === 'paused' ? 'paused' : 'idle', age].filter(Boolean).join(' · '),
      question: model.waitingOnYou > 0 || laneNeedsYou(model.lane),
      onPress: (e, ring) => onOpen({ kind: 'lane', laneId: model.lane.lane_id }, e, { ref: ring, node: <LaneMark lane={model.lane} quiet={quietClass(cls)} size={34} /> }) };
  };
  const cards = (group: LaneCardViewModel[]) => group.map((model, i) => <LaneCard key={model.lane.lane_id} first={i === 0} model={model} cls={classes.get(model.lane.lane_id)!} spark={spark}
    expanded={expanded === model.lane.lane_id} onOpen={onOpen} questionCard={expanded === model.lane.lane_id ? questionCard(model) : null}
    onToggle={() => setExpanded(expanded === model.lane.lane_id ? null : model.lane.lane_id)} />);
  return <>
    <Header hero={<Badge kind="home" tone={p.green} />} title={assistantName} sub={`${counts.working} working · ${counts.moving} in progress · ${counts.quiet} quiet`} onClose={onClose} />
    {inventory?.work_index?.available === false ? <Text testID="lanes-index-banner" style={{ ...mono, color: p.muted, paddingHorizontal: 16, paddingTop: 6 }}>DATA AS OF {inventory.work_index.snapshot_at || 'unknown'}</Text> : null}
    <ScrollView testID="readable-lanes-scroll" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 56 }}>
      <View testID="readable-home">
        <View style={{ marginHorizontal: -16, alignItems: 'center', borderBottomWidth: 1, borderColor: p.line }}>
          <LanesConstellation width={Math.min(width, 430)} inner={busy.slice(0, 8).map(node)} outer={quiet.slice(0, 4).map(node)} more={Math.max(0, quiet.length - 4)} assistantName={assistantName} motion={mapMotion} />
        </View>
        {connected && lanes.length === 0 ? <Text style={{ ...body, marginTop: 16 }}>No open lanes</Text> : null}
        {([['Working now', working, p.green], ['In progress', moving, p.muted], ['Idle', by('idle'), p.muted], ['Paused', by('paused'), p.muted]] as const)
          .map(([name, group, tone]) => group.length ? <View key={name}><Section name={name} count={group.length} tone={tone} />{cards(group)}</View> : null)}
        {parked.length ? <Pressable testID="parked-button" accessibilityRole="button" onPress={e => onOpen({ kind: 'parked' }, e)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 22, paddingVertical: 11, paddingHorizontal: 12, minHeight: 44, borderWidth: 1, borderStyle: 'dashed', borderColor: p.line, borderRadius: 9 }}>
          <Icon kind="parked" size={15} color={p.muted} /><Text style={{ ...body, fontSize: 15, color: p.muted, flex: 1 }}>Parked · {parked.length}</Text><Icon kind="chevron" size={13} color={p.muted} />
        </Pressable> : null}
      </View>
    </ScrollView>
  </>;
}

/* ---------- lane: the road ---------- */
type LaneData = { lane: WorkLane; road: RoadStop[]; members: WorkLaneMember[]; complete: boolean; finished: WorkLaneMember[] };
function Stop({ stop, index, last, expanded, members, complete, needsYou, muted, motion, rise, onOpen, laneId }: {
  stop: RoadStop; index: number; last: boolean; expanded: boolean; members: WorkLaneMember[]; complete: boolean; needsYou: boolean; muted: boolean;
  motion: { rail: Motion; pulse: Motion }; rise: boolean; onOpen: Open; laneId: string;
}) {
  const { goal, goalClass } = stop, key = goalKey(goal.goal_id), word = readableStopWord(stop, { expanded, needsYou });
  const ordered = readableItemOrder(members), lead = ordered.filter(x => ['needs', 'working', 'in_progress', 'blocked'].includes(x.kind));
  const tail = [lead.length > 3 && `+${lead.length - 3} more`, ordered.filter(x => x.kind === 'next').length && `${ordered.filter(x => x.kind === 'next').length} next up`,
    ordered.filter(x => x.kind === 'later').length && `${ordered.filter(x => x.kind === 'later').length} later`].filter(Boolean).join(' · ');
  const [appear] = useState(() => new Animated.Value(rise ? 0 : 1));
  useEffect(() => { if (rise) Animated.timing(appear, { toValue: 1, duration: 400, delay: Math.min(index, 9) * 70 + 160, useNativeDriver: true }).start(); }, []);
  const ring = useRef<View>(null), size = expanded ? 36 : 26;
  const rail = goalClass === 'done' ? 'solid' : goalClass === 'working' ? 'live' : goalClass === 'moving' ? 'open' : 'faint';
  return <Animated.View testID={`road-stop-${key}`} style={{ paddingBottom: expanded ? 20 : 14, opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
    {!last || goalClass === 'working' ? <View testID={`road-rail-${key}-${rail}`} pointerEvents="none" style={{ position: 'absolute', left: 17, top: 34, bottom: -4, width: 2, overflow: 'hidden',
      ...(rail === 'solid' ? { backgroundColor: p.green, opacity: 0.55 } : rail === 'open' ? { backgroundColor: p.green, opacity: 0.3 } : {}) }}>
      {rail === 'live' ? <Animated.View testID={motion.rail.moving ? `motion-rail-${key}` : undefined} style={{ transform: [{ translateY: motion.rail.moving ? motion.rail.phase.interpolate({ inputRange: [0, 1], outputRange: [-11, 0] }) : 0 }] }}>
        {Array.from({ length: 60 }, (_, i) => <View key={i} style={{ width: 2, height: 5, marginBottom: 6, backgroundColor: p.green }} />)}</Animated.View>
        : rail === 'faint' ? Array.from({ length: 60 }, (_, i) => <View key={i} style={{ width: 2, height: 2, marginBottom: 5, backgroundColor: p.faint, opacity: 0.7 }} />) : null}
    </View> : null}
    <Pressable testID={`goal-head-${key}`} accessibilityRole="button" onPress={e => onOpen({ kind: 'goal', laneId, goalId: goal.goal_id }, e,
      { ref: ring, node: <GoalRing stop={stop} size={34} yellow={needsYou} muted={muted} /> })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
      <View ref={ring} collapsable={false} style={{ width: 36, alignItems: 'center' }}><GoalRing stop={stop} size={size} yellow={needsYou} muted={muted} /></View>
      <Text numberOfLines={2} style={{ flex: 1, fontFamily: expanded || goalClass === 'working' || goalClass === 'moving' ? Fonts.rajdhani.bold : Fonts.rajdhani.medium, fontSize: 17, lineHeight: 20,
        fontStyle: goal.total === 0 ? 'italic' : 'normal', color: muted ? p.muted : goalClass === 'done' || stop.position === 'later' ? p.muted : stop.position === 'next' ? p.dim : p.text }}>{goal.title}</Text>
      {word ? <Text testID={`stop-word-${key}`} style={{ ...mono, color: muted ? p.muted : word.tone === 'yellow' ? p.yellow : word.tone === 'green' ? p.green : p.muted }}>{word.text}</Text> : null}
    </Pressable>
    {expanded ? <View style={{ paddingLeft: 48 }}>
      {goal.total > 0 ? <RoadBar done={goal.done} total={goal.total} hatch={goalClass === 'blocked'} label={readableHours(goal.left_h) ? ` · ${readableHours(goal.left_h)}` : ''} /> : null}
      {lead.length ? <View style={{ marginTop: 8, borderTopWidth: 1, borderColor: p.line }}>{lead.slice(0, 3).map(({ member }, i) => <ItemRow key={member.spec_id} first={i === 0} member={member} pulse={motion.pulse}
        onPress={e => onOpen({ kind: 'item', laneId, goalId: goal.goal_id, memberId: member.spec_id }, e)} />)}</View> : null}
      {complete && tail ? <Text testID={`stop-tail-${key}`} style={{ ...mono, paddingTop: 8, paddingLeft: 19, borderTopWidth: 1, borderColor: p.line }}>{tail}</Text> : null}
    </View> : null}
  </Animated.View>;
}
function LaneScreen({ model, data, show, connected, active, rise, onOpen, onBack, onClose, onHero, heroHidden }: {
  model: LaneCardViewModel; data: LaneData | null; show: ReturnType<typeof useWorkLaneShow>; connected: boolean; active: boolean; rise: boolean; onOpen: Open; onBack(): void; onClose(): void; onHero(b: Box): void; heroHidden: boolean;
}) {
  const lane = data?.lane ?? model.lane, cls = readableLaneClass(lane, laneWorking(model.lane)), muted = cls === 'parked';
  const members = data?.members ?? [], working = members.some(m => readableItemKind(m) === 'working') || (data?.road ?? []).some(s => s.goalClass === 'working');
  const rail = useWorkingMotion(active, working, 1000), pulse = useWorkingMotion(active, working, 1800);
  const lead = new Set(data ? readableLeadGoals(lane, data.road).map(s => goalKey(s.goal.goal_id)) : []);
  const sub = lane.parked && readableDay(lane.parked.at) ? `parked ${readableDay(lane.parked.at)}` : lane.state === 'paused'
    ? ['paused', readableAge(lane.state_at)].filter(Boolean).join(' · ') : ago(lane.progress_at);
  const goalMembers = (goalId: string | null) => members.filter(m => (m.goal_id ?? null) === goalId);
  return <>
    <Header hero={<LaneMark lane={lane} quiet={quietClass(cls)} size={34} />} title={lane.title} sub={sub} subTone={cls === 'working' ? p.green : undefined} onBack={onBack} onClose={onClose} onHero={onHero} heroHidden={heroHidden} />
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 56 }}>
      {!connected && !data ? <LeafText id="lanes-connection-wait" text="Waiting for connection" style={body} />
        : show.error ? <Pressable testID="lanes-detail-retry" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={show.retry}><Text style={{ ...body, color: p.yellow }}>{show.error} · Retry</Text></Pressable>
          : !data ? <LeafLoading id="lanes-map-members-loading" text="Loading lane" /> : <View testID="readable-lane">
            <QuestionDeckCard key={lane.lane_id} embedded laneId={lane.lane_id} laneStreams={[...(model.lane.lead ? [model.lane.lead.stream_id] : []), ...members.flatMap(m => (m.seats ?? []).map(s => s.stream_id))]}
              laneQuestionIds={members.flatMap(m => m.open_questions?.first_question_id ? [m.open_questions.first_question_id] : [])} />
            {lane.parked?.reason ? <Text testID="lane-parked-reason" style={{ ...body, fontSize: 16, lineHeight: 21, marginTop: 14 }}>{lane.parked.reason}</Text> : null}
            {!data.complete ? <LeafLoading id="lanes-members-paging" text="Loading more specs" /> : null}
            <View testID="lane-road" style={{ marginTop: 18 }}>{data.road.map((stop, i) => <Stop key={goalKey(stop.goal.goal_id)} stop={stop} index={i} last={i === data.road.length - 1}
              expanded={lead.has(goalKey(stop.goal.goal_id))} members={goalMembers(stop.goal.goal_id)} complete={data.complete} needsYou={goalMembers(stop.goal.goal_id).some(hasQuestion)}
              muted={muted} motion={{ rail, pulse }} rise={rise} onOpen={onOpen} laneId={lane.lane_id} />)}</View>
            {data.finished.length ? <><Section name="Finished earlier" count={data.finished.length} />
              <ItemList id="finished-earlier" members={data.finished} cap={6} small closed="finished" pulse={pulse} onItem={(m, e) => onOpen({ kind: 'item', laneId: lane.lane_id, goalId: null, memberId: m.spec_id }, e)} /></> : null}
          </View>}
    </ScrollView>
  </>;
}

/* ---------- goal: every item it holds ---------- */
const GOAL_SECTIONS: Array<[string, ItemKind, string | undefined]> = [['Working now', 'working', p.green], ['Needs you', 'needs', p.yellow], ['In progress', 'in_progress', undefined], ['Blocked', 'blocked', p.yellow], ['Next up', 'next', undefined]];
function GoalScreen({ lane, stop, members, complete, show, goalShow, active, onOpen, onBack, onClose, onHero, heroHidden }: {
  lane: WorkLane; stop: RoadStop; members: WorkLaneMember[]; complete: boolean; show: ReturnType<typeof useWorkLaneShow>; goalShow: ReturnType<typeof useWorkLaneShow>; active: boolean;
  onOpen: Open; onBack(): void; onClose(): void; onHero(b: Box): void; heroHidden: boolean;
}) {
  const detail = stop.goal.goal_id !== null ? goalShow.data?.projection?.goals?.find(g => g.goal_id === stop.goal.goal_id) : undefined;
  const full: RoadStop = detail ? { ...stop, goal: { ...stop.goal, ...detail } } : stop, goal = full.goal;
  const ordered = readableItemOrder(members), of = (kind: ItemKind) => ordered.filter(x => x.kind === kind).map(x => x.member);
  const needsYou = members.some(hasQuestion), working = stop.goalClass === 'working' || of('working').length > 0;
  const spark = useWorkingMotion(active, stop.goalClass === 'working', 2600), pulse = useWorkingMotion(active, working, 1800);
  const word = readableStopWord(full, { expanded: true, needsYou });
  const unestimated = members.filter(m => m.status !== 'completed' && !m.estimate).length;
  const open = (m: WorkLaneMember, e: GestureResponderEvent) => onOpen({ kind: 'item', laneId: lane.lane_id, goalId: goal.goal_id, memberId: m.spec_id }, e);
  return <>
    <Header hero={<GoalRing stop={full} size={34} yellow={needsYou} spark={spark} />} title={goal.title} crumb={lane.title} sub={word?.text}
      subTone={word?.tone === 'yellow' ? p.yellow : word?.tone === 'green' ? p.green : undefined} onBack={onBack} onClose={onClose} onHero={onHero} heroHidden={heroHidden} />
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 56 }}>
      <View testID="readable-goal">
        {!complete ? <LeafLoading id="lanes-members-paging" text="Loading more specs" /> : null}
        {goalShow.error ? <Pressable testID="goal-detail-retry" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={goalShow.retry}><Text style={body}>{goalShow.error} · Retry</Text></Pressable> : null}
        {show.error ? <Pressable testID="lanes-detail-retry" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={show.retry}><Text style={body}>{show.error} · Retry</Text></Pressable> : null}
        {goal.total > 0 ? <View style={{ height: 8 }} /> : null}
        {goal.total > 0 ? <RoadBar testID="goal-bar" done={goal.done} total={goal.total} hatch={stop.goalClass === 'blocked'} label={` done${readableHours(goal.left_h) ? ` · ${readableHours(goal.left_h)}` : ''}`} />
          : <Text style={{ ...body, fontSize: 16, color: p.dim, marginTop: 14 }}>No items yet. The first one is not written.</Text>}
        {complete && unestimated ? <Text style={{ ...mono, textTransform: 'none', letterSpacing: 0.2, color: p.faint, marginTop: 6 }}>{unestimated} open {unestimated === 1 ? 'item has' : 'items have'} no estimate</Text> : null}
        {GOAL_SECTIONS.map(([name, kind, tone]) => of(kind).length ? <View key={name}><Section name={name} count={of(kind).length} tone={tone} />
          <ItemList id={`goal-${kind}`} members={of(kind)} cap={6} pulse={pulse} onItem={open} /></View> : null)}
        {of('later').length ? <><Section name="Later" count={of('later').length} /><ItemList id="goal-later" members={of('later')} cap={6} small pulse={pulse} onItem={open} /></> : null}
        {of('done').length ? <><Section name="Done" count={of('done').length} /><ItemList id="goal-done" members={of('done')} cap={8} small closed="finished" pulse={pulse} onItem={open} /></> : null}
      </View>
    </ScrollView>
  </>;
}

/* ---------- item ---------- */
function ItemScreen({ member, members, crumb, onQuestion, onBack, onClose, onHero, heroHidden }: {
  member: WorkLaneMember; members: WorkLaneMember[]; crumb: string; onQuestion(): void; onBack(): void; onClose(): void; onHero(b: Box): void; heroHidden: boolean;
}) {
  const [passedOpen, setPassedOpen] = useState(false);
  const kind = readableItemKind(member), yellow = yellowKind(kind), trouble = readableTrouble(member), seats = readableSeatCount(member);
  const meta = [member.worked?.active_h != null ? `${member.worked.active_h.toFixed(1)}h worked` : null, seats].filter(Boolean).join(' · ');
  const open = (member.criteria ?? []).filter(c => c.disposition === 'open'), passed = (member.criteria ?? []).filter(c => c.disposition === 'done');
  const sub = kind === 'done' ? ['done', readableDay(member.progress_at)].filter(Boolean).join(' ') : ago(member.progress_at);
  const stageTone = member.status === 'blocked' ? p.yellow : p.green;
  return <>
    <Header hero={<Badge kind="spec" tone={yellow ? p.yellow : kind === 'done' || kind === 'later' ? p.muted : p.green} />} title={memberTitle(member)} crumb={crumb} sub={sub}
      subTone={kind === 'working' ? p.green : undefined} onBack={onBack} onClose={onClose} onHero={onHero} heroHidden={heroHidden} />
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 56 }}>
      <View testID="readable-spec">
        {member.summary_line ? <Text style={{ ...body, fontSize: 16, lineHeight: 21, color: p.text, marginTop: 14 }}>{member.summary_line}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 14 }}>{stageLabels[member.status ?? ''] ? <Text style={{ ...label, color: stageTone, borderWidth: 1, borderColor: stageTone, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>{stageLabels[member.status ?? '']}</Text> : null}{meta ? <Text style={mono}>{meta}</Text> : null}</View>
        {member.ac_total != null && member.ac_checked != null ? <RoadBar testID="spec-bar" done={member.ac_checked} total={member.ac_total} hatch={member.status === 'blocked'} label={` checks${readableHours(member.estimate?.median) ? ` · ${readableHours(member.estimate?.median)}` : ''}`} /> : null}
        {trouble.length ? <Text style={{ ...body, color: p.yellow, marginTop: 8 }}>{trouble.join(' · ')}</Text> : null}
        {hasQuestion(member) ? <Pressable testID="spec-open-question" accessibilityRole="button" onPress={onQuestion} style={{ paddingVertical: 14 }}><Text style={{ ...titleStyle, color: p.yellow }}>●  {member.open_questions?.count} open {member.open_questions?.count === 1 ? 'question' : 'questions'}  ›</Text></Pressable> : null}
        {([['Now', member.status_line], ['Blocked on', member.status === 'blocked' ? member.blocked_line : null], ['Unblocks', member.unblocks?.map(x => x.title).join(', ')], ['Next', member.next_line]] as const).map(([name, value]) => value ? <View key={name} style={{ marginTop: 14, flexDirection: 'row', gap: 12 }}><Text style={{ ...label, width: 80, color: name === 'Blocked on' ? p.yellow : p.green }}>{name}</Text><Text style={{ ...body, flex: 1, color: p.text }}>{value}</Text></View> : null)}
        {member.ac_total ? <><Section name="Checks left" count={open.length} tone={p.green} />{open.map((c, i) => <Text key={i} style={{ ...body, color: p.text, paddingVertical: 6 }}>○  {c.title}</Text>)}
          {passed.length ? passedOpen ? passed.map((c, i) => <Text key={i} style={{ ...body, color: p.muted, paddingVertical: 6 }}>✓  {c.title}</Text>)
            : <Fold id="spec-passed-open" text={`Show ${passed.length} passed`} onPress={() => setPassedOpen(true)} /> : null}</> : null}
        <Recent entries={member.recent} members={members} />
      </View>
    </ScrollView>
  </>;
}

/* ---------- parked ---------- */
function ParkedScreen({ lanes, onOpen, onBack, onClose, onHero, heroHidden }: { lanes: LaneCardViewModel[]; onOpen: Open; onBack(): void; onClose(): void; onHero(b: Box): void; heroHidden: boolean }) {
  return <>
    <Header hero={<Badge kind="parked" tone={p.muted} />} title="Parked" sub={`${lanes.length} ${lanes.length === 1 ? 'lane' : 'lanes'} on hold`} onBack={onBack} onClose={onClose} onHero={onHero} heroHidden={heroHidden} />
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 56 }}>
      <View testID="readable-parked">{lanes.map(({ lane }, i) => <ParkedRow key={lane.lane_id} lane={lane} first={i === 0} onOpen={onOpen} />)}</View>
    </ScrollView>
  </>;
}
function ParkedRow({ lane, first, onOpen }: { lane: WorkLane; first: boolean; onOpen: Open }) {
  const mark = useRef<View>(null);
  const facts = [lane.parked?.at && readableDay(lane.parked.at) ? `parked ${readableDay(lane.parked.at)}` : null, lane.goals_total != null ? `${lane.goals_total} ${lane.goals_total === 1 ? 'goal' : 'goals'}` : null,
    lane.items_open != null ? `${lane.items_open} ${lane.items_open === 1 ? 'item' : 'items'}` : null].filter(Boolean).join(' · ');
  return <Pressable testID={`parked-lane-${lane.lane_id}`} accessibilityRole="button" onPress={e => onOpen({ kind: 'lane', laneId: lane.lane_id }, e, { ref: mark, node: <LaneMark lane={lane} quiet size={34} /> })}
    style={{ flexDirection: 'row', gap: 12, paddingVertical: 15, borderTopWidth: first ? 0 : 1, borderColor: p.line }}>
    <View ref={mark} collapsable={false}><LaneMark lane={lane} quiet size={36} /></View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={{ ...titleStyle, fontSize: 18 }}>{lane.title}</Text>
      {lane.parked?.reason ? <Text style={{ ...body, marginTop: 4 }}>{lane.parked.reason}</Text> : null}
      {facts ? <Text style={{ ...mono, marginTop: 8 }}>{facts}</Text> : null}
    </View>
  </Pressable>;
}

export default function ReadableLanes({ lanes, inventory, assistantName, connected, top, bottom, onClose, readShow, active = true }: {
  lanes: LaneCardViewModel[]; inventory?: WorkLanesInventory | null; assistantName: string; connected: boolean; top: number; bottom: number; onClose(): void; readShow?: ReadWorkLaneShow; active?: boolean;
}) {
  const reduceMotion = useReduceMotion();
  const stack = useScreenStack<Entry>({ kind: 'home' }, reduceMotion);
  const entries = stack.layers.map(layer => layer.value), current = stack.top.value;
  const laneId = entries.reduce<string | null>((id, e) => 'laneId' in e ? e.laneId : id, null);
  const goalId = entries.reduce<string | null | undefined>((id, e) => e.kind === 'goal' || e.kind === 'item' ? e.goalId : id, undefined);
  const selected = lanes.find(m => m.lane.lane_id === laneId);
  const show = useWorkLaneShow(laneId ?? '', connected, !!laneId, readShow, selected?.lane.detail_revision);
  const goalShow = useWorkLaneShow(laneId ?? '', connected, !!laneId && typeof goalId === 'string', readShow, selected?.lane.detail_revision, typeof goalId === 'string' ? goalId : undefined);
  const [expanded, setExpandedState] = useState<string | null>(null);
  const expandedModel = lanes.find(m => m.lane.lane_id === expanded);
  const expandShow = useWorkLaneShow(expanded ?? '', connected, !!expandedModel, readShow, expandedModel?.lane.detail_revision);
  const laneData = show.data?.lane_id === laneId ? show.data : null;
  const observed = useLaneMembers(selected?.members ?? [], laneData, show.requestEpoch);
  const data: LaneData | null = useMemo(() => {
    if (!selected || !laneData) return null;
    const lane = laneData.projection ?? selected.lane, members = lane.no_spec_reason || selected.lane.no_spec_reason ? [] : observed;
    const defaultGoal = derivedDefaultGoal(lane, members, show.complete), road = readableRoad(lane, { defaultGoal });
    const finished = defaultGoal && defaultGoal.total > 0 && !road.some(s => s.isDefault) ? members.filter(m => !m.goal_id && m.status === 'completed') : [];
    return { lane, road, members: members.filter(m => m.status !== 'deprecated' && m.terminal !== 'deprecated'), complete: show.complete, finished };
  }, [selected, laneData, observed, show.complete]);
  const classes = useMemo(() => new Map(lanes.map(m => [m.lane.lane_id, readableLaneClass(m.lane, laneWorking(m.lane))])), [lanes]);
  const setExpanded = (id: string | null) => {
    if (reduceMotion === false) LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    setExpandedState(id);
  };
  useEffect(() => { if (!active) setExpandedState(null); }, [active]);
  useEffect(() => { if (expanded && (!expandedModel || !laneNeedsYou(expandedModel.lane) || classes.get(expanded) === 'parked')) setExpandedState(null); }, [expanded, expandedModel, classes]);
  useEffect(() => { if (laneId && !selected) stack.reset({ kind: 'home' }); }, [laneId, selected]);
  useEffect(() => {
    if (current.kind === 'item' && show.complete && !(data?.members ?? []).some(m => m.spec_id === current.memberId)) stack.back();
  }, [current, show.complete, data]);
  const member = current.kind === 'item' ? data?.members.find(m => m.spec_id === current.memberId) : undefined;
  const stopFor = (id: string | null) => data?.road.find(s => s.goal.goal_id === id);
  const headerTitle = member ? memberTitle(member) : current.kind === 'goal' ? stopFor(current.goalId)?.goal.title ?? '' : current.kind === 'parked' ? 'Parked' : selected && current.kind === 'lane' ? selected.lane.title : assistantName;
  useVoiceSurface({ page_id: current.kind === 'item' ? 'spec' : current.kind === 'home' ? 'lanes' : current.kind, title: headerTitle,
    ...(member ? { entity_id: member.spec_id } : selected && current.kind !== 'home' ? { entity_id: selected.lane.lane_id } : {}) }, active, { priority: 1.5, bottom: bottom + 10, top: top + 72 });
  const open: Open = (entry, event, hero) => stack.open(entry, event, hero);
  const questionCard = (model: LaneCardViewModel) => {
    const members = expandShow.data?.lane_id === model.lane.lane_id ? expandShow.data.members : model.members;
    return <QuestionDeckCard key={model.lane.lane_id} embedded laneId={model.lane.lane_id} laneStreams={[...(model.lane.lead ? [model.lane.lead.stream_id] : []), ...members.flatMap(m => (m.seats ?? []).map(s => s.stream_id))]}
      laneQuestionIds={members.flatMap(m => m.open_questions?.first_question_id ? [m.open_questions.first_question_id] : [])} />;
  };
  const render = (layer: { key: number; value: Entry; animateIn: boolean }, state: { top: boolean; heroHidden: boolean }) => {
    const entry = layer.value, live = active && state.top, chrome = { onBack: stack.back, onClose, onHero: (b: Box) => stack.heroAt(layer.key, { ...b, x: b.x + stack.offset.current.x, y: b.y + stack.offset.current.y }), heroHidden: state.heroHidden };
    if (entry.kind === 'home') return <Home lanes={lanes} classes={classes} inventory={inventory} assistantName={assistantName} connected={connected} active={live}
      expanded={expanded} setExpanded={setExpanded} questionCard={questionCard} onOpen={open} onClose={onClose} />;
    if (entry.kind === 'parked') return <ParkedScreen lanes={lanes.filter(m => classes.get(m.lane.lane_id) === 'parked')} onOpen={open} {...chrome} />;
    if (!selected) return null;
    if (entry.kind === 'lane') return <LaneScreen model={selected} data={data} show={show} connected={connected} active={live} rise={layer.animateIn} onOpen={open} {...chrome} />;
    const stop = stopFor(entry.goalId);
    if (entry.kind === 'goal') return stop && data ? <GoalScreen lane={data.lane} stop={stop} members={data.members.filter(m => (m.goal_id ?? null) === entry.goalId)} complete={data.complete}
      show={show} goalShow={goalShow} active={live} onOpen={open} {...chrome} /> : <LaneScreen model={selected} data={data} show={show} connected={connected} active={false} rise={false} onOpen={open} {...chrome} />;
    const item = data?.members.find(m => m.spec_id === entry.memberId);
    if (!item) return null;
    return <ItemScreen member={item} members={data!.members} crumb={stop?.goal.title ?? selected.lane.title} {...chrome}
      onQuestion={() => { laneQuestionCardStore(selected.lane.lane_id).show(); stack.backTo(stack.layers.findIndex(l => l.value.kind === 'lane') + 1); }} />;
  };
  return <View testID="lanes-overlay" style={{ flex: 1, backgroundColor: p.ink }}><Starfield />
    <View style={{ flex: 1, marginTop: top, marginBottom: bottom }}><StackView stack={stack} render={render} /></View>
  </View>;
}
