import React, { useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { outboxStore } from '../services/outboxStore';
import { discardPhotoOutbox, voiceTransportSnapshot } from '../services/pentacleStream';
import { VoiceControlButton } from './voice/VoiceTakeControls';

/** Reuse the retained-take Remove control and its cancel-first confirmation. */
export default function PhotoDiscardControl({ optimisticId }: { optimisticId: string }) {
  const snapshot = useSyncExternalStore(outboxStore.subscribe, outboxStore.snapshot);
  const entry = snapshot.entries.find(v => v.kind === 'photo' &&
    (v.frame.optimistic_id ?? v.frame.msg_id) === optimisticId);
  if (entry?.kind !== 'photo') return null;

  const current = () => outboxStore.scopeHash() === entry.scopeHash &&
    outboxStore.snapshot().entries.some(v => v.kind === 'photo' &&
      v.id === entry.id && v.operationId === entry.operationId);
  const remove = async (localOnly = false) => {
    if (!current()) return;
    try {
      if (!localOnly && entry.committed && !entry.mandateFailed && !voiceTransportSnapshot().ready) {
        confirm();
      } else if (!await discardPhotoOutbox(optimisticId, localOnly) && current()) {
        confirm();
      }
    } catch (error) {
      Alert.alert('Pentacle', error instanceof Error ? error.message : String(error));
    }
  };
  const confirm = () => Alert.alert('Remove local copy?', 'This message is already on the server and may still be sent.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Remove local copy', style: 'destructive', onPress: () => { void remove(true); } },
  ]);
  return <VoiceControlButton label="Remove local copy" testID="photo-discard" onPress={() => { void remove(); }}>Remove local copy</VoiceControlButton>;
}
