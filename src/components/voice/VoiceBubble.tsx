import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import Bevel from '../Bevel';
import { Fonts, Tokens } from '@/constants/Colors';
import { downsampleLevels, formatDuration } from '../../services/voiceRecording';

// The pending "TRANSCRIBING" voice bubble from the design original: a play glyph,
// the recorded metering downsampled to 30 bars, and the duration. Decoration only
// in this scope (no playback). Green-tinted beveled bubble matching the user row.
const BUBBLE_BARS = 30;
const BAR_AREA_H = 22;
const GREEN = Tokens.palette.green;

export default function VoiceBubble({
  levels,
  durationS,
  testID = 'voice-bubble',
}: {
  levels: number[];
  durationS: number;
  testID?: string;
}) {
  const bars = downsampleLevels(levels ?? [], BUBBLE_BARS);
  return (
    <View testID={testID} style={styles.wrap}>
      <Bevel cut={10} fill={`${GREEN}16`} stroke={`${GREEN}55`} contentStyle={styles.row}>
        <Svg width={12} height={12} viewBox="0 0 24 24">
          <Path d="M7 4l13 8-13 8z" fill={GREEN} />
        </Svg>
        <View style={styles.bars}>
          {bars.map((v, i) => (
            <View
              key={i}
              style={{
                width: 2.5,
                height: Math.max(2, Math.round(v * BAR_AREA_H)),
                backgroundColor: GREEN,
                opacity: 0.4 + v * 0.6,
                borderRadius: 2,
              }}
            />
          ))}
        </View>
        <Text testID={`${testID}-duration`} style={styles.duration}>
          {formatDuration(durationS)}
        </Text>
      </Bevel>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', maxWidth: '84%' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: BAR_AREA_H,
  },
  duration: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
    color: Tokens.palette.text,
    fontVariant: ['tabular-nums'],
  },
});
