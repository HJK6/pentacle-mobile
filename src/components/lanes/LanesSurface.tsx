import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '@/constants/Colors';
import type { WorkLanesInventory } from 'pentacle-chat-core';
import LaneRow from './LaneRow';
import type { LaneViewModel } from '../../services/workLanes';

type Props = {
  lanes: LaneViewModel[];
  counts: WorkLanesInventory['counts'];
  truncated: boolean;
  now: number;
  top: number;
  bottom: number;
  onOpenLane: (model: LaneViewModel) => void;
  onOpenLead: (streamId: string) => void;
  onClose?: () => void;
};

// Lane list for the header's lanes tap. Lane identity, state, order and count
// are the daemon's; this surface never reorders or recounts them.
export default function LanesSurface({ lanes, counts, truncated, top, bottom, onOpenLane, onOpenLead, onClose }: Props) {
  const visible = lanes.filter((model) => model.lane.state !== 'done');
  return <View testID="lanes-surface" style={styles.root}>
    <View style={[styles.header, { paddingTop: top }]}>
      <View style={styles.copy}>
        <Text style={styles.title}>Work lanes</Text>
        <Text testID="lanes-count" style={styles.count}>
          {counts.open} LANES{counts.blocked ? ` · ${counts.blocked} BLOCKED` : ''}
        </Text>
      </View>
      {onClose
        ? <Pressable accessibilityRole="button" accessibilityLabel="Close lanes" onPress={onClose} style={styles.close}>
          <Text style={styles.closeText}>✕</Text></Pressable>
        : null}
    </View>
    <ScrollView contentContainerStyle={[styles.body, { paddingBottom: bottom }]}>
      <Text style={styles.label}>Open lanes · {counts.open}</Text>
      {visible.length === 0 ? <Text style={styles.empty}>No open lanes</Text> : null}
      {visible.map((model) => <LaneRow key={model.lane.lane_id} model={model} onOpen={onOpenLane} onOpenLead={onOpenLead} />)}
      {truncated ? <Text style={styles.empty}>Showing {visible.length} of {counts.open} open lanes</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: `${Tokens.palette.green}33` },
  copy: { flex: 1, minWidth: 0 },
  title: { fontFamily: Fonts.rajdhani.bold, fontSize: 17, color: Tokens.palette.text, lineHeight: 20 },
  count: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 0.5, color: Tokens.palette.muted, marginTop: 3 },
  close: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: Tokens.palette.line,
    backgroundColor: Tokens.palette.panel, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: Tokens.palette.muted, fontSize: 18 },
  body: { padding: 16, gap: 4 },
  label: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5, letterSpacing: 1.4, color: Tokens.palette.green, textTransform: 'uppercase' },
  empty: { fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, color: Tokens.palette.muted, paddingVertical: 8 },
});
