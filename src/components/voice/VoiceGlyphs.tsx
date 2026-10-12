import React from 'react';
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { Tokens } from '@/constants/Colors';

// Shared voice-mode glyphs from the design original (Claude Design project
// b5cb34c4, pentacle-proto-screens.jsx `MicGlyph`, `Spinner`, and the composer's
// record button). Geometry and timing are the mock's; see
// docs/chat_surface.md § Voice mode.
const G = Tokens.palette.green;
/** CSS `ease-out`, as the mock's keyframe animations use. */
export const CSS_EASE_OUT = Easing.bezier(0, 0, 0.58, 1);

export function MicGlyph({ color, size = 18, testID = 'voice-mic-glyph' }: { color: string; size?: number; testID?: string }) {
  return (
    <Svg testID={testID} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={9} y={3} width={6} height={11} rx={3} stroke={color} strokeWidth={2} />
      <Path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Small ✕ used by the recording strip and the pending voice row. */
export function DiscardGlyph({ size = 14, color = Tokens.palette.muted }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M6 6l12 12M18 6L6 18" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}

/** The mock's ring spinner: a faint track with a solid top arc, 0.9 s per turn. */
export function VoiceSpinner({ size = 9, color = Tokens.palette.muted, testID }: { size?: number; color?: string; testID?: string }) {
  const turn = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const anim = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    anim.start();
    return () => anim.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      testID={testID}
      style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 3, borderColor: `${color}25`, borderTopColor: color, transform: [{ rotate }] }}
    />
  );
}

/** Hard on/off blink (the mock's `steps(2)` 1 s cycle), shared by strip and pill. */
export function useStepBlink(): Animated.Value {
  const blink = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.delay(500),
        Animated.timing(blink, { toValue: 0.25, duration: 0, useNativeDriver: true }),
        Animated.delay(500),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [blink]);
  return blink;
}

export function PulseRing({ delay, testID }: { delay: number; testID: string }) {
  // 1.4 s ease-out cycle; a delayed ring stays invisible until its first cycle.
  const t = React.useRef(new Animated.Value(delay ? 1 : 0)).current;
  React.useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.timing(t, { toValue: 1, duration: 1400, easing: CSS_EASE_OUT, useNativeDriver: true }),
      ]),
    );
    const handle = setTimeout(() => anim.start(), delay);
    return () => { clearTimeout(handle); anim.stop(); };
  }, [delay, t]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      style={[
        styles.ring,
        {
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
        },
      ]}
    />
  );
}

/** Style of the mock's recording button: filled, round, green hairline. */
export function recordButtonStyle(size = 40): ViewStyle {
  return { width: size, height: size, borderRadius: size / 2, backgroundColor: G, borderWidth: 1, borderColor: G, alignItems: 'center', justifyContent: 'center' };
}

/**
 * Face of the composer's voice button. Idle it is the bare mic glyph that
 * replaces Send in the capsule corner; recording it is the mock's "Stop and
 * send" face: ink glyph with two staggered pulse rings (the caller's Pressable
 * carries `recordButtonStyle`).
 */
export function VoiceRecordFace({ recording, size = 40 }: { recording: boolean; size?: number }) {
  if (!recording) return <MicGlyph color={G} size={20} />;
  return (
    <>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <PulseRing delay={0} testID="voice-record-ring-0" />
        <PulseRing delay={700} testID="voice-record-ring-1" />
      </View>
      <MicGlyph color={Tokens.palette.ink} size={Math.round(size * 0.42)} />
    </>
  );
}

/** Header uses the original single ring; the bar retains two staggered rings. */
export function HeaderVoiceRecordFace({ recording }: { recording: boolean }) {
  const scale = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (!recording) { scale.setValue(1); return; }
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: 1.07, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    animation.start(); return () => animation.stop();
  }, [recording, scale]);
  return <Animated.View style={{ alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 17, backgroundColor: recording ? G : 'transparent', transform: [{ scale }] }}>
    {recording ? <PulseRing delay={0} testID="header-voice-pulse" /> : null}
    <MicGlyph color={recording ? Tokens.palette.ink : G} size={14} />
  </Animated.View>;
}
export function VoiceSendGlyph({ retry = false }: { retry?: boolean }) {
  return <Svg width={18} height={18} viewBox="0 0 24 24"><Path d={retry ? 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' : 'M21 3L3 11l7 2 2 7z'} fill="none" stroke={Tokens.palette.ink} strokeWidth={retry ? 2.4 : 2.2} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}
export function VoiceCheckGlyph() {
  return <Svg width={14} height={14} viewBox="0 0 24 24"><Path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke={G} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: G,
  },
});
