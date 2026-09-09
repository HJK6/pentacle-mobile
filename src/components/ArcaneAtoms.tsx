import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Fonts, Tokens } from '@/constants/Colors';

type IconProps = {
  size?: number;
  color?: string;
};

export function Spark({ size = 12, color = Tokens.palette.green }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 1.5 L13.8 9.3 L21.5 11.1 L13.8 12.9 L12 20.7 L10.2 12.9 L2.5 11.1 L10.2 9.3 Z" fill={color} />
    </Svg>
  );
}

export function Brackets({ size = 12, color = Tokens.palette.green }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M9 7l-5 5 5 5"
        stroke={color}
        strokeWidth={2.2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M15 7l5 5-5 5"
        stroke={color}
        strokeWidth={2.2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function Spinner({
  size = 30,
  color = Tokens.palette.green,
  strokeWidth = 3,
  durationMs = 900,
  trackOpacity = 0.18,
  segmentFraction = 0.75,
}: IconProps & { strokeWidth?: number; durationMs?: number; trackOpacity?: number; segmentFraction?: number }) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [durationMs, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeOpacity={trackOpacity}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${circumference * segmentFraction} ${circumference * (1 - segmentFraction)}`}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

export function Bar({
  pct,
  color,
  style,
}: {
  pct: number;
  color: string;
  style?: StyleProp<ViewStyle>;
}) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <View style={[styles.barTrack, style]}>
      <View style={[styles.barFill, { width: `${width}%`, backgroundColor: color }]} />
    </View>
  );
}

export function Pill({
  children,
  color = Tokens.palette.green,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.pill, { borderColor: color, backgroundColor: `${color}12` }, style]}>
      {typeof children === 'string' ? <Text style={[styles.pillText, { color }]}>{children}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  barTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: Tokens.palette.codePanel,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 999,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pillText: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: Tokens.type.label,
    letterSpacing: 0.6,
  },
});
