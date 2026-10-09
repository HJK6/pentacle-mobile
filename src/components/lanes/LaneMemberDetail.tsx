import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { WorkLaneMember } from 'pentacle-chat-core';
import { Tokens } from '@/constants/Colors';
import { laneStyles as s } from './laneStyles';

export function memberTitle(member: WorkLaneMember): string { return member.title || member.spec_id; }
export function memberEstimate(member: WorkLaneMember): string {
  const estimate = member.estimate;
  return estimate ? `${estimate.p25}–${estimate.p75}h${estimate.provisional ? ' · provisional' : ''}` : '—';
}
export function memberAcceptance(member: WorkLaneMember): string {
  return member.ac_checked != null && member.ac_total != null ? `${member.ac_checked}/${member.ac_total}` : '—';
}

export function ObservationMarker({ member }: { member: WorkLaneMember }) {
  const observation = member.observation;
  if (!observation || observation.quality === 'fresh') return null;
  return <View style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: observation.quality === 'stale' ? Tokens.palette.amber : Tokens.palette.red, paddingLeft: 8 }}>
    <Text style={s.error}>{observation.quality.toUpperCase()} · observed {observation.observed_at || 'unknown'}</Text>
    {observation.error ? <Text style={s.error}>{observation.error}</Text> : null}
  </View>;
}

export function LaneMemberSummary({ member }: { member: WorkLaneMember }) {
  return <View style={{ gap: 6 }}>
    <Text style={s.label}>{(member.status || 'unknown').replace(/_/g, ' ').toUpperCase()}</Text>
    <Text style={s.title}>{memberTitle(member)}</Text>
    <Text style={s.meta}>AC {memberAcceptance(member)} · est. {memberEstimate(member)}</Text>
    {member.status_text ? <Text style={s.muted}>{member.status_text}</Text> : null}
    {member.next_action_text ? <Text style={s.text}>Next · {member.next_action_text}</Text> : null}
    <ObservationMarker member={member} />
  </View>;
}

export default function LaneMemberDetail({ member, laneTitle, onBack, bottom = 18 }: {
  member: WorkLaneMember; laneTitle: string; onBack(): void; bottom?: number;
}) {
  return <View testID={`member-detail-${member.spec_id}`} style={s.root}>
    <ScrollView contentContainerStyle={{ paddingBottom: bottom }}>
    <View style={s.header}>
      <Pressable testID="member-detail-back" accessibilityRole="button" accessibilityLabel={`Back to ${laneTitle}`} onPress={onBack} style={s.button}>
        <Text numberOfLines={2} style={s.buttonText}>‹ {laneTitle}</Text>
      </Pressable>
    </View>
    <View style={s.body}>
      <LaneMemberSummary member={member} />
      <Text style={s.meta}>{member.spec_id}</Text>
      {member.estimate ? <Text style={s.meta}>Median {member.estimate.median}h</Text> : null}
      <Text style={s.meta}>Observed · {member.observation?.observed_at || 'unknown'}</Text>
      <Text style={s.meta}>Changed · {member.source_changed_at || 'unknown'}</Text>
    </View>
    </ScrollView>
  </View>;
}
