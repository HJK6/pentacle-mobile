import React, { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import { voiceDelivery, type VoiceTake } from '../../services/voiceDelivery';
import { discardVoiceTake, sendVoiceTake } from '../../services/voiceRecordingEngine';
import { formatDuration } from '../../services/voiceRecording';
import { clearVoiceSendRetry, markVoiceSendRetry, useVoiceSendTime, voiceSendNeedsAttention } from '../../services/voiceSendStatus';
import { SendFailedRow, SendingRow } from '../SendStatusRow';
import { discardRetainedVoiceTake, VoiceControlButton } from './VoiceTakeControls';
import VoiceBubble from './VoiceBubble';

/**
 * X on a failed voice message deletes its local copy at once (operator, 2026-11-15).
 * A server-owned send still gets a cancel attempt first so the server stops trying.
 */
export async function removeVoiceMessage(take: VoiceTake) {
  const id = take.recordingId;
  if (take.manifest.serverMandate && !take.manifest.serverMandateFailed) {
    if (require('../../services/pentacleStream').voiceTransportSnapshot().ready) {
      try { await discardVoiceTake(id); } catch { /* fall through to local removal */ }
    }
    if (!voiceDelivery.snapshot().takes.some(current => current.recordingId === id)) return;
    await discardVoiceTake(id, { removeLocalCopy: true });
  } else if (take.manifest.dispatchIntent) {
    await discardVoiceTake(id, { removeLocalCopy: true });
  } else {
    await discardVoiceTake(id);
  }
}

/** The voice bubble and its send row: the same Sending / Failed sending grammar as text. */
export default function VoiceMessageStatus({ take, answerCount = 0, accent }: { take: VoiceTake; answerCount?: number; accent?: string }) {
  const now = useVoiceSendTime([take]);
  const failed = take.status !== 'unsent' && voiceSendNeedsAttention(take, now);
  const serverOwned = !!take.manifest.serverMandate && !take.manifest.serverMandateFailed;
  const uncertain = take.status !== 'not_landed' && (!!take.manifest.dispatchIntent
    || serverOwned && ['server_owned', 'checking'].includes(take.status));
  const canReplay = uncertain && take.receiptAbsent && !serverOwned;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const run = async (work: () => Promise<unknown>, onError?: () => void) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await work(); }
    catch (error) { onError?.(); Alert.alert('Voice message', error instanceof Error ? error.message : 'Could not update the message.'); }
    finally { pending.current = false; setBusy(false); }
  };
  // One symbol, the safe command for the state: exact replay after proven absence,
  // lookup while delivery is unconfirmed or server-owned, otherwise a retry.
  const retry = () => {
    const id = take.recordingId;
    markVoiceSendRetry(id); refresh(value => value + 1);
    void run(() => canReplay ? voiceDelivery.sendAgain(id) : uncertain ? voiceDelivery.checkAgain(id) : voiceDelivery.retry(id),
      () => clearVoiceSendRetry(id));
  };
  const extras = [
    answerCount > 0 ? `ANSWERS ${answerCount} QUESTION${answerCount === 1 ? '' : 'S'}` : null,
    take.interrupted ? `INTERRUPTED AT ${formatDuration(take.durationS)}` : null,
  ].filter(Boolean) as string[];
  return <View testID="voice-transcription-status" style={styles.container}>
    {extras.length ? <View style={styles.caption}>{extras.map(text =>
      <Text key={text} testID={text.startsWith('ANSWERS') ? 'voice-answers-label' : undefined} style={styles.text}>{text}</Text>)}</View> : null}
    <VoiceBubble levels={take.levels} durationS={take.durationS} failed={failed} />
    {take.status === 'unsent' ? <View style={styles.actions}>
      <Text style={styles.text}>UNSENT</Text>
      <VoiceControlButton label="Send voice message" disabled={busy} onPress={() => { void run(() => sendVoiceTake(take.recordingId)); }}>Send</VoiceControlButton>
      <VoiceControlButton label="Discard voice message" testID="voice-transcription-discard" disabled={busy}
        onPress={() => discardRetainedVoiceTake(take)}>Discard</VoiceControlButton>
    </View>
      : failed ? <SendFailedRow testID="voice-send-failed" retryTestID="voice-send-retry" discardTestID="voice-send-discard"
        accent={accent} retryDisabled={busy} onRetry={retry} onDiscard={() => { void run(() => removeVoiceMessage(take)); }} />
      // Operator, 2026-11-15: "Uploading" while the audio uploads, then "Sending".
      : <SendingRow testID="voice-send-sending" label={take.status === 'uploading' ? 'Uploading' : 'Sending'} />}
  </View>;
}

const styles = StyleSheet.create({
  container: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '100%' },
  caption: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: 4 },
  text: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' },
});
