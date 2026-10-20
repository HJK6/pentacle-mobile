import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ProcessedAsset } from './imageCapture';

// Staged composer photos, keyed like composerDrafts: process lifetime only, so
// leaving and re-entering a chat keeps them but an app restart does not.
type Update = ProcessedAsset[] | ((current: ProcessedAsset[]) => ProcessedAsset[]);
const EMPTY: ProcessedAsset[] = [];
const staged = new Map<string, ProcessedAsset[]>();
const listeners = new Set<() => void>();
export function setStagedAttachments(streamId: string, value: Update) {
  const next = typeof value === 'function' ? value(staged.get(streamId) ?? EMPTY) : value;
  if (next.length) staged.set(streamId, next);
  else staged.delete(streamId);
  for (const listener of listeners) listener();
}
export function resetStagedAttachments() {
  staged.clear();
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useStagedAttachments(streamId?: string) {
  const [local, setLocal] = useState<ProcessedAsset[]>(EMPTY);
  const snapshot = useCallback(() => streamId ? staged.get(streamId) ?? EMPTY : local, [streamId, local]);
  const attachments = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Bound to the stream at call time: a pick or failed send that settles after
  // navigation still lands in the chat it started from.
  const set = useCallback((value: Update) => {
    if (streamId) setStagedAttachments(streamId, value);
    else setLocal(value);
  }, [streamId]);
  return [attachments, set] as const;
}
