import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Fonts, Tokens } from '@/constants/Colors';
import ArcaneRingFrame from '../ArcaneRingFrame';
import { AssistantIcon, type AssistantIdentity } from './assistantIdentity';
import StatusTag from '../StatusTag';

type Props = {
  identity: AssistantIdentity; others: number; pending: number; lanes: number; working: boolean; top: number;
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
    {count > 0 ? <Text testID={`bart-${kind}-badge`} style={styles.badge}>{count}</Text> : null}
  </Pressable>;
}

export default function BartHeader({ identity, others, pending, lanes, working, top, onDrawer, onStatus, onQuestions }: Props) {
  return <View testID="bart-header" style={[styles.header, { paddingTop: Math.max(top, 52) }]}>
    <HeaderButton kind="sessions" count={others} onPress={onDrawer} />
    <Pressable accessibilityRole="button" accessibilityLabel={`${identity.assistantName} status, ${lanes} open lanes`}
      onPress={onStatus} style={styles.identity}>
      <ArcaneRingFrame size={38} color={identity.icon.color} identity>
        <AssistantIcon identity={identity} size={38 * 0.64} />
      </ArcaneRingFrame>
      <View style={styles.nameBlock}>
        <Text style={styles.name} numberOfLines={1}>{identity.assistantName}</Text>
        <View style={styles.meta}>
          <StatusTag status={working ? 'working' : 'idle'} />
          <Text style={styles.lanes}>{lanes} LANES</Text>
        </View>
      </View>
    </Pressable>
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
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 },
  nameBlock: { flex: 1, minWidth: 0 },
  name: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 17, lineHeight: 19 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 3 },
  lanes: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 0.5 },
});
