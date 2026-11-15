import { useEffect, useState } from 'react';
import type { VoiceTake } from './voiceDelivery';

/** A display budget, never evidence about whether the server delivered a send. */
export const VOICE_SEND_PROGRESS_MS = 130_000;
const failures = new Set(['failed', 'auth_needed', 'origin_unavailable', 'not_landed']);
export const voiceSendFailed = (take: VoiceTake) => failures.has(take.status);

// A user retry restarts the display budget so the message reads Sending again
// (operator, 2026-11-15). Presentation only: delivery state is never changed here.
const retriedAt = new Map<string, number>();
export function markVoiceSendRetry(recordingId: string, at = Date.now()) { retriedAt.set(recordingId, at); }
export function clearVoiceSendRetry(recordingId: string) { retriedAt.delete(recordingId); }
export function resetVoiceSendStatusForTests() { retriedAt.clear(); }

function deadline(take: VoiceTake) {
  if (take.status === 'unsent') return Infinity;
  const started = Math.max(
    typeof take.sendRequestedAt === 'number' && Number.isFinite(take.sendRequestedAt) ? take.sendRequestedAt : -Infinity,
    retriedAt.get(take.recordingId) ?? -Infinity,
  );
  return Number.isFinite(started) ? started + VOICE_SEND_PROGRESS_MS : Infinity;
}
function retrying(take: VoiceTake, now: number) {
  const at = retriedAt.get(take.recordingId);
  return at !== undefined && now < at + VOICE_SEND_PROGRESS_MS;
}
export function voiceSendNeedsAttention(take: VoiceTake, now: number) {
  // A retried lookup reads Sending until it proves absence or its budget runs out.
  const checking = take.status === 'checking' && (!retrying(take, now) || !!take.receiptAbsent);
  return voiceSendFailed(take) || checking || now >= deadline(take);
}

/** One wakeup at the next retained send's deadline; navigation never restarts its budget. */
export function useVoiceSendTime(takes: readonly VoiceTake[]) {
  const [, refresh] = useState(0);
  const now = Date.now();
  const next = takes.reduce((at, take) => {
    const end = deadline(take);
    return !voiceSendNeedsAttention(take, now) && end > now ? Math.min(at, end) : at;
  }, Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => refresh(value => value + 1), Math.max(1, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}
