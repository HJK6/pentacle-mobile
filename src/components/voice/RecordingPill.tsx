import React from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';

import Bevel from '../Bevel';
import { Fonts, Tokens } from '@/constants/Colors';
import { formatDuration } from '../../services/voiceRecording';
import { useStepBlink } from './VoiceGlyphs';

// Cross-chat "Recording · m:ss · Return" pill: shown when the user navigates away
// from the chat where a take is recording (or after stop: "Sent · Return"). Tapping
// it returns to the originating chat. (§ Journey / Operator choices.) Not drawn in
// the design original; it uses the mock's voice language: beveled green-tinted
// chip, blinking record dot, mono tabular timer.
const R = Tokens.palette.green;
// Opaque ink + 8 % green (the mock's `${green}14` tint) so the floating chip
// reads the same over any screen it overlays.
const PILL_FILL = '#0c1e11';

export default function RecordingPill({
  durationS,
  onReturn,
  label = 'Recording',
  testID = 'voice-recording-pill',
}: {
  durationS: number;
  onReturn: () => void;
  label?: string;
  testID?: string;
}) {
  const blink = useStepBlink();
  const live = label === 'Recording';

  return (
    <Pressable testID={testID} accessibilityLabel={`${label}, return to chat`} onPress={onReturn} hitSlop={6}>
      <Bevel cut={8} fill={PILL_FILL} stroke={`${R}66`} contentStyle={styles.row}>
        <Animated.View style={[styles.dot, { opacity: live ? blink : 1 }]} />
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.sep}>·</Text>
        <Text testID={`${testID}-timer`} style={styles.timer}>{formatDuration(durationS)}</Text>
        <Text style={styles.sep}>·</Text>
        <Text style={styles.return}>Return ›</Text>
      </Bevel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 34,
    paddingHorizontal: 13,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: R },
  label: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11, color: R, letterSpacing: 1, textTransform: 'uppercase' },
  sep: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11, color: Tokens.palette.muted },
  timer: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    color: R,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  return: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11, color: Tokens.palette.text, letterSpacing: 1, textTransform: 'uppercase' },
});
