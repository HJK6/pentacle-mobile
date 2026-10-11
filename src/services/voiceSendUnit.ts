import { logTelemetry } from 'pentacle-chat-core';
import { transcribeBlob, type TranscribeBlobResult } from './pentacleStream';
import { MOBILE_TELEMETRY_EVENTS } from './mobileTelemetryEvents';
import { runVoiceUpload, type VoiceUploadArgs, type VoiceUploadStore } from './voiceUpload';
import type { VoiceOperation, VoiceTakeManifest } from './voiceTakeStore';

export interface VoiceRecordingAsset {
  /** Finished recording, durably owned until matching landed evidence or discard. */
  uri: string;
  mime: string;
  durationS: number;
  bytes?: number;
}
export interface VoiceUnitTelemetryTags { stream_id: string; recording_id: string }

/** Synthetic IO seam exercises the same acknowledged-upload contract as production. */
export interface VoiceUnitIO {
  upload(args: VoiceUploadArgs): Promise<{ blob_sha: string }>;
  transcribe(blobSha: string, mime: string, options: {
    requestId: string; voiceOperation: VoiceOperation; isCancelled?: () => boolean;
  }): Promise<TranscribeBlobResult>;
}
const defaultIO: VoiceUnitIO = { upload: runVoiceUpload, transcribe: transcribeBlob };
export interface VoiceUploadTranscribeResult { blobSha: string; transcript: TranscribeBlobResult }

const SAFE_ERROR_CODES = new Set([
  'invalid_request', 'upload_forbidden', 'upload_conflict', 'offset_mismatch', 'digest_mismatch',
  'upload_expired', 'upload_quota', 'upload_blob_disk_full', 'server_update_required',
  'invalid_upload_ack', 'audio_changed', 'audio_unavailable', 'voice_cancelled',
  'upload_failed', 'backend_unavailable', 'too_long', 'mime_unsupported', 'blob_unknown',
  'timeout', 'disconnected', 'auth_needed', 'not_connected', 'transcribe_failed',
]);
function lifecycle(take: VoiceTakeManifest, stage: 'upload' | 'transcribe', state: 'complete' | 'failed', error?: unknown) {
  const code = errorCodeOf(error);
  logTelemetry(MOBILE_TELEMETRY_EVENTS.VOICE_DELIVERY_LIFECYCLE as Parameters<typeof logTelemetry>[0], {
    subsystem: 'voice_delivery', bug_ref: 'continuous_voice', recording_id: take.recordingId,
    operation_id: take.recordingId, stage, state,
    ...(error === undefined ? {} : { error: code && SAFE_ERROR_CODES.has(code) ? code : `${stage}_failed` }),
  });
}

/**
 * Use only adopted immutable audio, durable upload completion and stable ASR identity.
 * Delivery owns transcript persistence and every subsequent send/receipt transition.
 */
export async function runVoiceUploadTranscribe(args: {
  recording: VoiceRecordingAsset;
  take: VoiceTakeManifest;
  store: VoiceUploadStore;
  transcribeRequestId?: string;
  tags: VoiceUnitTelemetryTags;
  io?: Partial<VoiceUnitIO>;
  isCancelled?: () => boolean;
  onStage?: (stage: 'uploading' | 'transcribing') => Promise<void>;
}): Promise<VoiceUploadTranscribeResult> {
  const { take, store } = args;
  const transcribeRequestId = `transcribe-${take.recordingId}`;
  const io = { ...defaultIO, ...args.io };
  const guard = () => {
    const current = store.get(take.recordingId);
    if (args.isCancelled?.() || !store.isCurrent(take.recordingId, take.epoch) || !current
        || current.scopeHash !== take.scopeHash) throw Object.assign(new Error('voice_cancelled'), { code: 'voice_cancelled' });
    if (!take.audio || JSON.stringify(current.audio) !== JSON.stringify(take.audio)) throw Object.assign(new Error('audio_changed'), { code: 'audio_changed' });
    return current;
  };
  let current = guard();
  if (args.transcribeRequestId && args.transcribeRequestId !== transcribeRequestId) throw Object.assign(new Error('invalid_transcribe_id'), { code: 'invalid_transcribe_id' });
  if (current.transcription && current.upload?.complete
      && current.transcription.requestId === transcribeRequestId
      && current.transcription.blobSha === take.audio!.sha256
      && current.upload.blobSha === take.audio!.sha256) {
    return { blobSha: current.transcription.blobSha, transcript: current.transcription.result };
  }
  let blobSha: string;
  try {
    if (!current.upload?.complete && args.onStage) { await args.onStage('uploading'); guard(); }
    const uploaded = await io.upload({ take, store, isCancelled: args.isCancelled });
    current = guard();
    blobSha = uploaded.blob_sha;
    if (blobSha !== take.audio!.sha256 || !current.upload?.complete || current.upload.blobSha !== blobSha) {
      throw Object.assign(new Error('invalid_upload_ack'), { code: 'invalid_upload_ack' });
    }
    lifecycle(take, 'upload', 'complete');
  } catch (error) {
    guard();
    if (errorCodeOf(error) !== 'voice_cancelled') lifecycle(take, 'upload', 'failed', error);
    throw error;
  }
  try {
    if (args.onStage) { await args.onStage('transcribing'); guard(); }
    const transcript = await io.transcribe(blobSha, take.audio!.mime, {
      requestId: transcribeRequestId,
      voiceOperation: take.operation,
      isCancelled: () => {
        try { guard(); return false; } catch { return true; }
      },
    });
    guard();
    lifecycle(take, 'transcribe', 'complete');
    return { blobSha, transcript };
  } catch (error) {
    guard();
    if (errorCodeOf(error) !== 'voice_cancelled') lifecycle(take, 'transcribe', 'failed', error);
    throw error;
  }
}

export function voiceTranscribeFailureMessage(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'server_update_required': return 'Server update required';
    case 'upload_failed': return 'Audio upload failed. Try again.';
    case 'backend_unavailable': return 'Transcription is unavailable right now. Try again in a moment.';
    case 'too_long': return 'That recording is too long to transcribe.';
    case 'mime_unsupported': return "That audio format can't be transcribed.";
    case 'blob_unknown': return 'The server needs the recording again. Your local recording is retained.';
    default: return 'Transcription failed. Try again.';
  }
}

/** An empty transcript remains actionable; it is never a proved send or discard. */
export function isEmptyTranscript(transcript: TranscribeBlobResult): boolean { return transcript.text.trim().length === 0; }
export const NOTHING_RECOGNIZED_MESSAGE = 'Nothing was recognized.';
function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
