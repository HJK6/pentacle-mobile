import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WorkLaneMember } from 'pentacle-chat-core';
import { Tokens } from '@/constants/Colors';
import type { LaneCardViewModel } from '../../services/workLanes';
import { LaneMemberSummary, memberTitle } from './LaneMemberDetail';
import { laneStyles as s } from './laneStyles';

export default function LaneCard({ model, onOpenMember, onShowAll, onLog, onChat }: {
  model: LaneCardViewModel; onOpenMember(model: LaneCardViewModel, member: WorkLaneMember): void;
  onShowAll(model: LaneCardViewModel): void; onLog(model: LaneCardViewModel): void; onChat(model: LaneCardViewModel): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { lane } = model;
  const tone = Tokens.palette[model.stateTone];
  return <View testID={`lane-card-${lane.lane_id}`} style={[s.panel, { borderColor: lane.state === 'blocked' ? `${Tokens.palette.amber}66` : Tokens.palette.line }]}>
    <Text style={s.title}>{lane.title}</Text>
    <Text testID={`lane-card-state-${lane.lane_id}`} style={[s.label, { color: tone }]}>{model.stateLabel}</Text>
    <Text style={s.meta}>{model.leadHost || 'No lead'} · {model.presenceLabel} · {model.freshnessLabel}</Text>
    {!model.membersPending && !lane.no_spec_reason ? <>
      <View style={styles.segments} accessibilityLabel="Spec progress">
        {model.segments.map((segment) => <View key={segment.specId} testID={`lane-segment-${lane.lane_id}-${segment.specId}`}
          accessibilityLabel={`${segment.status}, ${Math.round(segment.fraction * 100)} percent`}
          style={[styles.segment, segment.unresolved && { backgroundColor: `${Tokens.palette.red}44` }]}>
          <View style={{ height: '100%', width: `${segment.fraction * 100}%`, backgroundColor: Tokens.palette[segment.tone] }} />
        </View>)}
      </View>
      <Text style={s.meta}>{model.completed}/{model.total} specs done · AC {lane.ac_checked ?? '—'}/{lane.ac_total ?? '—'}</Text>
    </> : null}
    <Text testID={`lane-card-progress-${lane.lane_id}`} style={s.text}>{model.progressLabel}</Text>
    {model.waitingOnYou > 0 ? <Text style={[s.text, { color: Tokens.palette.amber }]}>? {model.waitingOnYouLabel}</Text>
      : model.blockerLabel ? <Text style={[s.text, { color: Tokens.palette.amber }]}>! {model.blockerLabel}</Text> : null}
    {model.lastUpdateText ? <Text style={s.muted}>{model.lastUpdateText}</Text> : null}
    {lane.no_spec_reason ? null : model.membersPending ? <Text testID={`lane-card-members-pending-${lane.lane_id}`} style={s.muted}>Specs arrive when the daemon updates</Text> : <>
      <Pressable testID={`lane-card-toggle-${lane.lane_id}`} accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} specs for ${lane.title}`}
        accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={s.button}>
        <Text style={s.buttonText}>{expanded ? 'Hide specs' : `Show ${model.membersTotal} specs`}</Text>
      </Pressable>
      {expanded ? <View style={{ gap: 10 }}>
        {model.members.map((member) => <Pressable key={member.spec_id} testID={`lane-card-member-${lane.lane_id}-${member.spec_id}`}
          accessibilityRole="button" accessibilityLabel={`${memberTitle(member)}, ${member.status || 'unknown'}`} style={s.button}
          onPress={() => onOpenMember(model, member)}><LaneMemberSummary member={member} /></Pressable>)}
        {model.membersTotal > model.members.length ? <Pressable testID={`lane-card-show-all-${lane.lane_id}`} accessibilityRole="button"
          accessibilityLabel={`Show all ${model.membersTotal} specs`} onPress={() => onShowAll(model)} style={s.button}>
          <Text style={s.buttonText}>Show all {model.membersTotal} specs</Text>
        </Pressable> : null}
      </View> : null}
    </>}
    <View style={s.row}>
      <Pressable testID={`lane-card-log-${lane.lane_id}`} accessibilityRole="button" accessibilityLabel={`View log for ${lane.title}`} onPress={() => onLog(model)} style={s.button}>
        <Text style={s.buttonText}>Lane log</Text>
      </Pressable>
      <Pressable testID={`lane-card-chat-${lane.lane_id}`} accessibilityRole="button" accessibilityLabel={`See chat for ${lane.title}`}
        accessibilityState={{ disabled: model.tap.action === 'unavailable' }} disabled={model.tap.action === 'unavailable'} onPress={() => onChat(model)} style={s.button}>
        <Text style={s.buttonText}>{model.tap.action === 'unavailable' ? 'Chat unavailable' : model.tap.action === 'history' ? 'View closed chat' : 'See chat'}</Text>
      </Pressable>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  segments: { flexDirection: 'row', gap: 3 },
  segment: { flex: 1, height: 6, backgroundColor: Tokens.palette.codePanel, borderRadius: 2, overflow: 'hidden' },
});
