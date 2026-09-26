import React from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Fonts, Tokens } from '@/constants/Colors';
import { formatDuration } from '../../services/voiceRecording';

// The composer recording strip from the design original: a Discard X, a blinking
// dot, a tabular m:ss timer, and a live waveform of the last 46 metering bars
// filling from the right (height = level). Rendered in the recording tint while a
// take is active. `displayLevels` is the recorder's last-N level series.
const BAR_AREA_H = 26;
const R = Tokens.palette.green; // recording tint

export default function RecordingStrip({
  displayLevels,
  durationS,
  error,
  onDiscard,
  testID = 'voice-recording-strip',
}: {
  displayLevels: number[];
  durationS: number;
  error?: string;
  onDiscard: () => void;
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
    <View testID={testID} style={styles.strip}>
      <Pressable accessibilityLabel="Discard recording" testID={`${testID}-discard`} onPress={onDiscard} hitSlop={8}>
        <Svg width={14} height={14} viewBox="0 0 24 24">
          <Path d="M6 6l12 12M18 6L6 18" fill="none" stroke={Tokens.palette.muted} strokeWidth={2.4} strokeLinecap="round" />
        </Svg>
      </Pressable>
      <Animated.View style={[styles.dot, { opacity: blink }]} />
      <Text testID={`${testID}-timer`} style={styles.timer}>
        {formatDuration(durationS)}
      </Text>
      {error ? <Text style={styles.timer}>{error}</Text> : <View style={styles.bars}>
        {(displayLevels ?? []).map((v, i) => (
          <View
            key={i}
            style={{
              width: 2.5,
              height: Math.max(2, Math.round(v * BAR_AREA_H)),
              backgroundColor: R,
              opacity: 0.45 + v * 0.55,
              borderRadius: 2,
            }}
          />
        ))}
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flex: 1,
    minWidth: 0,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: `${R}66`,
    backgroundColor: `${R}0e`,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: R },
  timer: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
    color: R,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  bars: {
    flex: 1,
    minWidth: 0,
    height: BAR_AREA_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    overflow: 'hidden',
  },
});
