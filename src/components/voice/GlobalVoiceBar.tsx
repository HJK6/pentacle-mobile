import React, { useMemo, useRef, useState } from 'react';
import { Alert, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, Tokens } from '../../../constants/Colors';
import { ASSISTANT_STREAM_ID } from '../../services/assistantIdentity';
import { clearVoiceReceipt, clampVoiceDy, setVoiceBarDy, useVoicePresentation, voiceKeyboardBottom } from '../../services/voicePresentation';
import { discardVoiceTake, sendVoiceTake } from '../../services/voiceRecordingEngine';
import { voiceDelivery } from '../../services/voiceDelivery';
import { formatDuration } from '../../services/voiceRecording';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import RecordingStrip from './RecordingStrip';
import { DiscardGlyph, MicGlyph, VoiceCheckGlyph, VoiceRecordFace, VoiceSendGlyph, VoiceSpinner } from './VoiceGlyphs';

const G = Tokens.palette.green;
const labels = { unsent: 'UNSENT', queued: 'QUEUED', uploading: 'UPLOADING…', transcribing: 'TRANSCRIBING…', checking: 'CHECKING DELIVERY', failed: 'DELIVERY FAILED', auth_needed: 'SIGN IN REQUIRED', origin_unavailable: 'ORIGINAL CHAT UNAVAILABLE', not_landed: 'NOT DELIVERED' };
const run = (work: () => Promise<unknown>) => { void work().catch(error => Alert.alert('Voice recording', error instanceof Error ? error.message : 'Could not update recording.')); };
/** Geometry-only projection. Capture, durable queue and dispatch remain their existing owners. */
export default function GlobalVoiceBar({ anchored = false, docked = false, surfaceId, onReturn, bottom, top }: {
  anchored?: boolean; docked?: boolean; surfaceId?: string; onReturn?: (streamId: string) => void; bottom?: number; top?: number;
}) {
  const value = useVoicePresentation();
  const { recording, take, receipt } = value;
  const insets = useSafeAreaInsets(); const dimensions = useWindowDimensions(); const router = useRouter();
  const [width, setWidth] = useState(Math.max(1, dimensions.width - 84));
  const id = recording?.recordingId ?? take?.recordingId ?? receipt?.recordingId ?? '';
  const defaultBottom = (value.host?.priority ?? 0) > 0 ? 24 : 64 + Math.max(insets.bottom, 22);
  const keyboardBottom = anchored ? 0 : voiceKeyboardBottom(value.keyboardFrame, dimensions.height);
  // Frame overlap already includes the home inset; take the max, never add it again.
  const base = Math.max(insets.bottom, bottom ?? value.surface?.bottom ?? defaultBottom, keyboardBottom);
  const minimum = Math.max(insets.bottom, value.surface?.bottom ?? defaultBottom, keyboardBottom);
  const bounds = { base, minBottom: minimum, top: top ?? value.surface?.top ?? insets.top + 76, height: dimensions.height };
  const dy = clampVoiceDy(value.recordingId === id ? value.dy : 0, bounds);
  const drag = useRef({ id, dy, bounds, origin: dy }); drag.current = { ...drag.current, id, dy, bounds };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 3 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderGrant: () => { drag.current.origin = drag.current.dy; },
    onPanResponderMove: (_event, gesture) => { const current = drag.current; setVoiceBarDy(current.id, clampVoiceDy(current.origin - gesture.dy, current.bounds)); },
    onPanResponderTerminationRequest: () => true,
  }), []);
  if (!value.visible || value.suppressBar || (anchored ? !value.anchored || value.surface?.id !== surfaceId : value.anchored)) return null;
  const target = recording ?? take;
  const isRecording = recording?.status === 'recording';
  const interrupted = recording?.status === 'paused';
  const failed = !!take && ['failed', 'auth_needed', 'origin_unavailable', 'not_landed'].includes(take.status);
  const dispatched = !!take?.manifest.dispatchIntent && take.status !== 'not_landed';
  const canSend = !!recording && !['starting','stopping'].includes(recording.status) || take?.status === 'unsent';
  const canRetry = failed && !dispatched;
  // In a chat the bar sits where the composer was, so a dispatched take keeps its own exits there.
  // Off-chat the overlay recovery card above the floating bar owns them.
  const canDiscard = !!target && (anchored || !take?.manifest.dispatchIntent);
  const checking = anchored && take?.status === 'checking' && !!take.manifest.dispatchIntent;
  const absent = checking && take.receiptAbsent;
  const discard = () => {
    if (take?.manifest.dispatchIntent) {
      Alert.alert('Remove local copy?', 'Remove local copy; delivery may already have happened', [
        { text: 'Keep', style: 'cancel' }, { text: 'Remove local copy', style: 'destructive', onPress: () => run(() => discardVoiceTake(id)) },
      ]);
    } else run(() => discardVoiceTake(id));
  };
  const connectionFailure = take?.status === 'failed' && /^(?:disconnected|not_connected|not connected|no connection|offline|network error)$/i.test(take.manifest.delivery?.error ?? take.error ?? '');
  const tone = interrupted ? Tokens.palette.amber : failed ? Tokens.palette.red : G;
  const fieldBorder = { borderColor: `${tone}66` };
  const originLabel = recording?.originLabel || take?.draft?.originLabel || receipt?.originLabel || '';
  const stateLabel = recording
    ? recording.status === 'starting' ? 'STARTING…' : recording.status === 'stopping' ? 'SAVING…' : interrupted ? `INTERRUPTED · ${formatDuration(recording.durationS)} KEPT` : `UNSENT · ${formatDuration(recording.durationS)} KEPT`
    : take ? `${connectionFailure ? 'NO CONNECTION' : absent ? 'NOT RECEIVED' : labels[take.status]}${failed || take.status === 'unsent' ? ` · ${formatDuration(take.durationS)} KEPT` : ''}` : `SENT TO ${originLabel.toUpperCase()}`;
  const busy = !!recording && ['starting','stopping'].includes(recording.status) || !!take && ['queued','uploading','transcribing','checking'].includes(take.status) && !absent;
  const open = (streamId: string) => { if (onReturn) onReturn(streamId); else performChatOpenNavigation(streamId, router as unknown as Parameters<typeof performChatOpenNavigation>[1]); };
  const content = isRecording ? <RecordingStrip displayLevels={recording.displayLevels} sampleCount={recording.levels.length} durationS={recording.durationS} onDiscard={() => {}} showDiscard={false}
    destinationLabel={recording.streamId !== ASSISTANT_STREAM_ID ? originLabel : undefined} testID="voice-recording-strip" />
    : <View style={styles.status}>{receipt && !target ? <VoiceCheckGlyph /> : busy ? <VoiceSpinner size={12} color={tone} /> : null}<Text numberOfLines={1} style={[styles.state, { color: tone }]}>{stateLabel}</Text></View>;
  return <View pointerEvents="box-none" testID="global-voice-bar" accessibilityLabel={anchored ? 'Voice recording in chat' : 'Floating voice recording'}
    style={[styles.bar, anchored ? styles.anchored : { position: 'absolute', left: 16, right: 16, bottom: base + dy }, docked && styles.docked]}>
    <View testID={anchored && !docked ? 'composer-capsule' : 'global-voice-field'} style={[styles.field, fieldBorder]} onLayout={event => setWidth(Math.max(1, event.nativeEvent.layout.width))}>
      <Svg pointerEvents="none" width={width} height={44} style={StyleSheet.absoluteFill}>
        <Path d={`M.5 .5H${width - 10}L${width - .5} 10V43.5H10L.5 34Z`} fill="#07100c" />
        <Path d={`M.5 .5H${width - 10}L${width - .5} 10V43.5H10L.5 34Z`} fill={`${tone}12`} stroke={fieldBorder.borderColor} strokeWidth={1} />
      </Svg>
      {canDiscard ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: false }} accessibilityLabel={take?.manifest.dispatchIntent ? 'Remove local copy' : 'Discard recording'} testID="voice-recording-strip-discard" onPress={discard} style={styles.discard}><DiscardGlyph /></Pressable> : null}
      <View {...(!anchored ? pan.panHandlers : {})} testID={!anchored ? 'voice-bar-drag-region' : undefined} style={styles.drag}>{content}</View>
      {receipt && !target && receipt.streamId === ASSISTANT_STREAM_ID ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: false }} accessibilityLabel="View sent recording" onPress={() => { clearVoiceReceipt(receipt.recordingId); open(ASSISTANT_STREAM_ID); }} style={styles.view}><Text style={styles.viewText}>View</Text></Pressable> : null}
    </View>
    {canSend || canRetry ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: false }} accessibilityLabel={isRecording ? 'Stop and send' : canRetry ? 'Retry recording delivery' : 'Send recording'}
      testID={anchored && !docked ? 'composer-mic-button' : 'global-voice-send'} onPress={() => run(() => canRetry ? voiceDelivery.retry(id) : sendVoiceTake(id))}
      style={[styles.circle, { borderColor: tone, backgroundColor: tone }]}>
      {isRecording ? <VoiceRecordFace recording size={44} /> : <VoiceSendGlyph retry={canRetry} />}
    </Pressable> : checking ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: false }}
      accessibilityLabel={absent ? 'Send again' : 'Check delivery again'} testID={absent ? 'voice-send-again' : 'voice-check-again'}
      onPress={() => run(() => absent ? voiceDelivery.sendAgain(id) : voiceDelivery.checkAgain(id))}
      style={[styles.circle, { borderColor: tone, backgroundColor: absent ? tone : `${tone}14` }]}>
      <VoiceSendGlyph retry />
    </Pressable> : docked ? null : <View style={[styles.circle, { borderColor: `${G}55`, backgroundColor: `${G}14` }]}><MicGlyph color={G} /></View>}
  </View>;
}
const styles = StyleSheet.create({
  bar: { zIndex: 10000, flexDirection: 'row', alignItems: 'center', gap: 8, shadowColor: '#000000', shadowOpacity: 0.65, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  anchored: { width: '100%', height: 44 },
  docked: { zIndex: 0, elevation: 0, shadowOpacity: 0 },
  field: { flex: 1, minWidth: 0, height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  drag: { flex: 1, minWidth: 0, height: 44, justifyContent: 'center' },
  discard: { minWidth: 44, minHeight: 44, marginHorizontal: -15, justifyContent: 'center', alignItems: 'center' },
  status: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  state: { flex: 1, minWidth: 0, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  circle: { width: 44, height: 44, minWidth: 44, minHeight: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  view: { minWidth: 44, minHeight: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center' },
  viewText: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 14 },
});
