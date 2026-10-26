import HeaderVoiceMic from '../voice/HeaderVoiceMic';
import { compactHeaderLayout } from '../headerLayout';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Fonts, Tokens } from '@/constants/Colors';
import ArcaneRingFrame from '../ArcaneRingFrame';
import { AssistantIcon, assistantAccent } from './assistantIdentity';
import type { AssistantIdentity } from '../../services/assistantIdentity';
import StatusTag from '../StatusTag';

type Props = {
  identity: AssistantIdentity; others: number; pending: number; lanes: number; blocked?: number; working: boolean; top: number;
  onDrawer(): void; onStatus(): void; onQuestions(): void;
};

function HeaderButton({ kind, count, onPress }: { kind: 'sessions' | 'questions'; count: number; onPress(): void }) {
  const sessions = kind === 'sessions';
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}
    accessibilityLabel={sessions ? `Sessions, ${count} need you` : `Questions, ${count} pending`}>
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={Tokens.palette.dim}
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d={sessions ? 'M4 6h16M4 12h11M4 18h7' : 'M9.2 9a2.9 2.9 0 1 1 4.3 2.5c-.9.55-1.5 1-1.5 2.1M12 17.4v.05'} />
    </Svg>
    {count > 0 ? <Text testID={`assistant-${kind}-badge`} style={styles.badge}>{count}</Text> : null}
  </Pressable>;
}

export default function AssistantHeader({ identity, others, pending, lanes, blocked = 0, working, top, onDrawer, onStatus, onQuestions }: Props) {
  return <View testID="assistant-header" style={[styles.header, { paddingTop: Math.max(top, 52) }]}>
    <HeaderButton kind="sessions" count={others} onPress={onDrawer} />
    <View style={styles.identity}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${identity.name} status, ${lanes} open lanes${blocked > 0 ? `, ${blocked} blocked` : ''}`}
      onPress={onStatus} style={styles.identityMark}>
      <ArcaneRingFrame size={38} color={assistantAccent(identity)} identity>
        <AssistantIcon identity={identity} size={38 * 0.64} />
      </ArcaneRingFrame>
      </Pressable>
      <View style={styles.nameBlock}>
        <Pressable onPress={onStatus} accessibilityRole="button" accessibilityLabel={`${identity.name} status`} style={{ flexShrink: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{identity.name}</Text>
        </Pressable>
        <Pressable onPress={onStatus} accessibilityRole="button" accessibilityLabel={`${lanes} open lanes${blocked > 0 ? `, ${blocked} blocked` : ''}`} style={styles.meta}>
          <StatusTag status={working ? 'working' : 'idle'} />
          <Text style={styles.lanes}>{lanes} LANES</Text>
          {blocked > 0 ? <Text testID="assistant-lanes-blocked" style={styles.blocked}>{blocked} BLOCKED</Text> : null}
          {/* Extends the ~13pt row to a 44pt target; unlike hitSlop, the overflowing child is hit-tested outside the parent. */}
          <View testID="assistant-meta-hit-area" style={styles.metaHitArea} />
        </Pressable>
      </View>
      <HeaderVoiceMic />
    </View>
    <HeaderButton kind="questions" count={pending} onPress={onQuestions} />
  </View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12,
    paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#3dff6633' },
  button: { width: 40, height: 40, borderRadius: 4, borderWidth: 1, borderColor: Tokens.palette.line,
    backgroundColor: 'rgba(8,11,10,0.7)', alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -6, right: -5, height: 17, minWidth: 17, paddingHorizontal: 4,
    borderRadius: 999, overflow: 'hidden', textAlign: 'center', lineHeight: 17,
    backgroundColor: Tokens.palette.amber, color: Tokens.palette.ink, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 },
  identity: compactHeaderLayout.identity,
  identityMark: { flexShrink: 0 },
  nameBlock: compactHeaderLayout.copy,
  name: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 17, lineHeight: 19 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 3 },
  metaHitArea: { position: 'absolute', left: 0, right: 0, top: -16, bottom: -16 },
  lanes: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 0.5 },
  blocked: { color: Tokens.palette.amber, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9.5, letterSpacing: 0.5 },
});
