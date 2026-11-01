import { outboxStore } from './outboxStore';
import { useCallback, useState, useSyncExternalStore } from 'react';

// Durable scoped drafts. Revisions protect a newer edit/send (even an empty
// draft) from a late failed send restoring older text.
const drafts = new Map<string, { text: string; revision: number }>();
const listeners = new Set<() => void>();
export const draftRevision = (streamId: string) => drafts.get(streamId)?.revision ?? 0;
export function setDraft(streamId: string, value: string | ((text: string) => string)) {
  const text = typeof value === 'function' ? value(drafts.get(streamId)?.text ?? '') : value;
  drafts.set(streamId, { text, revision: draftRevision(streamId) + 1 });
  if (outboxStore.scopeHash()) void outboxStore.setDraft(streamId,text).catch(() => undefined);
  for (const listener of listeners) listener();
}
export function restoreDraft(streamId: string, revision: number, text: string) {
  if (draftRevision(streamId) === revision) setDraft(streamId, text);
}
let scope: string | null = null;
const hydrateDrafts = () => {
  const currentScope = outboxStore.scopeHash(), snapshot = outboxStore.snapshot();
  let changed = scope !== currentScope;
  if (changed) { drafts.clear(); scope = currentScope; }
  if (!snapshot.ready) { if (changed) for (const listener of listeners) listener(); return; }
  for (const [streamId,text] of Object.entries(snapshot.drafts)) if (!drafts.has(streamId)) {
    drafts.set(streamId,{text,revision:0}); changed = true;
  }
  if (changed) for (const listener of listeners) listener();
};
outboxStore.subscribe(hydrateDrafts);
hydrateDrafts();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useComposerDraft(streamId?: string) {
  const [local, setLocal] = useState('');
  const snapshot = useCallback(() => streamId ? drafts.get(streamId)?.text ?? '' : local, [streamId, local]);
  const text = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((value: string | ((current: string) => string)) => {
    if (streamId) setDraft(streamId, value);
    else setLocal(value);
  }, [streamId]);
  return [text, set] as const;
}
