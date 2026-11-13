import React, { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import { voiceDelivery, type VoiceTake } from '../../services/voiceDelivery';
import { sendVoiceTake } from '../../services/voiceRecordingEngine';
import { formatDuration } from '../../services/voiceRecording';
import { useVoiceSendTime, voiceSendFailed, voiceSendNeedsAttention } from '../../services/voiceSendStatus';
import { discardRetainedVoiceTake, VoiceControlButton } from './VoiceTakeControls';
import { VoiceSpinner } from './VoiceGlyphs';

const labels: Record<VoiceTake['status'], string> = {
  unsent: 'UNSENT', queued: 'QUEUED', uploading: 'UPLOADING', transcribing: 'TRANSCRIBING',
  server_owned: 'SENDING', checking: 'DELIVERY UNCONFIRMED', failed: 'DELIVERY FAILED',
  auth_needed: 'SIGN IN REQUIRED', origin_unavailable: 'ORIGINAL CHAT UNAVAILABLE', not_landed: 'NOT DELIVERED',
};

/** Every retained message owns its exits, independently of global overlay registration. */
export default function VoiceMessageStatus({ take, answerCount = 0 }: { take: VoiceTake; answerCount?: number }) {
  const now = useVoiceSendTime([take]);
  const attention = voiceSendNeedsAttention(take, now);
  const failed = voiceSendFailed(take);
  const serverOwned = !!take.manifest.serverMandate && !take.manifest.serverMandateFailed;
  const uncertain = take.status !== 'not_landed' && (!!take.manifest.dispatchIntent
    || serverOwned && ['server_owned', 'checking'].includes(take.status));
  const canReplay = uncertain && take.receiptAbsent && !serverOwned;
  const canRetry = failed && !uncertain;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await work(); }
    catch (error) { Alert.alert('Voice message', error instanceof Error ? error.message : 'Could not update the message.'); }
    finally { pending.current = false; setBusy(false); }
  };
  const label = take.error || (canReplay ? 'NOT RECEIVED' : attention && !failed ? 'DELIVERY UNCONFIRMED' : labels[take.status]);
  return <View testID="voice-transcription-status" style={styles.container}>
    <View style={styles.caption}>
      {!attention && take.status === 'transcribing' ? <VoiceSpinner testID="voice-transcribing-spinner" /> : null}
      <Text style={[styles.text, attention && styles.attention]}>{label}</Text>
      {answerCount > 0 ? <Text testID="voice-answers-label" style={styles.text}>{`ANSWERS ${answerCount} QUESTION${answerCount === 1 ? '' : 'S'}`}</Text> : null}
      {take.interrupted ? <Text style={styles.text}>· INTERRUPTED AT {formatDuration(take.durationS)}</Text> : null}
    </View>
    <View style={styles.actions}>
      {take.status === 'unsent' ? <VoiceControlButton label="Send voice message" disabled={busy} onPress={() => { void run(() => sendVoiceTake(take.recordingId)); }}>Send</VoiceControlButton>
        : uncertain ? <VoiceControlButton label={canReplay ? 'Send again' : 'Check delivery again'} disabled={busy}
          testID={canReplay ? 'voice-send-again' : 'voice-check-again'}
          onPress={() => { void run(() => canReplay ? voiceDelivery.sendAgain(take.recordingId) : voiceDelivery.checkAgain(take.recordingId)); }}>{canReplay ? 'Send again' : 'Check again'}</VoiceControlButton>
        : canRetry ? <VoiceControlButton label="Retry voice message" testID="voice-transcription-retry" disabled={busy}
          onPress={() => { void run(() => voiceDelivery.retry(take.recordingId)); }}>Retry</VoiceControlButton> : null}
      <VoiceControlButton label={uncertain ? 'Remove local copy' : 'Discard voice message'} testID="voice-transcription-discard" disabled={busy}
        onPress={() => discardRetainedVoiceTake(take)}>{uncertain ? 'Remove local copy' : 'Discard'}</VoiceControlButton>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { alignSelf: 'flex-end', maxWidth: '100%' },
  caption: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 6 },
  text: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10 },
  attention: { color: Tokens.palette.amber },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' },
});
