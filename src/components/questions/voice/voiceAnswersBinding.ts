import { SegmentTracker, MAX_BOUND_ITEMS, type Segment } from './segments';

// `voice_answers.v1` (spec_pentacle_mobile__voice_answers_2026_10 § V2): the binding of one
// overlay recording to the durable questions it covers, carried as `meta.voice_answers` on the
// voice turn sent to the assistant thread. This module is the one place the wire shape lives.
export const VOICE_ANSWERS_VERSION = 1;

export type VoiceAnswersItem = {
  // The deck key `${notification id}:${item index}`.
  key: string;
  question_id: string;
  notification_id: string;
  // The asker: the canonical identity for authorization, acknowledgements and confirmation.
  producer_stream_id: string;
  // The chat the question was shown in (display only).
  surface_stream_id: string;
  prompt: string;
  segment: Segment;
};

/** Serializable process-owned question capture state. All offsets are captured
 * audio milliseconds; the take store persists this value without editing it. */
export type VoiceQuestionSessionSnapshot = {
  version: 1;
  eligibleItems: Array<Omit<VoiceAnswersItem, 'segment'>>;
  durableTotal: number;
  currentKey: string | null;
  liveKeys: string[];
  visits: Array<{ key: string; startMs: number; endMs: number | null }>;
  capturedAudioMs: number;
  phase: 'recording' | 'paused' | 'finalized';
};

export type VoiceAnswersMeta = {
  version: typeof VOICE_ANSWERS_VERSION;
  recording_id: string;
  blob_sha: string;
  duration_s: number;
  items: VoiceAnswersItem[];
};

export type VoiceAnswersStatus = {
  state: 'bound' | 'dropped';
  reason?: string;
  staleKeys: string[];
};

const MAX_REGISTERED = 32;
const bindings = new Map<string, VoiceAnswersItem[]>();
let carrierInstalled = false;
type QuestionSession = { recordingId: string; value: VoiceQuestionSessionSnapshot; tracker: SegmentTracker };
const sessions = new Map<string, QuestionSession>();
let activeQuestionId: string | null = null;
let sessionRevision = 0;
const sessionListeners = new Set<() => void>();
const completionListeners = new Set<(event: { recordingId: string; reason: 'sent' | 'discarded' | 'no_answers' }) => void>();
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function changed() { sessionRevision++; for (const fn of sessionListeners) fn(); }
export const subscribeVoiceQuestionSession = (fn: () => void) => { sessionListeners.add(fn); return () => { sessionListeners.delete(fn); }; };
export const voiceQuestionSessionRevision = () => sessionRevision;
export function subscribeVoiceQuestionCompletion(fn: (event: { recordingId: string; reason: 'sent' | 'discarded' | 'no_answers' }) => void) {
  completionListeners.add(fn); return () => { completionListeners.delete(fn); };
}
export function activeVoiceQuestionSession(): { recordingId: string; snapshot: VoiceQuestionSessionSnapshot } | null {
  const session = activeQuestionId ? sessions.get(activeQuestionId) : undefined;
  return session ? { recordingId: session.recordingId, snapshot: voiceQuestionSnapshot(session.recordingId)! } : null;
}
export function createVoiceQuestionSnapshot(items: Array<Omit<VoiceAnswersItem, 'segment'>>, durableTotal: number, currentKey: string | null, liveKeys: string[]): VoiceQuestionSessionSnapshot {
  return { version: 1, eligibleItems: copy(items), durableTotal, currentKey, liveKeys: liveKeys.slice(), visits: [], capturedAudioMs: 0, phase: 'recording' };
}
export function startVoiceQuestionSession(recordingId: string, value: VoiceQuestionSessionSnapshot) {
  const snapshot = copy(value);
  const tracker = new SegmentTracker(snapshot.eligibleItems.map(item => item.key), snapshot.visits);
  if (snapshot.phase === 'recording') tracker.enter(snapshot.currentKey, snapshot.capturedAudioMs);
  sessions.set(recordingId, { recordingId, value: snapshot, tracker });
  activeQuestionId = recordingId; changed();
}
export function refreshVoiceQuestionSession(recordingId: string) { if (sessions.has(recordingId)) changed(); }
export function voiceQuestionSnapshot(recordingId: string): VoiceQuestionSessionSnapshot | undefined {
  const s = sessions.get(recordingId);
  return s ? { ...copy(s.value), visits: s.tracker.snapshot() } : undefined;
}
export function updateVoiceQuestionCapture(recordingId: string, capturedAudioMs: number, phase: VoiceQuestionSessionSnapshot['phase']) {
  const s = sessions.get(recordingId); if (!s) return;
  const at = Math.max(0, Math.min(300000, Math.floor(capturedAudioMs)));
  if (phase !== 'recording') s.tracker.finish(at);
  else if (s.value.phase !== 'recording') s.tracker.enter(s.value.currentKey, at);
  s.value = { ...s.value, capturedAudioMs: at, phase }; changed();
}
export function updateVoiceQuestionPage(recordingId: string, currentKey: string | null, liveKeys: string[], capturedAudioMs: number) {
  const s = sessions.get(recordingId); if (!s || s.value.phase === 'finalized') return;
  const at = Math.max(s.value.capturedAudioMs, Math.min(300000, Math.floor(capturedAudioMs)));
  if (s.value.currentKey === currentKey && s.value.capturedAudioMs === at && s.value.liveKeys.length === liveKeys.length && s.value.liveKeys.every((key, i) => key === liveKeys[i])) return;
  if (s.value.phase === 'recording') s.tracker.enter(currentKey, at);
  s.value = { ...s.value, currentKey, liveKeys: liveKeys.slice(), capturedAudioMs: at }; changed();
}
export function updateVoiceQuestionLiveKeys(recordingId: string, liveKeys: string[]) {
  const s = sessions.get(recordingId); if (!s) return;
  s.value = { ...s.value, liveKeys: liveKeys.slice() }; changed();
}
export function coveredVoiceQuestionItems(recordingId: string, atMs?: number): VoiceAnswersItem[] {
  const s = sessions.get(recordingId); if (!s) return [];
  const live = new Set(s.value.liveKeys);
  const byKey = new Map(s.value.eligibleItems.map(item => [item.key, item]));
  return [...s.tracker.covered(atMs ?? s.value.capturedAudioMs)].flatMap(([key, segment]) => {
    const item = byKey.get(key); return item && live.has(key) ? [{ ...item, segment }] : [];
  });
}
export function freezeVoiceQuestionAnswers(recordingId: string, capturedAudioMs: number): VoiceAnswersItem[] | undefined {
  const s = sessions.get(recordingId); if (!s) return undefined;
  updateVoiceQuestionCapture(recordingId, capturedAudioMs, 'finalized');
  const items = coveredVoiceQuestionItems(recordingId, capturedAudioMs);
  registerVoiceAnswersBinding(recordingId, items); return items;
}
export function completeVoiceQuestionSession(recordingId: string, reason: 'sent' | 'discarded' | 'no_answers') {
  // Terminal callbacks may arrive after the active session was released at enqueue.
  if (reason !== 'sent') bindings.delete(recordingId);
  if (!sessions.has(recordingId)) return;
  sessions.delete(recordingId); if (activeQuestionId === recordingId) activeQuestionId = null;
  changed(); for (const fn of completionListeners) fn({ recordingId, reason });
}

/** Reject malformed persisted question state before recovery can dispatch it. */
export function validVoiceAnswersItems(value: unknown, capturedAudioMs: number): value is VoiceAnswersItem[] {
  if (!Array.isArray(value) || value.length > MAX_BOUND_ITEMS || !Number.isSafeInteger(capturedAudioMs) || capturedAudioMs < 0 || capturedAudioMs > 300000) return false;
  if (new Set(value.map(item => item?.key)).size !== value.length) return false;
  return value.every(raw => {
    if (!validQuestionItem(raw)) return false;
    const item = raw as VoiceAnswersItem;
    return item.segment && Number.isFinite(item.segment.start_s) && Number.isFinite(item.segment.end_s)
      && item.segment.start_s >= 0 && item.segment.end_s >= item.segment.start_s && item.segment.end_s <= capturedAudioMs / 1000;
  });
}
function validQuestionItem(item: unknown): item is Omit<VoiceAnswersItem, 'segment'> {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return ['key','question_id','notification_id','producer_stream_id','surface_stream_id','prompt'].every(key => typeof row[key] === 'string' && (key === 'prompt' || !!row[key]));
}
export function validVoiceQuestionSnapshot(value: unknown): value is VoiceQuestionSessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as VoiceQuestionSessionSnapshot;
  if (row.version !== 1 || !Array.isArray(row.eligibleItems) || !row.eligibleItems.every(validQuestionItem)
    || !Number.isSafeInteger(row.durableTotal) || row.durableTotal < row.eligibleItems.length
    || (row.currentKey !== null && typeof row.currentKey !== 'string') || !Array.isArray(row.liveKeys) || !row.liveKeys.every(key => typeof key === 'string')
    || !Number.isInteger(row.capturedAudioMs) || row.capturedAudioMs < 0 || row.capturedAudioMs > 300000
    || !['recording','paused','finalized'].includes(row.phase) || !Array.isArray(row.visits)
    || !row.visits.every(visit => !!visit && typeof visit === 'object')) return false;
  const keys = new Set(row.eligibleItems.map(item => item.key));
  return keys.size === row.eligibleItems.length && row.visits.filter(visit => visit.endMs === null).length <= (row.phase === 'recording' ? 1 : 0)
    && row.visits.every(visit => keys.has(visit.key) && Number.isFinite(visit.startMs) && visit.startMs >= 0 && visit.startMs <= row.capturedAudioMs
      && (visit.endMs === null || (Number.isFinite(visit.endMs) && visit.endMs >= visit.startMs && visit.endMs <= row.capturedAudioMs)));
}

const copyItem = (item: VoiceAnswersItem): VoiceAnswersItem => ({ ...item, segment: { ...item.segment } });

// Freezes the selected set for a recording. The overlay calls this before it stops the take; the
// voice send leg reads it by recording id when the transcript is ready.
export function registerVoiceAnswersBinding(recordingId: string, items: readonly VoiceAnswersItem[]) {
  if (items.length === 0) {
    bindings.delete(recordingId);
    return;
  }
  bindings.delete(recordingId);
  bindings.set(recordingId, items.map(copyItem));
  while (bindings.size > MAX_REGISTERED) bindings.delete(bindings.keys().next().value as string);
}

export function releaseVoiceAnswersBinding(recordingId: string) {
  bindings.delete(recordingId);
}

export function voiceAnswersItemCount(recordingId: string): number {
  return bindings.get(recordingId)?.length ?? 0;
}

// The `meta.voice_answers` for a recording, or null for a plain voice note. A pure read: every
// call for one recording yields the same value, so a pre-send re-run and a post-send resend carry
// the same binding identity (V3).
export function buildVoiceAnswersMeta(
  recordingId: string,
  { blobSha, durationS }: { blobSha: string; durationS: number },
): VoiceAnswersMeta | null {
  const items = bindings.get(recordingId);
  if (!items) return null;
  return {
    version: VOICE_ANSWERS_VERSION,
    recording_id: recordingId,
    blob_sha: blobSha,
    duration_s: durationS,
    items: items.map(copyItem),
  };
}

// The voice send leg declares it attaches `meta.voice_answers`; until it does, the overlay hides
// its mic rather than record answers that would be sent as a plain voice note.
export function installVoiceAnswersCarrier() {
  carrierInstalled = true;
}

export function isVoiceAnswersCarrierInstalled() {
  return carrierInstalled;
}

export function resetVoiceAnswersForTests() {
  bindings.clear();
  sessions.clear(); activeQuestionId = null; changed();
  carrierInstalled = false;
}

// `meta.voice_answers_status` as the daemon echoes it on the stored USER event of the turn.
export function parseVoiceAnswersStatus(meta: unknown): VoiceAnswersStatus | null {
  const raw = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).voice_answers_status : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const status = raw as Record<string, unknown>;
  if (status.state !== 'bound' && status.state !== 'dropped') return null;
  const staleKeys = Array.isArray(status.stale_keys) ? status.stale_keys.filter((key): key is string => typeof key === 'string') : [];
  return {
    state: status.state,
    ...(typeof status.reason === 'string' ? { reason: status.reason } : {}),
    staleKeys,
  };
}
