import React, { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tokens } from '../../../constants/Colors';
import { voiceRecorder, voiceLifecycleSnapshot, subscribeVoiceLifecycle } from '../../services/voiceRecordingEngine';
import type { RecordingSnapshot } from '../../services/voiceRecording';
import { useVoiceDelivery, voiceDelivery } from '../../services/voiceDelivery';
import { voiceTakeStore } from '../../services/voiceTakeStore';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import VoiceTakeControls, { VoiceControlButton } from './VoiceTakeControls';
import VoiceTakeList from './VoiceTakeList';

const hosts = new Map<string, { priority: number; sequence: number }>();
const hostListeners = new Set<() => void>();
let sequence = 0;
let activeHost: string | null = null;
const subscribeHosts = (fn: () => void) => { hostListeners.add(fn); return () => { hostListeners.delete(fn); }; };
const hostSnapshot = () => activeHost;
function projectHosts() {
  activeHost = [...hosts].sort(([, a], [, b]) => b.priority - a.priority || b.sequence - a.sequence)[0]?.[0] ?? null;
  for (const fn of hostListeners) fn();
}
export function useSharedVoiceControlsActive() { return useSyncExternalStore(subscribeHosts, hostSnapshot, hostSnapshot) !== null; }

/** The only accessible copy is the highest covering native/route/root host. */
export default function VoiceRecordingOverlay({ visible = true, priority = 0, onReturn, hostName = 'root' }: { visible?: boolean; priority?: number; onReturn?: () => void; hostName?: string }) {
  const id = useId();
  const selected = useSyncExternalStore(subscribeHosts, hostSnapshot, hostSnapshot);
  const lifecycle = useSyncExternalStore(subscribeVoiceLifecycle, voiceLifecycleSnapshot, voiceLifecycleSnapshot);
  useEffect(() => {
    if (!visible) return;
    hosts.set(id, { priority, sequence: ++sequence }); projectHosts();
    return () => { hosts.delete(id); projectHosts(); };
  }, [visible, priority, id]);
  if (!visible || selected !== id || !lifecycle.foreground || !lifecycle.unlocked) return null;
  return <ActiveOverlay onReturn={onReturn} hostName={hostName} />;
}
function ActiveOverlay({ onReturn, hostName }: { onReturn?: () => void; hostName: string }) {
  const [capture, setRecording] = useState<RecordingSnapshot | null>(() => voiceRecorder.snapshot());
  const [expanded, setExpanded] = useState(false);
  const delivery = useVoiceDelivery();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useEffect(() => voiceRecorder.subscribe(setRecording), []);
  const recording = capture && voiceTakeStore.get(capture.recordingId) && voiceRecorder.isOwnedByCurrentScope(capture.recordingId) ? capture : null;
  const visibleTakes = delivery.takes.filter(take => voiceRecorder.isOwnedByCurrentScope(take.recordingId));
  const takes = visibleTakes.filter(take => take.recordingId !== recording?.recordingId);
  const hiddenIds = new Set(delivery.takes.filter(take => !voiceRecorder.isOwnedByCurrentScope(take.recordingId)).map(take => take.recordingId));
  if (capture && !recording) hiddenIds.add(capture.recordingId);
  const heldCount = Math.max(delivery.heldCount, hiddenIds.size);
  const count = takes.length + (recording ? 1 : 0);
  const open = (streamId: string) => { onReturn?.(); performChatOpenNavigation(streamId, router); };
  const removeHeld = () => Alert.alert('Discard held recordings?', 'This deletes the local recordings held for another signed-in account or server.', [
    { text: 'Keep', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void (async () => { if (capture && !recording) await voiceRecorder.discard(); await voiceDelivery.discardHeld(); })().catch(() => Alert.alert('Pentacle', 'Could not discard held recordings.')); } },
  ]);
  if (!count && !heldCount && !delivery.recoveryFailures.length && !delivery.storageError) return null;
  return <View pointerEvents="box-none" style={[styles.overlay, { top: insets.top + 48 }]} testID="voice-recording-overlay" accessibilityLabel={`Recording controls, ${hostName}`}>
    {recording ? <VoiceTakeControls recording={recording} onReturn={open} storageError={delivery.storageError} />
      : takes[0] ? <VoiceTakeControls take={takes[0]} onReturn={open} storageError={delivery.storageError} /> : null}
    {count > 1 ? <View style={styles.switcher}><VoiceControlButton label={expanded ? 'Hide retained recordings' : 'Show retained recordings'} onPress={() => setExpanded(!expanded)}>{`${count} takes ${expanded ? '⌃' : '⌄'}`}</VoiceControlButton></View> : null}
    {expanded ? <VoiceTakeList takes={recording ? takes : takes.slice(1)} onReturn={open} storageError={delivery.storageError} /> : null}
    {heldCount ? <View style={styles.notice}><Text style={styles.text}>{heldCount} held recording{heldCount === 1 ? '' : 's'}</Text><VoiceControlButton label="Discard held recordings" onPress={removeHeld}>Discard</VoiceControlButton></View> : null}
    {delivery.recoveryFailures.map(failure => <View style={styles.notice} key={failure.id}><Text style={styles.text}>Recording recovery failed</Text><VoiceControlButton label="Discard unrecoverable recording" onPress={() => { void voiceTakeStore.removeRecoveryFailure(failure.id).catch(() => Alert.alert('Pentacle', 'Could not discard the recording.')); }}>Discard</VoiceControlButton></View>)}
    {!count && delivery.storageError ? <View style={styles.notice}><Text style={styles.text}>{delivery.storageError}</Text><VoiceControlButton label="Retry loading recordings" onPress={() => { void voiceDelivery.initialize(); }}>Retry</VoiceControlButton></View> : null}
  </View>;
}
const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 12, right: 12, zIndex: 10000 },
  switcher: { backgroundColor: Tokens.palette.panel, alignItems: 'flex-end' },
  notice: { backgroundColor: Tokens.palette.panel, paddingLeft: 10, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, color: Tokens.palette.amber, fontSize: 12 },
});
