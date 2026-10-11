import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import { formatDuration, type RecordingSnapshot } from '../../services/voiceRecording';
import { voiceRecorder, sendVoiceTake, discardVoiceTake } from '../../services/voiceRecordingEngine';
import { voiceDelivery, type VoiceTake } from '../../services/voiceDelivery';

const labels: Record<VoiceTake['status'], string> = {
  unsent: 'Unsent', queued: 'Queued', uploading: 'Uploading', transcribing: 'Transcribing', checking: 'Checking delivery',
  failed: 'Failed', auth_needed: 'Sign in required', origin_unavailable: 'Original chat unavailable', not_landed: 'Not delivered',
};
const run = (work: () => Promise<unknown>) => { void work().catch(error => Alert.alert('Pentacle', error instanceof Error ? error.message : 'Could not update the recording.')); };
export function VoiceControlButton({ label, children, onPress, disabled, testID }: { label: string; children: string; onPress(): void; disabled?: boolean; testID?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} testID={testID} style={[styles.button, disabled && styles.disabled]}><Text style={styles.action}>{children}</Text></Pressable>;
}
/** Pure projection; commands return to the single recorder/durable scheduler. */
export default function VoiceTakeControls({ recording, take, onReturn, storageError }: { recording?: RecordingSnapshot | null; take?: VoiceTake; onReturn(streamId: string): void; storageError?: string }) {
  const target = recording ?? take; if (!target) return null;
  const id = target.recordingId;
  const paused = recording?.status === 'paused';
  const busy = recording?.status === 'starting' || recording?.status === 'stopping';
  const unknown = !!take?.manifest.dispatchIntent && take.status !== 'not_landed';
  const title = recording?.originLabel || take?.draft?.originLabel || target.streamId;
  const label = recording ? recording.status === 'recording' ? 'Recording' : paused ? 'Paused' : recording.status === 'starting' ? 'Starting' : recording.status === 'stopping' ? 'Saving' : 'Unsent' : labels[take!.status];
  const error = recording?.error ?? take?.error ?? storageError;
  const discard = () => {
    if (take?.manifest.dispatchIntent) {
      Alert.alert('Remove local copy?', 'Remove local copy; delivery may already have happened', [
        { text: 'Keep', style: 'cancel' }, { text: 'Remove local copy', style: 'destructive', onPress: () => run(() => discardVoiceTake(id)) },
      ]);
    } else run(() => discardVoiceTake(id));
  };
  return <View style={styles.card} testID={`voice-take-controls-${id}`}>
    <View style={styles.heading}><Text numberOfLines={1} style={styles.origin}>{title}</Text><Text style={styles.state}>{label} · {formatDuration(target.durationS)}</Text></View>
    {take?.status === 'uploading' && take.manifest.audio ? <Text style={styles.detail}>{`${take.manifest.upload?.nextOffset ?? 0} / ${take.manifest.audio.bytes} bytes`}</Text> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <View style={styles.actions}>
      <VoiceControlButton label="Return to original chat" onPress={() => onReturn(target.streamId)}>Return</VoiceControlButton>
      {paused ? <VoiceControlButton label="Resume recording" disabled={recording?.pauseReason === 'origin'} onPress={() => run(() => voiceRecorder.resume())}>Resume</VoiceControlButton> : null}
      {recording || take?.status === 'unsent' ? <VoiceControlButton label="Send recording" testID="voice-overlay-stop" disabled={busy} onPress={() => run(() => sendVoiceTake(id))}>Send</VoiceControlButton>
        : unknown ? <VoiceControlButton label="Check recording delivery again" onPress={() => run(() => voiceDelivery.checkAgain(id))}>Check again</VoiceControlButton>
        : take && (['failed','auth_needed','origin_unavailable','not_landed'].includes(take.status) || !!storageError) ? <VoiceControlButton label="Retry recording delivery" onPress={() => run(() => voiceDelivery.retry(id))}>Retry</VoiceControlButton> : null}
      <VoiceControlButton label={take?.manifest.dispatchIntent ? 'Remove local recording copy' : 'Discard recording'} onPress={discard}>{take?.manifest.dispatchIntent ? 'Remove local copy' : 'Discard'}</VoiceControlButton>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: Tokens.palette.panel, borderColor: `${Tokens.palette.green}66`, borderWidth: 1, borderRadius: 4, paddingHorizontal: 10, paddingTop: 6 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  origin: { flex: 1, color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 14 },
  state: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10 },
  detail: { color: Tokens.palette.dim, fontSize: 11 }, error: { color: Tokens.palette.amber, fontSize: 12, marginTop: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' },
  button: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 9 },
  action: { color: Tokens.palette.green, fontFamily: Fonts.rajdhani.bold, fontSize: 14 }, disabled: { opacity: 0.45 },
});
