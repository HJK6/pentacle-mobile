import React, { useEffect, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PentacleEvent } from 'pentacle-chat-core';
import { Fonts, Tokens } from '@/constants/Colors';
import ArcaneRingFrame from '../ArcaneRingFrame';
import Bevel from '../Bevel';
import StatusTag from '../StatusTag';
import { CardStatusMini } from '../SessionStatusCard';
import { formatLaneEta } from '../../services/laneEta';
import type { StatusLane } from './statusSelectors';
import { useAssistantIdentity } from '../../services/assistantIdentity';
import { getHostMachineName } from '../../config/local';

function PulseDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.35, duration: 900, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
    ]));
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);
  return <Animated.View testID="status-pulse" style={[styles.dot, { opacity }]} />;
}

function UpdateCard({ event, latest, log = false }: { event: PentacleEvent; latest: boolean; log?: boolean }) {
  const timestamp = Date.parse(event.timestamp);
  const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  return <Bevel fill={latest ? `${Tokens.palette.green}0c` : 'transparent'}
    stroke={latest ? `${Tokens.palette.green}33` : Tokens.palette.line} contentStyle={styles.updateCard}>
    <View style={styles.inline}><Text style={[styles.time, { color: latest ? Tokens.palette.green : Tokens.palette.muted }]}>{time}</Text>{latest && <PulseDot />}</View>
    <Text style={[styles.updateText, { color: log ? (latest ? Tokens.palette.green : Tokens.palette.dim) : Tokens.palette.text }]}>{event.text}</Text>
  </Bevel>;
}

function LaneRow({ lane, now, onOpen }: { lane: StatusLane; now: number; onOpen: (streamId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { chat, session, needsYou, step } = lane;
  const card = chat.status_card;
  return <View style={styles.lane}>
    <View style={styles.inline}>
      <Pressable testID={`lane-${chat.streamId}`} accessibilityRole="button" accessibilityLabel={`Open ${chat.title}`}
        onPress={() => onOpen(chat.streamId)} style={styles.laneBody}>
        <ArcaneRingFrame machine={chat.machineName} size={34} sigilSize={23} />
        <View style={styles.copy}><Text style={styles.laneTitle} numberOfLines={1}>{chat.title}</Text>
          <Text style={[styles.step, needsYou && styles.blocked]} numberOfLines={1}>{chat.hostTitle} · {step}</Text></View>
        <View style={styles.eta}><Text style={styles.etaLabel}>ETA</Text>
          <Text testID={`lane-eta-${chat.streamId}`} style={[styles.etaValue, needsYou && styles.blocked]}>{formatLaneEta({ eta_at: session?.eta_at, eta_set_at: session?.eta_set_at, now, needsYou })}</Text></View>
      </Pressable>
      <Pressable testID={`lane-toggle-${chat.streamId}`} accessibilityRole="button"
        accessibilityLabel={card ? `${expanded ? 'Collapse' : 'Expand'} ${chat.title} status` : 'No status available'}
        accessibilityState={{ expanded, disabled: !card }} disabled={!card} onPress={() => setExpanded((value) => !value)} style={styles.caret}>
        <Text style={styles.caretText}>{expanded ? '⌄' : '›'}</Text>
      </Pressable>
    </View>
    {expanded && card && <CardStatusMini session={chat} card={card} onOpen={onOpen} />}
  </View>;
}

type Props = {
  updates: PentacleEvent[];
  lanes: StatusLane[];
  working: boolean;
  now: number;
  top: number;
  bottom: number;
  loading: boolean;
  error: boolean;
  showLog: boolean;
  onShowLog: (visible: boolean) => void;
  onOpen: (streamId: string) => void;
  onLoadEarlier: () => void;
};

export default function StatusSurface({ updates, lanes, working, now, top, bottom, loading, error, showLog, onShowLog, onOpen, onLoadEarlier }: Props) {
  const assistant = useAssistantIdentity();
  const latest = updates[0];
  const empty = <Text style={styles.empty}>{error ? 'Updates unavailable' : loading ? 'Loading updates…' : 'No status updates yet'}</Text>;
  return <>
    <View style={[styles.header, { paddingTop: top }]}>
      <ArcaneRingFrame identity kind={assistant.sigilKind} size={38} sigilSize={26}
        machine={assistant.hostId ? getHostMachineName(assistant.hostId) : undefined} />
      <View style={styles.copy}><Text testID="status-assistant-name" style={styles.name}>{assistant.name}</Text>
        <View style={styles.inline}><View testID="bart-status-tag" style={styles.inline}>
          <StatusTag status={working ? 'working' : 'idle'} />
          <Text style={[styles.status, { color: working ? Tokens.palette.green : Tokens.palette.amber }]}>{working ? 'WORKING' : 'IDLE'}</Text>
        </View><Text style={styles.count}>{lanes.length} LANES</Text></View>
      </View>
    </View>
    {showLog ? <>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to status" onPress={() => onShowLog(false)} style={styles.back}>
        <Text style={styles.caretText}>‹</Text><Text style={styles.label}>UPDATE LOG</Text>
      </Pressable>
      <FlatList data={updates} keyExtractor={(item) => `${item.stream_id}:${item.daemon_seq}`}
        contentContainerStyle={[styles.log, { paddingBottom: bottom }]} onEndReached={onLoadEarlier} onEndReachedThreshold={0.3}
        ListEmptyComponent={empty} renderItem={({ item, index }) => <View testID={`status-update-${item.daemon_seq}`} style={styles.logRow}>
          <UpdateCard event={item} latest={index === 0} log />
        </View>} />
    </> : <ScrollView contentContainerStyle={[styles.body, { paddingBottom: bottom }]}>
      <View style={styles.latestSection}><View style={styles.inline}>
        <Text style={[styles.label, styles.copy]}>Latest update</Text>
        <Pressable accessibilityRole="button" onPress={() => onShowLog(true)}><Text style={styles.allUpdates}>All updates · {updates.length} ›</Text></Pressable>
      </View>
        {latest ? <Pressable testID="latest-update" accessibilityRole="button" accessibilityLabel="Open update log" onPress={() => onShowLog(true)}>
          <UpdateCard event={latest} latest />
        </Pressable> : empty}
      </View>
      <View><Text style={styles.label}>Open lanes · {lanes.length}</Text>
        {lanes.map((lane) => <LaneRow key={lane.chat.streamId} lane={lane} now={now} onOpen={onOpen} />)}
      </View>
    </ScrollView>}
  </>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: `${Tokens.palette.green}33` },
  name: { fontFamily: Fonts.rajdhani.bold, fontSize: 17, color: Tokens.palette.text, lineHeight: 20 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  copy: { flex: 1, minWidth: 0 },
  status: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9 },
  count: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 0.5, color: Tokens.palette.muted },
  body: { padding: 16, gap: 22 },
  latestSection: { gap: 8 },
  label: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5, letterSpacing: 1.4, color: Tokens.palette.green, textTransform: 'uppercase' },
  allUpdates: { fontFamily: Fonts.rajdhani.bold, fontSize: 13.5, color: Tokens.palette.dim, padding: 2 },
  updateCard: { paddingVertical: 11, paddingHorizontal: 13, gap: 4 },
  time: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Tokens.palette.green },
  updateText: { fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 22 },
  lane: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', paddingVertical: 11 },
  laneBody: { flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1 },
  laneTitle: { fontFamily: Fonts.rajdhani.bold, fontSize: 15, color: Tokens.palette.text },
  step: { fontFamily: Fonts.rajdhani.medium, fontSize: 12.5, color: Tokens.palette.muted, marginTop: 2 },
  eta: { alignItems: 'flex-end', flexShrink: 0 },
  etaLabel: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: Tokens.palette.muted },
  etaValue: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12, color: Tokens.palette.text },
  blocked: { color: Tokens.palette.amber },
  caret: { minWidth: 34, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  caretText: { color: Tokens.palette.dim, fontSize: 26 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  log: { paddingHorizontal: 16, paddingTop: 6 },
  logRow: { marginBottom: 14 },
  empty: { fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, color: Tokens.palette.muted },
});
