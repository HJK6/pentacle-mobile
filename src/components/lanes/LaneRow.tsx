import React, { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WorkLane } from 'pentacle-chat-core';
import { Fonts, Tokens } from '@/constants/Colors';
import { CardStatusMini } from '../SessionStatusCard';
import { laneLeadStatusCard, laneStateLabel, type LaneViewModel } from '../../services/workLanes';

function stateColor(state: WorkLane['state']): string {
  if (state === 'blocked') return Tokens.palette.amber;
  if (state === 'active') return Tokens.palette.green;
  return Tokens.palette.muted;
}

export function lanePresenceLabel(lane: WorkLane): string {
  const lead = lane.lead;
  if (!lead) return 'no lead';
  if (!lead.presence.online) return 'offline';
  return lead.presence.working ? 'working' : 'idle';
}

function LaneRow({ model, onOpen, onOpenLead }: {
  model: LaneViewModel; onOpen: (model: LaneViewModel) => void; onOpenLead: (streamId: string) => void;
}) {
  const { lane, tap, eta, etaStale } = model;
  const [expanded, setExpanded] = useState(false);
  const card = lane.lead?.qualifies && lane.lead.status === 'open' ? laneLeadStatusCard(lane) : null;
  const unavailable = tap.action === 'unavailable';
  const color = stateColor(lane.state);
  return <View style={styles.lane}>
    <View style={styles.inline}>
      <Pressable testID={`lane-row-${lane.lane_id}`} accessibilityRole="button" disabled={unavailable}
        accessibilityLabel={`${lane.title}, ${laneStateLabel(lane.state)}${unavailable ? ', chat unavailable' : ''}`}
        accessibilityState={{ disabled: unavailable }} onPress={() => onOpen(model)} style={styles.body}>
        <View style={styles.copy}>
          <View style={styles.inline}>
            <Text testID={`lane-state-${lane.lane_id}`} style={[styles.state, { color, borderColor: `${color}66` }]}>
              {laneStateLabel(lane.state)}
            </Text>
            <Text testID={`lane-owner-${lane.lane_id}`} style={styles.owner}>{lane.owner_kind === 'operator' ? 'OPERATOR' : 'FD'}</Text>
          </View>
          <Text style={styles.title} numberOfLines={1}>{lane.title}</Text>
          {lane.state === 'blocked' && lane.blocker
            ? <Text style={styles.blocker} numberOfLines={2}>{lane.blocker}</Text>
            : lane.summary ? <Text style={styles.summary} numberOfLines={1}>{lane.summary}</Text> : null}
          <View style={styles.inline}>
            <View style={[styles.dot, lane.lead?.presence.online && lane.lead.qualifies ? styles.dotOn : null]} />
            <Text testID={`lane-presence-${lane.lane_id}`} style={styles.presence}>{lanePresenceLabel(lane)}</Text>
          </View>
        </View>
        <View style={styles.eta}>
          <Text style={styles.etaLabel}>ETA</Text>
          <Text testID={`lane-eta-${lane.lane_id}`}
            style={[styles.etaValue, (lane.state === 'blocked' || etaStale) && styles.warn]}>{eta}</Text>
        </View>
      </Pressable>
      <Pressable testID={`lane-toggle-${lane.lane_id}`} accessibilityRole="button" disabled={!card}
        accessibilityLabel={card ? `${expanded ? 'Collapse' : 'Expand'} ${lane.title} status` : 'No lead status available'}
        accessibilityState={{ expanded, disabled: !card }} onPress={() => setExpanded((value) => !value)} style={styles.caret}>
        <Text style={styles.caretText}>{expanded ? '⌄' : '›'}</Text>
      </Pressable>
    </View>
    {unavailable
      ? <Text testID={`lane-unavailable-${lane.lane_id}`} style={styles.unavailable}>Chat unavailable</Text>
      : null}
    {expanded && card && lane.lead
      ? <CardStatusMini session={{ stream_id: lane.lead.stream_id }} card={card} onOpen={onOpenLead} />
      : null}
  </View>;
}

export default memo(LaneRow);

const styles = StyleSheet.create({
  lane: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', paddingVertical: 11 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  body: { flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  state: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9.5, letterSpacing: 1, borderWidth: 1, borderRadius: 3,
    paddingHorizontal: 5, paddingVertical: 1 },
  owner: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: Tokens.palette.muted },
  title: { fontFamily: Fonts.rajdhani.bold, fontSize: 16, color: Tokens.palette.text },
  summary: { fontFamily: Fonts.rajdhani.medium, fontSize: 12.5, color: Tokens.palette.muted },
  blocker: { fontFamily: Fonts.rajdhani.medium, fontSize: 12.5, color: Tokens.palette.amber },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Tokens.palette.muted },
  dotOn: { backgroundColor: Tokens.palette.green },
  presence: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, color: Tokens.palette.muted },
  eta: { alignItems: 'flex-end', flexShrink: 0 },
  etaLabel: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: Tokens.palette.muted },
  etaValue: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12, color: Tokens.palette.text },
  warn: { color: Tokens.palette.amber },
  caret: { minWidth: 34, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  caretText: { color: Tokens.palette.dim, fontSize: 26 },
  unavailable: { fontFamily: Fonts.rajdhani.medium, fontSize: 12.5, color: Tokens.palette.amber, marginTop: 4 },
});
