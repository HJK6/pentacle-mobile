import { useEffect, useState } from 'react';
import type { VoiceTake } from './voiceDelivery';

/** A display budget, never evidence about whether the server delivered a send. */
export const VOICE_SEND_PROGRESS_MS = 130_000;
const failures = new Set(['failed', 'auth_needed', 'origin_unavailable', 'not_landed']);
export const voiceSendFailed = (take: VoiceTake) => failures.has(take.status);

function deadline(take: VoiceTake) {
  return take.status !== 'unsent' && typeof take.sendRequestedAt === 'number' && Number.isFinite(take.sendRequestedAt)
    ? take.sendRequestedAt + VOICE_SEND_PROGRESS_MS : Infinity;
}
export function voiceSendNeedsAttention(take: VoiceTake, now: number) {
  return voiceSendFailed(take) || take.status === 'checking' || now >= deadline(take);
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
