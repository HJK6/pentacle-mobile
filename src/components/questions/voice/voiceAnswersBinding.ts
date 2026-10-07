import type { Segment } from './segments';

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
