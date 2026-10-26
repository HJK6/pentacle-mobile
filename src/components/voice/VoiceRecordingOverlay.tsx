import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOP_INSET, Tokens } from '../../../constants/Colors';
import { voiceRecorder } from '../../services/voiceRecordingEngine';
import { voiceDelivery } from '../../services/voiceDelivery';
import { voiceTakeStore } from '../../services/voiceTakeStore';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import { useVoiceOverlayHost, useVoicePresentation, useVoicePresentationState } from '../../services/voicePresentation';
import VoiceTakeControls, { VoiceControlButton } from './VoiceTakeControls';
import VoiceTakeList from './VoiceTakeList';
import GlobalVoiceBar from './GlobalVoiceBar';

export function useSharedVoiceControlsActive() { return useVoicePresentationState().host !== null; }
/** Only the highest covering native/route/root host exposes the floating bar or recovery controls.
 * Recovery controls start below the visible header: a covering surface's declared `top`, else the standard
 * header bottom (the same `max(inset, TOP_INSET) + 72` covering surfaces declare), so they never cover its controls. */
export default function VoiceRecordingOverlay({ visible = true, priority = 0, onReturn, hostName = 'root' }: { visible?: boolean; priority?: number; onReturn?: () => void; hostName?: string }) {
  const host = useVoiceOverlayHost(visible, priority, hostName);
  const value = useVoicePresentation();
  if (!visible || !host.selected || !value.lifecycle.foreground || !value.lifecycle.unlocked) return null;
  return <ActiveOverlay onReturn={onReturn} hostName={hostName} />;
}
function ActiveOverlay({ onReturn, hostName }: { onReturn?: () => void; hostName: string }) {
  const value = useVoicePresentation();
  const { capture, recording, delivery } = value;
  const [expanded, setExpanded] = useState(false);
  const router = useRouter(); const insets = useSafeAreaInsets();
  const takes = value.takes.filter(take => take.recordingId !== recording?.recordingId);
  const hiddenIds = new Set(delivery.takes.filter(take => !voiceRecorder.isOwnedByCurrentScope(take.recordingId)).map(take => take.recordingId));
  if (capture && !recording) hiddenIds.add(capture.recordingId);
  const heldCount = Math.max(delivery.heldCount, hiddenIds.size);
  const count = takes.length + (recording ? 1 : 0);
  const open = (streamId: string) => { onReturn?.(); performChatOpenNavigation(streamId, router as unknown as Parameters<typeof performChatOpenNavigation>[1]); };
  const removeHeld = () => Alert.alert('Discard held recordings?', 'This deletes the local recordings held for another signed-in account or server.', [
    { text: 'Keep', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void (async () => { if (capture && !recording) await voiceRecorder.discard(); await voiceDelivery.discardHeld(); })().catch(() => Alert.alert('Pentacle', 'Could not discard held recordings.')); } },
  ]);
  if (!count && !heldCount && !delivery.recoveryFailures.length && !delivery.storageError && !value.receipt) return null;
  const primary = value.take;
  const showRecovery = recording ? recording.status === 'paused' || recording.status === 'finalized' || !!recording.error || !!delivery.storageError : !!primary;
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="voice-recording-overlay" accessibilityLabel={`Recording controls, ${hostName}`}>
    {!value.anchored ? <GlobalVoiceBar onReturn={open} /> : null}
    <View pointerEvents="box-none" style={[styles.recovery, { top: value.surface?.top ?? Math.max(insets.top, TOP_INSET) + 72 }]}>
      {showRecovery && !value.suppressTakeProgress ? <VoiceTakeControls recording={recording} take={primary} onReturn={open} storageError={delivery.storageError} primaryControls={false} /> : null}
      {count > 1 || (!!value.receipt && count > 0) ? <View style={styles.switcher}><VoiceControlButton label={expanded ? 'Hide retained recordings' : 'Show retained recordings'} onPress={() => setExpanded(!expanded)}>{`${count} takes ${expanded ? '⌃' : '⌄'}`}</VoiceControlButton></View> : null}
      {expanded ? <VoiceTakeList takes={recording ? takes : takes.filter(take => take.recordingId !== primary?.recordingId)} onReturn={open} storageError={delivery.storageError} /> : null}
      {heldCount ? <View style={styles.notice}><Text style={styles.text}>{heldCount} held recording{heldCount === 1 ? '' : 's'}</Text><VoiceControlButton label="Discard held recordings" onPress={removeHeld}>Discard</VoiceControlButton></View> : null}
      {delivery.recoveryFailures.map(failure => <View style={styles.notice} key={failure.id}><Text style={styles.text}>Recording recovery failed</Text><VoiceControlButton label="Discard unrecoverable recording" onPress={() => { void voiceTakeStore.removeRecoveryFailure(failure.id).catch(() => Alert.alert('Pentacle', 'Could not discard the recording.')); }}>Discard</VoiceControlButton></View>)}
      {!count && delivery.storageError ? <View style={styles.notice}><Text style={styles.text}>{delivery.storageError}</Text><VoiceControlButton label="Retry loading recordings" onPress={() => { void voiceDelivery.initialize(); }}>Retry</VoiceControlButton></View> : null}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  recovery: { position: 'absolute', left: 12, right: 12, zIndex: 10000 },
  switcher: { backgroundColor: Tokens.palette.panel, alignItems: 'flex-end' },
  notice: { backgroundColor: Tokens.palette.panel, paddingLeft: 10, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, color: Tokens.palette.amber, fontSize: 12 },
});
