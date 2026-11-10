import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { readableAge, readableGoalClass, readableHours, readableLaneClass, readableLeadGoals, readableSeatCount, readableSentence, readableTrouble, type WorkLaneDefaultGoal, type WorkLaneMember, type WorkLaneRecent, type WorkLanesInventory } from 'pentacle-chat-core';
import { Fonts } from '@/constants/Colors';
import HeaderVoiceMic from '../voice/HeaderVoiceMic';
import Starfield from '../Starfield';
import QuestionDeckCard from '../questions/QuestionDeckCard';
import { laneQuestionCardStore } from '../questions/questionCardStore';
import { laneNeedsYou, laneWorking, type LaneCardViewModel } from '../../services/workLanes';
import { useVoiceSurface } from '../../services/voicePresentation';
import { body, Icon, label, LaneMark, LeafLoading, LeafText, mono, p } from './LaneAtoms';
import LanesConstellation, { type ConstellationNode } from './LanesConstellation';
import { useWorkingMotion } from './useWorkingMotion';
import { useWorkLaneShow, type ReadWorkLaneShow } from './useWorkLaneShow';
import { useLaneMembers } from './useLaneMembers';

type Goal = WorkLaneDefaultGoal & { goal_id: string | null; title: string; rank: number };
const titleStyle = { ...body, color: p.text, fontFamily: Fonts.rajdhani.bold, fontSize: 16 };
const stageLabels: Record<string, string> = { analysis: 'Planning', in_progress: 'Building', needs_qa: 'In review', blocked: 'Blocked', backlog: 'Queued', ready_for_dev: 'Queued', completed: 'Done' };
const moving = (member: WorkLaneMember) => ['analysis', 'in_progress', 'needs_qa'].includes(member.status ?? '');
const laneTone = (model: LaneCardViewModel): LaneCardViewModel['stateTone'] => {
  const cls = readableLaneClass(model.lane);
  return cls === 'stalled' ? 'amber' : cls === 'idle' || cls === 'paused' ? 'muted' : 'green';
};
const memberTitle = (member: WorkLaneMember) => member.title || member.spec_id;
const hasQuestion = (member: WorkLaneMember) => (member.open_questions?.count ?? 0) > 0;
const isWorking = (member: WorkLaneMember) => member.seats?.some(s => s.activity === 'working') === true;
const memberRank = (member: WorkLaneMember) => hasQuestion(member) ? 0 : isWorking(member) ? 1 : member.status === 'needs_qa' ? 2 : moving(member) ? 3 : 4;
const ago = (at: string | null | undefined) => { const age = readableAge(at); return age ? `${age} ago` : null; };

function Bar({ done, total, movingCount = 0, time, checks = false, amber = false, allowEmpty = false }: { done?: number | null; total?: number | null; movingCount?: number; time?: string | null; checks?: boolean; amber?: boolean; allowEmpty?: boolean }) {
  if (total == null || done == null || (total === 0 && !allowEmpty)) return null;
  const completed = total ? Math.max(0, Math.min(1, done / total)) : 0;
  const active = total ? Math.max(0, Math.min(1 - completed, movingCount / total)) : 0;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 7 }}>
    <View style={{ flex: 1, height: 4, backgroundColor: p.line, flexDirection: 'row' }}>
      <View style={{ width: `${completed * 100}%`, backgroundColor: amber ? p.amber : p.green }} />
      <View style={{ width: `${active * 100}%`, backgroundColor: amber ? `${p.amber}77` : `${p.green}77` }} />
    </View><Text style={mono}>{done}/{total}{checks ? ' checks' : ''}{time ? ` · ${time}` : ''}</Text>
  </View>;
}
function Section({ name, count, children }: { name: string; count?: number; children: React.ReactNode }) {
  return <View style={{ gap: 8, marginTop: 18 }}><Text testID={`readable-section-${name.toLowerCase().replace(/\s+/g, '-')}`} style={{ ...label, color: ['blocked', 'stalled'].includes(name.toLowerCase()) ? p.amber : ['queued', 'goals', 'done', 'next up', 'recent', 'paused', 'idle'].includes(name.toLowerCase()) ? p.muted : p.green }}>{name}{count != null ? ` · ${count}` : ''}</Text>{children}</View>;
}
function SpecRow({ member, onPress, bar = false }: { member: WorkLaneMember; onPress(): void; bar?: boolean }) {
  const sentence = readableSentence(member), age = readableAge(member.progress_at);
  const amber = member.status === 'blocked' || hasQuestion(member);
  return <Pressable testID={`spec-row-${member.spec_id}`} accessibilityRole="button" onPress={onPress} style={{ paddingVertical: 11, borderBottomWidth: 1, borderColor: p.line }}>
    <View style={{ flexDirection: 'row', gap: 9, alignItems: 'center' }}><Text style={{ color: amber ? p.amber : p.green }}>{isWorking(member) || hasQuestion(member) ? '●' : '○'}</Text><Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}>{memberTitle(member)}</Text>{age ? <Text style={mono}>{age}</Text> : null}</View>
    {bar ? <Bar done={member.ac_checked} total={member.ac_total} amber={amber} /> : null}
    {sentence ? <Text style={{ ...body, marginLeft: 18, marginTop: 4, color: amber ? p.amber : p.dim }}>{sentence}</Text> : null}
  </Pressable>;
}
function Recent({ entries, members }: { entries?: WorkLaneRecent[]; members: WorkLaneMember[] }) {
  if (!entries?.length) return null;
  return <Section name="Recent">{entries.map((entry, index) => {
    const member = members.find(m => m.spec_id === entry.spec_id);
    const text = entry.kind === 'note' ? entry.text : entry.kind === 'checks' ? `${entry.count ?? 0} checks passed` : entry.kind === 'done' ? member ? `✓ ${memberTitle(member)}` : null : entry.text ? `Blocked on ${entry.text}` : 'Blocked';
    if (!text) return null;
    return <Text key={`${entry.at}-${entry.spec_id}-${index}`} style={body}>{text}{readableAge(entry.at) ? ` · ${readableAge(entry.at)}` : ''}</Text>;
  })}</Section>;
}
function GoalCard({ goal, members, complete, onGoal, onMember }: { goal: Goal; members: WorkLaneMember[]; complete: boolean; onGoal(): void; onMember(member: WorkLaneMember): void }) {
  const visible = members.filter(m => moving(m) || m.status === 'blocked').sort((a, b) => memberRank(a) - memberRank(b));
  const rest = members.filter(m => !visible.slice(0, 3).includes(m) && m.status !== 'completed' && m.status !== 'deprecated');
  const counts = [rest.filter(moving).length, rest.filter(m => m.status === 'blocked').length, rest.filter(m => !moving(m) && m.status !== 'blocked').length];
  return <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: 8, padding: 14, backgroundColor: p.panel }}>
    <Pressable testID={`goal-head-${goal.goal_id ?? 'default'}`} accessibilityRole="button" onPress={onGoal} style={{ minHeight: 44 }}><View style={{ flexDirection: 'row', alignItems: 'center' }}><Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}><Text style={{ color: readableGoalClass(goal) === 'blocked' ? p.amber : p.green }}>◎</Text>  {goal.title}</Text>{readableAge(goal.progress_at) ? <Text style={mono}>{readableAge(goal.progress_at)}  </Text> : null}<Text style={mono}>›</Text></View><Bar done={goal.done} total={goal.total} movingCount={goal.moving} time={readableHours(goal.left_h)} allowEmpty /></Pressable>
    {visible.slice(0, 3).map(member => <SpecRow key={member.spec_id} member={member} onPress={() => onMember(member)} />)}
    {complete && rest.length ? <Pressable accessibilityRole="button" onPress={onGoal} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={mono}>{counts.map((n, i) => n ? `${n} ${['moving', 'blocked', 'queued'][i]}` : '').filter(Boolean).join(' · ')}</Text></Pressable> : null}
  </View>;
}
function SpecDetail({ member, members, onQuestion }: { member: WorkLaneMember; members: WorkLaneMember[]; onQuestion(): void }) {
  const [passedOpen, setPassedOpen] = useState(false);
  const trouble = readableTrouble(member), seats = readableSeatCount(member);
  const meta = [member.worked?.active_h != null ? `${member.worked.active_h.toFixed(1)}h worked` : null, seats].filter(Boolean).join(' · ');
  const open = (member.criteria ?? []).filter(c => c.disposition === 'open');
  const passed = (member.criteria ?? []).filter(c => c.disposition === 'done');
  return <View testID="readable-spec">
    {member.summary_line ? <Text style={body}>{member.summary_line}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 16 }}>{stageLabels[member.status ?? ''] ? <Text style={{ ...label, color: member.status === 'blocked' ? p.amber : p.green, borderWidth: 1, borderColor: member.status === 'blocked' ? p.amber : p.green, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 }}>{stageLabels[member.status ?? '']}</Text> : null}{meta ? <Text style={mono}>{meta}</Text> : null}</View>
    <Bar done={member.ac_checked} total={member.ac_total} time={readableHours(member.estimate?.median)} checks amber={member.status === 'blocked'} />
    {trouble.length ? <Text style={{ ...body, color: p.amber }}>{trouble.join(' · ')}</Text> : null}
    {hasQuestion(member) ? <Pressable testID="spec-open-question" accessibilityRole="button" onPress={onQuestion} style={{ paddingVertical: 14 }}><Text style={{ ...titleStyle, color: p.amber }}>●  {member.open_questions?.count} open {member.open_questions?.count === 1 ? 'question' : 'questions'}  ›</Text></Pressable> : null}
    {([['Now', member.status_line], ['Blocked on', member.status === 'blocked' ? member.blocked_line : null], ['Unblocks', member.unblocks?.map(x => x.title).join(', ')], ['Next', member.next_line]] as const).map(([name, value]) => value ? <View key={name} style={{ marginTop: 14, flexDirection: 'row', gap: 12 }}><Text style={{ ...label, width: 80 }}>{name}</Text><Text style={{ ...body, flex: 1 }}>{value}</Text></View> : null)}
    {member.ac_total ? <Section name="Checks left" count={open.length}>{open.map((c, i) => <Text key={i} style={body}>○  {c.title}</Text>)}{passed.length ? <Pressable onPress={() => setPassedOpen(v => !v)}><Text style={mono}>{passedOpen ? '−' : '+'} {passed.length} passed</Text></Pressable> : null}{passedOpen ? passed.map((c, i) => <Text key={i} style={body}>✓  {c.title}</Text>) : null}</Section> : null}
    <Recent entries={member.recent} members={members} />
  </View>;
}

export default function ReadableLanes({ lanes, inventory, assistantName, connected, top, bottom, onClose, readShow, active = true }: {
  lanes: LaneCardViewModel[]; inventory?: WorkLanesInventory | null; assistantName: string; connected: boolean; top: number; bottom: number; onClose(): void; readShow?: ReadWorkLaneShow; active?: boolean;
}) {
  const [laneId, setLaneId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null | undefined>(undefined);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [showNext, setShowNext] = useState(false), [showDone, setShowDone] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const selected = lanes.find(m => m.lane.lane_id === laneId);
  const show = useWorkLaneShow(laneId ?? '', connected, !!laneId, readShow, selected?.lane.detail_revision);
  const goalShow = useWorkLaneShow(laneId ?? '', connected, !!laneId && typeof goalId === 'string', readShow, selected?.lane.detail_revision, typeof goalId === 'string' ? goalId : undefined);
  const laneData = show.data?.lane_id === laneId ? show.data : null;
  const lane = laneData?.projection ?? selected?.lane;
  const observedMembers = useLaneMembers(selected?.members ?? [], laneData, show.requestEpoch);
  const noSpec = !!(lane?.no_spec_reason || selected?.lane.no_spec_reason);
  const members = noSpec ? [] : observedMembers;
  const goals: Goal[] = useMemo(() => {
    if (!lane || noSpec || !laneData) return [];
    const named: Goal[] = (lane.goals ?? []).map(g => ({ ...g }));
    if (lane.default_goal && lane.default_goal.total > 0) named.push({ ...lane.default_goal, goal_id: null, title: lane.title, rank: Number.MAX_SAFE_INTEGER });
    else if (!lane.default_goal && show.complete) {
      // Old detail replies can omit the default-goal aggregate. Only derive it
      // after all pages arrive, from unassigned non-deprecated members.
      const unassigned = members.filter(m => !m.goal_id && m.status !== 'deprecated');
      const done = unassigned.filter(m => m.status === 'completed').length;
      if (unassigned.length) named.push({ goal_id: null, title: lane.title, rank: Number.MAX_SAFE_INTEGER,
        total: unassigned.length, done, state: done === unassigned.length ? 'done' : unassigned.some(moving) ? 'in_progress' : 'not_started' });
    }
    return named.sort((a, b) => a.rank - b.rank);
  }, [lane, noSpec, laneData, show.complete, members]);
  const selectedGoal = goals.find(g => g.goal_id === goalId);
  const goalMembers = members.filter(m => (m.goal_id ?? null) === goalId);
  const member = members.find(m => m.spec_id === memberId);
  const goalDetail = goalId != null ? (goalShow.data?.lane_id === laneId ? goalShow.data?.projection?.goals?.find(g => g.goal_id === goalId) : undefined) ?? selectedGoal : selectedGoal;
  const working = lanes.some(m => laneWorking(m.lane));
  const motion = useWorkingMotion(active && !laneId, working);
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [laneId, goalId, memberId]);
  useEffect(() => { setShowDone(false); setShowNext(false); }, [laneId, goalId]);
  useEffect(() => {
    if (laneId && !selected) { setLaneId(null); setGoalId(undefined); setMemberId(null); }
  }, [laneId, selected]);
  useEffect(() => {
    if (show.complete && memberId && !members.some(m => m.spec_id === memberId)) setMemberId(null);
  }, [show.complete, memberId, members]);
  const back = () => { if (memberId) setMemberId(null); else if (goalId !== undefined) setGoalId(undefined); else setLaneId(null); };
  const openMember = (m: WorkLaneMember, g: Goal) => { setGoalId(g.goal_id); setMemberId(m.spec_id); };
  const laneGroups = { moving: lanes.filter(m => readableLaneClass(m.lane) === 'moving'), stalled: lanes.filter(m => readableLaneClass(m.lane) === 'stalled'), idle: lanes.filter(m => readableLaneClass(m.lane) === 'idle'), paused: lanes.filter(m => readableLaneClass(m.lane) === 'paused') };
  const badgeColor = member && (member.status === 'blocked' || hasQuestion(member)) ? p.amber : selectedGoal && readableGoalClass(selectedGoal) === 'blocked' ? p.amber : p.green;
  const headerTitle = member ? memberTitle(member) : selectedGoal ? selectedGoal.title : selected?.lane.title ?? assistantName;
  useVoiceSurface({ page_id: member ? 'spec' : selectedGoal ? 'goal' : selected ? 'lane' : 'lanes', title: headerTitle, ...(member ? { entity_id: member.spec_id } : selected ? { entity_id: selected.lane.lane_id } : {}) }, active, { priority: 1.5, bottom: bottom + 10, top: top + 72 });
  const headerSub = member ? [selectedGoal?.title, ago(member.progress_at)].filter(Boolean).join(' · ') : selectedGoal ? [lane?.title, ago(selectedGoal.progress_at)].filter(Boolean).join(' · ') : selected ? ago(selected.lane.state === 'paused' ? selected.lane.state_at : selected.lane.progress_at) : [ `${laneGroups.moving.length} moving`, laneGroups.stalled.length ? `${laneGroups.stalled.length} stalled` : null, laneGroups.idle.length ? `${laneGroups.idle.length} idle` : null, `${laneGroups.paused.length} paused` ].filter(Boolean).join(' · ');
  const paused = [...laneGroups.paused].sort((a, b) => (Date.parse(b.lane.state_at ?? '') || 0) - (Date.parse(a.lane.state_at ?? '') || 0));
  const node = (model: LaneCardViewModel): ConstellationNode => ({ id: model.lane.lane_id, title: model.lane.title, state: ago(model.lane.state === 'paused' ? model.lane.state_at : model.lane.progress_at) ?? '', color: readableLaneClass(model.lane) === 'stalled' ? p.amber : ['paused', 'idle'].includes(readableLaneClass(model.lane)) ? p.muted : p.green, fraction: 0, lane: model.lane, working: laneWorking(model.lane), question: model.waitingOnYou > 0 || laneNeedsYou(model.lane), labelled: true, onPress: () => setLaneId(model.lane.lane_id) });
  const inner = lanes.filter(m => m.lane.state !== 'paused').map(node);
  const outer = paused.slice(0, 6).map(node);
  if (paused.length > 6) outer.push({ id: 'paused-more', title: `+${paused.length - 6}`, state: '', color: p.muted, fraction: 0, fold: `+${paused.length - 6}`, labelled: true, onPress: () => setShowPaused(v => !v) });
  const openGoal = (g: Goal) => setGoalId(g.goal_id);
  return <View testID="lanes-overlay" style={{ flex: 1, backgroundColor: p.ink }}><Starfield />
    <View style={{ paddingTop: top, paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, borderColor: p.line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {selected ? <Pressable testID="lanes-back" accessibilityRole="button" accessibilityLabel="Back" onPress={back} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center' }}><Icon kind="back" /></View></Pressable> : null}
      {selected && goalId === undefined ? <LaneMark model={{ ...selected, stateTone: laneTone(selected) }} size={34} /> : <View style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: badgeColor, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: badgeColor, fontSize: 20 }}>{member ? '▤' : selectedGoal ? '◎' : '✧'}</Text></View>}
      <View style={{ flex: 1 }}><Text testID="readable-header-title" numberOfLines={2} style={titleStyle}>{headerTitle}</Text>{headerSub ? <Text numberOfLines={1} style={{ ...mono, color: member ? (isWorking(member) ? p.green : p.muted) : selectedGoal ? (readableGoalClass(selectedGoal) === 'working' ? p.green : p.muted) : selected && laneWorking(selected.lane) ? p.green : p.muted }}>{headerSub}</Text> : null}</View>
      <HeaderVoiceMic /><Pressable testID="lanes-close" accessibilityRole="button" accessibilityLabel="Close lanes" onPress={onClose} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center' }}><Icon kind="close" /></View></Pressable>
    </View>
    {inventory?.work_index?.available === false ? <Text testID="lanes-index-banner" style={{ ...mono, color: p.muted, paddingHorizontal: 16, paddingTop: 6 }}>DATA AS OF {inventory.work_index.snapshot_at || 'unknown'}</Text> : null}
    <ScrollView ref={scroll} testID="readable-lanes-scroll" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottom + 24 }}>
      {!selected ? <View testID="readable-home">
        <LanesConstellation width={Math.min(width - 32, 440)} height={390} inner={inner} outer={outer} assistantName={assistantName} motion={motion} lampWorking={working} />
        {showPaused ? paused.slice(6).map(m => <Pressable key={m.lane.lane_id} onPress={() => setLaneId(m.lane.lane_id)}><Text style={body}>{m.lane.title}</Text></Pressable>) : null}
        {(['moving', 'stalled', 'idle', 'paused'] as const).map(group => laneGroups[group].length ? <Section key={group} name={group} count={laneGroups[group].length}>{laneGroups[group].map(model => {
          const lead = readableLeadGoals(model.lane), limit = group === 'stalled' ? 2 : 3, age = readableAge(group === 'paused' ? model.lane.state_at : model.lane.progress_at);
          const counts = model.lane.goal_classes ? model.lane.goal_counts : undefined;
          const shownMoving = lead.slice(0, limit).filter(g => g.goalClass === 'moving' || g.goalClass === 'working').length;
          const shownBlocked = lead.slice(0, limit).filter(g => g.goalClass === 'blocked').length;
          const remaining = counts ? [Math.max(0, counts[0] - shownMoving), Math.max(0, counts[1] - shownBlocked), counts[2]] : [];
          return <Pressable key={model.lane.lane_id} testID={`lane-row-${model.lane.lane_id}`} accessibilityRole="button" onPress={() => setLaneId(model.lane.lane_id)} style={{ borderBottomWidth: 1, borderColor: p.line, paddingVertical: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><LaneMark model={{ ...model, stateTone: laneTone(model) }} size={28} /><Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}>{model.lane.title}</Text>{model.waitingOnYou || laneNeedsYou(model.lane) ? <Text style={{ color: p.amber }}>●</Text> : null}{age ? <Text style={mono}>{age}</Text> : null}</View>
            {lead.slice(0, limit).map(({ goal, goalClass }) => <View key={goal.goal_id || 'default'} style={{ marginTop: 8, marginLeft: 37 }}><View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}><Text style={{ color: goalClass === 'blocked' ? p.amber : p.green }}>{goalClass === 'working' ? '●' : '○'}</Text><Text numberOfLines={2} style={{ ...body, color: p.text, flex: 1 }}>{goal.title}</Text><Text style={mono}>{goal.done}/{goal.total}</Text></View><View style={{ marginLeft: 15, marginTop: 4, height: 4, backgroundColor: p.line }}><View style={{ height: 4, width: `${goal.total ? Math.max(0, Math.min(1, goal.done / goal.total)) * 100 : 0}%`, backgroundColor: goalClass === 'blocked' ? p.amber : p.green }} /></View></View>)}
            {remaining.some(Boolean) ? <Text style={{ ...mono, marginLeft: 52, marginTop: 8 }}>{remaining.map((n, i) => n ? `${n} ${['moving', 'blocked', 'queued'][i]}` : '').filter(Boolean).join(' · ')}</Text> : null}
          </Pressable>;
        })}</Section> : null)}
      </View> : !connected && !laneData ? <LeafText id="lanes-connection-wait" text="Waiting for connection" style={body} /> : show.error ? <Pressable testID="lanes-detail-retry" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={show.retry}><Text style={{ ...body, color: p.amber }}>{show.error} · Retry</Text></Pressable> : !laneData ? <LeafLoading id="lanes-map-members-loading" text="Loading lane" /> : member ? <SpecDetail member={member} members={members} onQuestion={() => { laneQuestionCardStore(selected.lane.lane_id).show(); setMemberId(null); setGoalId(undefined); }} /> : selectedGoal ? <View testID="readable-goal">
        {!show.complete ? <LeafLoading id="lanes-members-paging" text="Loading more specs" /> : null}
        {goalShow.error ? <Pressable testID="goal-detail-retry" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={goalShow.retry}><Text style={body}>{goalShow.error} · Retry</Text></Pressable> : null}
        {goalDetail?.summary_line && goalId !== null ? <Text style={body}>{goalDetail.summary_line}</Text> : null}
        <Bar done={selectedGoal.done} total={selectedGoal.total} movingCount={selectedGoal.moving} time={readableHours(selectedGoal.left_h)} allowEmpty />
        {(['Moving', 'Blocked', 'Next up', 'Done'] as const).map(group => {
          const groupMembers = goalMembers.filter(m => group === 'Moving' ? moving(m) : group === 'Blocked' ? m.status === 'blocked' : group === 'Done' ? m.status === 'completed' : !moving(m) && !['blocked', 'completed', 'deprecated'].includes(m.status ?? ''));
          if (!groupMembers.length) return null;
          const rows = group === 'Done' && !showDone ? [] : group === 'Next up' && !showNext ? groupMembers.slice(0, 3) : groupMembers;
          return <Section key={group} name={group} count={show.complete ? groupMembers.length : undefined}>{rows.map(m => group === 'Moving' || group === 'Blocked' ? <SpecRow key={m.spec_id} member={m} bar onPress={() => setMemberId(m.spec_id)} /> : <Pressable key={m.spec_id} testID={`spec-row-${m.spec_id}`} accessibilityRole="button" onPress={() => setMemberId(m.spec_id)} style={{ flexDirection: 'row', paddingVertical: 10, minHeight: 44, borderBottomWidth: 1, borderColor: p.line }}><Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}>{memberTitle(m)}</Text>{readableAge(m.progress_at) ? <Text style={mono}>{readableAge(m.progress_at)}</Text> : null}</Pressable>)}{group === 'Done' ? <Pressable testID="goal-done-fold" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setShowDone(v => !v)}><Text style={mono}>{showDone ? 'Hide' : 'Show'} done</Text></Pressable> : null}{group === 'Next up' && groupMembers.length > 3 ? <Pressable testID="goal-next-expand" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => setShowNext(v => !v)}><Text style={mono}>{showNext ? 'Show less' : `Show ${groupMembers.length - 3} more`}</Text></Pressable> : null}</Section>;
        })}
        {goalId !== null ? <Recent entries={goalDetail?.recent} members={goalMembers} /> : null}
      </View> : <View testID="readable-lane">
        {!show.complete ? <LeafLoading id="lanes-members-paging" text="Loading more specs" /> : null}
        <QuestionDeckCard key={laneId} embedded laneId={laneId ?? undefined} laneStreams={[...(selected.lane.lead ? [selected.lane.lead.stream_id] : []), ...members.flatMap(m => (m.seats ?? []).map(s => s.stream_id))]} laneQuestionIds={members.flatMap(m => m.open_questions?.first_question_id ? [m.open_questions.first_question_id] : [])} />
        {(['moving', 'blocked', 'queued', 'done'] as const).map(group => {
          const rows = goals.filter(g => { const c = readableGoalClass(g); return group === 'moving' ? c === 'moving' || c === 'working' : c === group; });
          if (!rows.length) return null;
          return <Section key={group} name={group === 'queued' && lane?.state === 'paused' ? 'Goals' : group} count={rows.length}>{rows.map(g => group === 'moving' || group === 'blocked' ? <GoalCard key={g.goal_id ?? 'default'} goal={g} complete={show.complete} members={members.filter(m => (m.goal_id ?? null) === g.goal_id)} onGoal={() => openGoal(g)} onMember={m => openMember(m, g)} /> : <Pressable key={g.goal_id ?? 'default'} testID={`goal-head-${g.goal_id ?? 'default'}`} onPress={() => openGoal(g)} style={{ flexDirection: 'row', paddingVertical: 12, minHeight: 44, borderBottomWidth: 1, borderColor: p.line }}><Text numberOfLines={2} style={[titleStyle, { flex: 1 }]}>◎  {g.title}</Text><Text style={mono}>{g.done}/{g.total}{readableAge(g.progress_at) ? ` · ${readableAge(g.progress_at)}` : ''}  ›</Text></Pressable>)}</Section>;
        })}
        <Recent entries={laneData.recent ?? lane?.recent} members={members} />
      </View>}
    </ScrollView>
  </View>;
}
