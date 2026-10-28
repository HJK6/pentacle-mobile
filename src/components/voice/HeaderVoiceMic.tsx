import React, { useSyncExternalStore } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Tokens } from '../../../constants/Colors';
import { selectAssistantIdentity } from '../../services/assistantIdentity';
import { PermissionDeniedError } from '../../services/voiceRecording';
import { getPentacleStreamState, subscribeVoiceTransport } from '../../services/pentacleStream';
import { pressVoiceHeader, useVoicePresentation, voiceHeaderStartReady } from '../../services/voicePresentation';
import { HeaderVoiceRecordFace } from './VoiceGlyphs';

const noSubscribe = () => () => {};
const notReady = () => false;

/** Every eligible product header controls the one process-owned recorder. */
export default function HeaderVoiceMic({ onPress, disabled = false, label, testID = 'header-voice-mic' }: {
  onPress?: () => void | Promise<void>; disabled?: boolean; label?: string; testID?: string;
}) {
  const value = useVoicePresentation();
  const eligible = value.lifecycle.foreground && value.lifecycle.unlocked;
  // A locked idle header must not arm a connection solely to paint its mic.
  useSyncExternalStore(eligible ? (subscribeVoiceTransport ?? noSubscribe) : noSubscribe,
    eligible ? voiceHeaderStartReady : notReady, notReady);
  const identity = selectAssistantIdentity({ sessions: getPentacleStreamState?.()?.sessions ?? [] });
  const active = !!value.recording;
  const recording = value.recording?.status === 'recording';
  const busy = value.headerBusy || value.recording?.status === 'starting' || value.recording?.status === 'stopping';
  const unavailable = !value.lifecycle.foreground || !value.lifecycle.unlocked || busy || (!active && (disabled || (!onPress && !voiceHeaderStartReady())));
  const press = () => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') require('../../utils/m1Diagnostic').m1Diagnostic('voice_press', { origin: 'header', test_id: testID });
    void pressVoiceHeader(onPress).catch(error => {
    if (error instanceof PermissionDeniedError) Alert.alert('Microphone permission is denied', 'Enable microphone access in Settings to record.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
    ]);
    else Alert.alert('Voice recording', error instanceof Error ? error.message : 'Could not record audio. Try again.');
  }); };
  return <Pressable accessibilityRole="button" accessibilityLabel={active ? recording ? 'Stop and send' : 'Send active recording' : label ?? `Talk to ${identity.name}`}
    accessibilityHint={!active && unavailable ? 'Recording is unavailable until this chat is ready and the app is unlocked' : undefined}
    accessibilityState={{ disabled: unavailable, busy }} disabled={unavailable} onPress={event => { event?.stopPropagation(); press(); }} testID={testID} style={styles.hit}>
    <View testID={`${testID}-face`} style={[styles.face, recording && styles.recording, unavailable && styles.disabled]}><HeaderVoiceRecordFace recording={recording} /></View>
  </Pressable>;
}
const styles = StyleSheet.create({
  hit: { minWidth: 44, minHeight: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  face: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: `${Tokens.palette.green}55`, backgroundColor: `${Tokens.palette.green}14`, alignItems: 'center', justifyContent: 'center' },
  recording: { borderColor: Tokens.palette.green, backgroundColor: Tokens.palette.green }, disabled: { opacity: 0.45 },
});
