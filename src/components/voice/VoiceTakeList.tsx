import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { VoiceTake } from '../../services/voiceDelivery';
import VoiceTakeControls from './VoiceTakeControls';
export default function VoiceTakeList({ takes, onReturn, storageError }: { takes: readonly VoiceTake[]; onReturn(streamId: string): void; storageError?: string }) {
  return <ScrollView testID="voice-take-list" style={styles.list} keyboardShouldPersistTaps="handled">
    {takes.map(take => <View key={take.recordingId} style={styles.row}><VoiceTakeControls take={take} onReturn={onReturn} storageError={storageError} /></View>)}
  </ScrollView>;
}
const styles = StyleSheet.create({ list: { maxHeight: 340 }, row: { marginTop: 6 } });
