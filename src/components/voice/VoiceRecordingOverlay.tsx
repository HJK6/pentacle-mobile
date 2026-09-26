import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import RecordingPill from './RecordingPill';
import { voiceRecorder } from '../../services/voiceRecordingEngine';
import type { RecordingSnapshot } from '../../services/voiceRecording';
import { useVoiceDelivery, voiceDelivery } from '../../services/voiceDelivery';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import { Tokens } from '@/constants/Colors';

/** App-level control remains visible on lists/settings after the chat unmounts. */
export default function VoiceRecordingOverlay() {
  const [recording, setRecording] = useState<RecordingSnapshot | null>(() => voiceRecorder.snapshot());
  const delivery = useVoiceDelivery();
  const path = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useEffect(() => voiceRecorder.subscribe(setRecording), []);
  const take = recording || delivery.last;
  const atOrigin = take && decodeURIComponent(path) === `/pentacle/session/${take.streamId}`;
  useEffect(() => {
    if (!recording && atOrigin) voiceDelivery.clearLast();
  }, [recording, atOrigin]);
  if (!take || atOrigin) return null;
  return <View pointerEvents="box-none" style={[styles.overlay, { top: insets.top + 48 }]} testID="voice-recording-overlay">
    <RecordingPill durationS={take.durationS} label={recording ? recording.error ? 'Stop failed' : 'Recording' : delivery.last?.label} onReturn={() => { performChatOpenNavigation(take.streamId, router); }} />
    {recording ? <Pressable accessibilityLabel="Stop and send recording" testID="voice-overlay-stop" disabled={recording.status === 'stopping'} onPress={() => { void voiceRecorder.stop('tap').catch(() => Alert.alert('Pentacle', 'Could not stop recording.')); }} style={styles.stop}><Text style={styles.stopText}>Stop and send</Text></Pressable> : null}
  </View>;
}
const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 12, right: 12, alignItems: 'center', gap: 4 },
  stop: { padding: 8, borderRadius: 12, backgroundColor: Tokens.palette.green },
  stopText: { color: Tokens.palette.ink, fontSize: 12 },
});
