import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { Fonts, Tokens } from '../../../../constants/Colors';
import { useStepBlink, MicGlyph } from '../../voice/VoiceGlyphs';
import { formatDuration, type RecordingSnapshot } from '../../../services/voiceRecording';
import { voiceRecorder } from '../../../services/voiceRecordingEngine';

const GREEN = Tokens.palette.green;
const WAVE_BARS = 14;
const WAVE_H = 18;

function useRecorderSnapshot() {
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(() => voiceRecorder.snapshot());
  useEffect(() => voiceRecorder.subscribe(setSnapshot), []);
  return snapshot;
}

// The design's VoiceWave, driven by the recorder's metering instead of a canned animation.
export function VoiceWave({ levels }: { levels: readonly number[] }) {
  const recent = levels.slice(-WAVE_BARS);
  const padded = [...Array.from({ length: WAVE_BARS - recent.length }, () => 0), ...recent];
  return (
    <View testID="questions-voice-wave" style={styles.wave}>
      {padded.map((level, index) => (
        <View
          key={index}
          style={{ width: 3, height: Math.max(4, Math.round(level * WAVE_H)), borderRadius: 2, backgroundColor: GREEN, opacity: 0.35 + level * 0.55 }}
        />
      ))}
    </View>
  );
}

// The recording bar above the footer (README § 6): pulsing red dot, elapsed time, waveform,
// "k of n answered by voice" and a green Done. While the discard confirm is up it asks instead.
export default function VoiceAnswerBar({ k, n, confirming, finishing, onDone, onKeep, onDiscard }: {
  k: number;
  n: number;
  confirming: boolean;
  finishing: boolean;
  onDone: () => void;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const snapshot = useRecorderSnapshot();
  const blink = useStepBlink();
  if (confirming) {
    return (
      <View testID="questions-voice-confirm" style={styles.bar}>
        <Text style={styles.progress}>Discard this recording?</Text>
        <Pressable testID="questions-voice-keep" accessibilityRole="button" onPress={onKeep} style={styles.secondary}>
          <Text style={styles.secondaryText}>Keep</Text>
        </Pressable>
        <Pressable testID="questions-voice-discard" accessibilityRole="button" onPress={onDiscard} style={styles.danger}>
          <Text style={styles.dangerText}>Discard</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View testID="questions-voice-bar" style={styles.bar}>
      <Animated.View style={[styles.dot, { opacity: blink }]} />
      <Text testID="questions-voice-elapsed" style={styles.elapsed}>{formatDuration(snapshot?.durationS ?? 0)}</Text>
      <VoiceWave levels={snapshot?.displayLevels ?? []} />
      <Text testID="questions-voice-progress" numberOfLines={1} style={styles.progress}>{`${k} of ${n} answered by voice`}</Text>
      <Pressable
        testID="questions-voice-done"
        accessibilityRole="button"
        accessibilityState={{ disabled: finishing }}
        disabled={finishing}
        onPress={onDone}
        style={[styles.done, finishing && styles.disabled]}
      >
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </View>
  );
}

// The header mic: one recording for the whole overlay. While recording it stops like Done.
export function VoiceMicButton({ recording, onPress }: { recording: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID="questions-voice-mic"
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop voice mode' : 'Voice mode'}
      onPress={onPress}
      style={[styles.mic, recording && styles.micActive]}
    >
      <MicGlyph color={recording ? GREEN : Tokens.palette.dim} size={16} />
    </Pressable>
  );
}

// "RECORDING YOUR ANSWER…" / "ANSWER RECORDED" / "ANSWER BY TAP" under the current page.
export function VoicePageLabel({ state }: { state: 'recording' | 'recorded' | 'tap' }) {
  const recorded = state === 'recorded';
  const label = state === 'tap' ? 'ANSWER BY TAP' : recorded ? 'ANSWER RECORDED' : 'RECORDING YOUR ANSWER…';
  const color = recorded ? GREEN : Tokens.palette.dim;
  return (
    <View style={styles.pageLabel}>
      <MicGlyph color={color} size={11} />
      <Text testID="questions-voice-page-label" style={[styles.pageLabelText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: `${GREEN}55`, backgroundColor: `${GREEN}10`, borderRadius: 4, paddingVertical: 8, paddingLeft: 12, paddingRight: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Tokens.palette.red, flexShrink: 0 },
  elapsed: { color: Tokens.palette.text, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11, fontVariant: ['tabular-nums'], flexShrink: 0 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 2.5, height: WAVE_H, flexShrink: 0 },
  progress: { flex: 1, minWidth: 0, color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 12.5 },
  done: { backgroundColor: GREEN, borderWidth: 1, borderColor: GREEN, borderRadius: 4, paddingVertical: 5, paddingHorizontal: 9, flexShrink: 0 },
  disabled: { opacity: 0.6 },
  doneText: { color: Tokens.palette.ink, fontFamily: Fonts.rajdhani.bold, fontSize: 13 },
  secondary: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, paddingVertical: 5, paddingHorizontal: 9 },
  secondaryText: { color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.bold, fontSize: 13 },
  danger: { borderWidth: 1, borderColor: Tokens.palette.red, borderRadius: 4, paddingVertical: 5, paddingHorizontal: 9 },
  dangerText: { color: Tokens.palette.red, fontFamily: Fonts.rajdhani.bold, fontSize: 13 },
  mic: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: Tokens.palette.line, alignItems: 'center', justifyContent: 'center' },
  micActive: { borderColor: GREEN, backgroundColor: `${GREEN}22` },
  pageLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pageLabelText: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 9.5, letterSpacing: 1 },
});
