import React from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { Fonts, Tokens } from '@/constants/Colors';
import { formatDuration } from '../../services/voiceRecording';

// Cross-chat "Recording · m:ss · Return" pill: shown when the user navigates away
// from the chat where a take is recording (or after stop: "Sent · Return"). Tapping
// it returns to the originating chat. (§ Journey / Operator choices.)
const R = Tokens.palette.green;

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
  const blink = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.25, duration: 500, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 500, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [blink]);

  return (
    <Pressable testID={testID} accessibilityLabel={`${label}, return to chat`} onPress={onReturn} style={styles.pill}>
      <Animated.View style={[styles.dot, { opacity: blink }]} />
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.sep}>·</Text>
      <Text testID={`${testID}-timer`} style={styles.timer}>{formatDuration(durationS)}</Text>
      <Text style={styles.sep}>·</Text>
      <Text style={styles.return}>Return</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: `${R}55`,
    backgroundColor: `${R}14`,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: R },
  label: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11, color: R, letterSpacing: 1 },
  sep: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11, color: Tokens.palette.muted },
  timer: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    color: R,
    fontVariant: ['tabular-nums'],
  },
  return: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11, color: Tokens.palette.text, letterSpacing: 1 },
});
