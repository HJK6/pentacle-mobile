import React from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { STATUS } from '@/constants/Colors';

// Single home for the SENDING status glyph. A continuous, gapless stream of
// chevrons flowing left→right on a 16×13 footprint (same height as the WORKING
// spinner), shown while a message is dispatching. Source asset:
// design_handoff_send_and_sending/sending-chevron-stream.svg — the design ships a
// SMIL <animateTransform> loop, reimplemented here with RN Animated because
// react-native-svg does not run SMIL.
//
// The strip holds chevrons one spacing (8) apart and translates by exactly one
// spacing per loop, so the reset is visually seamless. Recolor via `color`
// (defaults to the universal status green).
const SPACING = 8;
const FOOTPRINT_W = 16;
const FOOTPRINT_H = 13;
const STRIP_W = FOOTPRINT_W + 2 * SPACING;

export default function SendingIndicator({
  color = STATUS.working,
}: {
  color?: string;
  // `size` is accepted for call-site compatibility; the stream renders at its
  // fixed 16×13 footprint to match the working spinner.
  size?: number;
}) {
  const progress = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 550,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [progress]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-SPACING, 0],
  });

  return (
    <View
      testID="status-tag-sending-arrow"
      style={{ width: FOOTPRINT_W, height: FOOTPRINT_H, overflow: 'hidden' }}
    >
      <Animated.View style={{ width: STRIP_W, height: FOOTPRINT_H, transform: [{ translateX }] }}>
        <Svg width={STRIP_W} height={FOOTPRINT_H} viewBox={`0 0 ${STRIP_W} ${FOOTPRINT_H}`}>
          <G fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M0 3.5 L3 6.5 L0 9.5" />
            <Path d="M8 3.5 L11 6.5 L8 9.5" />
            <Path d="M16 3.5 L19 6.5 L16 9.5" />
            <Path d="M24 3.5 L27 6.5 L24 9.5" />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}
