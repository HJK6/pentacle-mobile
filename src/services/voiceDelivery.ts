import { useSyncExternalStore } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { logTelemetry, TELEMETRY_EVENTS, type PentacleTranscriptItem } from 'pentacle-chat-core';
import { runVoiceUploadTranscribe, voiceTranscribeFailureMessage, NOTHING_RECOGNIZED_MESSAGE } from './voiceSendUnit';
import type { FinishedRecording } from './voiceRecording';
import * as stream from './pentacleStream';

export type VoiceTake = FinishedRecording & {
  status: 'transcribing' | 'failed';
  transcribeRequestId: string;
  createdAt: number;
  error?: string;
};
type DeliveryInput = { streamId: string; text: string; durationS: number; recordingId: string };
type DeliveryResult = { landed: boolean; optimisticId?: string; requestId?: string };
const voiceOrigins = new Map<string, Omit<DeliveryInput, 'text'>>();
interface VoiceDeliveryIO {
  transcribe: typeof runVoiceUploadTranscribe;
  deliver: (input: DeliveryInput) => Promise<DeliveryResult>;
  removeFile: (uri: string) => Promise<void>;
}
interface DeliverySnapshot {
  takes: VoiceTake[];
  last: { streamId: string; recordingId: string; durationS: number; label: string } | null;
}

// Process-owned delivery survives unmounts. A recording's captured stream ID is
// the only destination; a later composer selection never participates here.
export class VoiceDelivery {
  private state: DeliverySnapshot = { takes: [], last: null };
  private listeners = new Set<() => void>();
  private running = new Set<string>();
  constructor(private io: VoiceDeliveryIO) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(takes: VoiceTake[], last = this.state.last) {
    this.state = { takes, last };
    for (const listener of this.listeners) listener();
  }
  clearLast = () => { if (this.state.last) this.update(this.state.takes, null); };
  accept = async (recording: FinishedRecording) => {
    if (this.state.takes.some(t => t.recordingId === recording.recordingId) || this.running.has(recording.recordingId)) return;
    const take: VoiceTake = { ...recording, status: 'transcribing', createdAt: Date.now(), transcribeRequestId: `transcribe-${recording.recordingId}` };
    this.update([...this.state.takes, take], { ...recording, label: 'Transcribing' });
    await this.run(take);
  };
  retry = async (id: string) => {
    const take = this.state.takes.find(t => t.recordingId === id);
    if (!take || take.status !== 'failed' || this.running.has(id)) return;
    const retry = { ...take, status: 'transcribing' as const, error: undefined };
    this.update(this.state.takes.map(t => t === take ? retry : t));
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { stream_id: take.streamId, recording_id: id, duration_s: take.durationS, outcome: 'retried' });
    await this.run(retry);
  };
  discard = (id: string) => {
    const take = this.state.takes.find(t => t.recordingId === id);
    if (!take) return;
    this.update(this.state.takes.filter(t => t !== take), this.state.last?.recordingId === id ? null : this.state.last);
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_CANCELLED, { stream_id: take.streamId, recording_id: id, duration_s: take.durationS, request_id: take.transcribeRequestId });
    void this.io.removeFile(take.uri).catch(() => undefined);
  };
  private async run(take: VoiceTake) {
    const id = take.recordingId;
    this.running.add(id);
    let dispatched = false;
    try {
      const result = await this.io.transcribe({ recording: take, transcribeRequestId: take.transcribeRequestId, tags: { stream_id: take.streamId, recording_id: id }, isCancelled: () => !this.state.takes.some(t => t.recordingId === id) });
      if (!this.state.takes.some(t => t.recordingId === id)) return;
      const text = result.transcript.text.trim();
      if (!text) throw new Error(NOTHING_RECOGNIZED_MESSAGE);
      // No async gap between the cancellation guard and text dispatch. deliver
      // synchronously inserts the text optimistic row before yielding.
      const delivery = this.io.deliver({ streamId: take.streamId, text, durationS: take.durationS, recordingId: id });
      dispatched = true;
      this.update(this.state.takes.filter(t => t.recordingId !== id), { ...take, label: 'Sending' });
      void this.io.removeFile(take.uri).catch(() => undefined);
      const { landed, optimisticId, requestId } = await delivery;
      this.update(this.state.takes, this.state.last?.recordingId === id ? { ...take, label: landed ? 'Sent' : 'Sending' } : this.state.last);
      if (landed) logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { stream_id: take.streamId, recording_id: id, duration_s: take.durationS, optimistic_id: optimisticId, request_id: requestId, outcome: 'landed' });
    } catch (error) {
      if (!dispatched && !this.state.takes.some(t => t.recordingId === id)) return;
      if (!dispatched) {
        const message = error instanceof Error && error.message === NOTHING_RECOGNIZED_MESSAGE ? NOTHING_RECOGNIZED_MESSAGE : voiceTranscribeFailureMessage(error);
        this.update(this.state.takes.map(t => t.recordingId === id ? { ...t, status: 'failed', error: message } : t), this.state.last?.recordingId === id ? { ...take, label: 'Failed' } : this.state.last);
      } else {
        this.update(this.state.takes, this.state.last?.recordingId === id ? { ...take, label: 'Failed' } : this.state.last);
      }
      logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { stream_id: take.streamId, recording_id: id, duration_s: take.durationS, outcome: 'failed' });
    } finally { this.running.delete(id); }
  }
}

export const voiceDelivery = new VoiceDelivery({
  transcribe: runVoiceUploadTranscribe,
  removeFile: uri => FileSystem.deleteAsync(uri, { idempotent: true }),
  deliver: ({ streamId, text, durationS, recordingId }) => {
    const session = stream.getPentacleStreamState().sessions.find(s => s.stream_id === streamId);
    if (!session) throw new Error('Originating chat is unavailable');
    const optimisticId = stream.appendOptimisticUserMessage(streamId, text);
    if (!optimisticId) throw new Error('Could not prepare voice message');
    voiceOrigins.set(optimisticId, { streamId, durationS, recordingId });
    const requestId = stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.request_id;
    return stream.sendPentacleMessage({ host: session.host, sessionName: session.session_name, text, optimisticId, meta: { voice: { duration_s: durationS } } }).then(landed => ({ landed, optimisticId, requestId })).catch(error => {
      // Existing reconnect/receipt reconciliation owns ambiguous sends. Never
      // run transcription again after any text frame may have left the phone.
      if (error instanceof Error && /Pentacle stream (?:disconnected|is not connected)|Pentacle command timed out/.test(error.message)) return { landed: false, optimisticId, requestId };
      stream.markOptimisticFailed(optimisticId, error instanceof Error ? error.message : 'send_error');
      throw error;
    });
  },
});
export function useVoiceDelivery() {
  return useSyncExternalStore(voiceDelivery.subscribe, voiceDelivery.snapshot, voiceDelivery.snapshot);
}
export function voiceTakeRow(take: VoiceTake): PentacleTranscriptItem {
  return {
    id: `voice:${take.recordingId}`, timestampLabel: new Date(take.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), label: 'You', tone: 'user', provider: '', source: 'voice', text: '', kind: 'USER', isUser: true, eventCase: 'USER', displayRule: 'bubble:user', voice: { duration_s: take.durationS },
  };
}

/** Send retries after transcription reuse the text send, never the deleted audio. */
export async function retryVoiceMessage(id: string, retry: (id: string) => Promise<boolean>) {
  const origin = voiceOrigins.get(id);
  if (!origin) return retry(id);
  const tags = { stream_id: origin.streamId, recording_id: origin.recordingId, duration_s: origin.durationS, optimistic_id: id };
  logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { ...tags, outcome: 'retried' });
  try {
    const landed = await retry(id);
    if (landed) logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { ...tags, outcome: 'landed' });
    return landed;
  } catch (error) {
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME, { ...tags, outcome: 'failed' });
    throw error;
  }
}
