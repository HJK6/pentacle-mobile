import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WorkLaneUpdate, WorkLaneUpdateKind } from 'pentacle-chat-core';
import { Fonts, Tokens } from '@/constants/Colors';
import Bevel from '../Bevel';

const KIND_LABELS: Record<WorkLaneUpdateKind, string> = {
  major_decision: 'DECISION',
  lane_started: 'LANE STARTED',
  lane_completed: 'LANE COMPLETED',
  lane_blocked: 'LANE BLOCKED',
  lane_unblocked: 'LANE UNBLOCKED',
  milestone: 'MILESTONE',
};

export function laneUpdateKindLabel(kind: WorkLaneUpdateKind): string {
  return KIND_LABELS[kind];
}

function accentFor(kind: WorkLaneUpdateKind): string {
  if (kind === 'lane_blocked') return Tokens.palette.amber;
  if (kind === 'lane_completed' || kind === 'lane_started' || kind === 'lane_unblocked') return Tokens.palette.green;
  return Tokens.palette.dim;
}

function timeLabel(ts: string): string {
  const stamp = Date.parse(ts);
  return Number.isFinite(stamp)
    ? new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
}

/** One typed lane update in Bart's timeline (`publish_kind: 'lane_update'`). */
export default function LaneUpdateCard({ update, onPress }: { update: WorkLaneUpdate; onPress?: () => void }) {
  const accent = accentFor(update.kind);
  const label = laneUpdateKindLabel(update.kind);
  const time = timeLabel(update.ts);
  const body = <Bevel fill={`${accent}0c`} stroke={`${accent}55`} contentStyle={styles.card}>
    <View style={styles.meta}>
      <Text style={[styles.kind, { color: accent }]}>{label}</Text>
      {time ? <Text style={styles.time}>{time}</Text> : null}
    </View>
    {update.title ? <Text style={styles.title} numberOfLines={2}>{update.title}</Text> : null}
    <Text style={styles.summary}>{update.summary}</Text>
  </Bevel>;
  const accessibilityLabel = `${label}${update.title ? `: ${update.title}` : ''}. ${update.summary}`;
  return onPress
    ? <Pressable testID={`lane-update-card-${update.update_id}`} accessibilityRole="button"
      accessibilityLabel={accessibilityLabel} onPress={onPress} style={styles.root}>{body}</Pressable>
    : <View testID={`lane-update-card-${update.update_id}`} accessible accessibilityLabel={accessibilityLabel}
      style={styles.root}>{body}</View>;
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch', marginVertical: 4 },
  card: { paddingVertical: 11, paddingHorizontal: 13, gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 9 },
  kind: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1.2 },
  time: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, color: Tokens.palette.muted },
  title: { fontFamily: Fonts.rajdhani.bold, fontSize: 15, color: Tokens.palette.text },
  summary: { fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 21, color: Tokens.palette.text },
});
