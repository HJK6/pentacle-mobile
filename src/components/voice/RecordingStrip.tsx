import React from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { Fonts, Tokens } from '@/constants/Colors';
import { formatDuration } from '../../services/voiceRecording';
import { CSS_EASE_OUT, DiscardGlyph, useStepBlink } from './VoiceGlyphs';

// The composer recording strip from the design original: a Discard ✕, a blinking
// dot, a tabular m:ss timer, and a live waveform of the last 46 metering bars
// filling from the right (height = level, each new bar grows in). It renders as
// the content of the composer capsule, which itself takes the recording tint, so
// the strip has no frame of its own. `displayLevels` is the recorder's last-N
// level series and `sampleCount` the total samples so far (keys new bars).
const BAR_AREA_H = 26;
const R = Tokens.palette.green; // recording tint

function Bar({ level, testID }: { level: number; testID: string }) {
  const grow = React.useRef(new Animated.Value(0.2)).current;
  React.useEffect(() => {
    const anim = Animated.timing(grow, { toValue: 1, duration: 180, easing: CSS_EASE_OUT, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [grow]);
  return (
    <Animated.View
      testID={testID}
      style={{
        width: 2.5,
        height: Math.max(1, Math.round(level * BAR_AREA_H)),
        backgroundColor: R,
        opacity: 0.45 + level * 0.55,
        borderRadius: 2,
        transform: [{ scaleY: grow }],
      }}
    />
  );
}

export default function RecordingStrip({
  displayLevels,
  sampleCount,
  durationS,
  error,
  onDiscard,
  testID = 'voice-recording-strip',
}: {
  displayLevels: number[];
  sampleCount?: number;
  durationS: number;
  error?: string;
  onDiscard: () => void;
  testID?: string;
}) {
  const blink = useStepBlink();
  const levels = displayLevels ?? [];
  const first = Math.max(0, (sampleCount ?? levels.length) - levels.length);

  return (
    <View testID={testID} style={styles.strip}>
      <Pressable accessibilityLabel="Discard recording" testID={`${testID}-discard`} onPress={onDiscard} hitSlop={10}>
        <DiscardGlyph />
      </Pressable>
      <Animated.View style={[styles.dot, { opacity: blink }]} />
      <Text testID={`${testID}-timer`} style={styles.timer}>
        {formatDuration(durationS)}
      </Text>
      {error ? <Text numberOfLines={1} style={[styles.timer, styles.error]}>{error}</Text> : (
        <View style={styles.bars}>
          {levels.map((v, i) => <Bar key={first + i} level={v} testID={`${testID}-bar-${i}`} />)}
        </View>
      )}
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
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: R },
  timer: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
    color: R,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  error: { flex: 1, color: Tokens.palette.amber, letterSpacing: 0 },
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
