import { logTelemetry, TELEMETRY_EVENTS } from 'pentacle-chat-core';

import { readAttachmentBase64 } from './attachmentUpload';
import { uploadBlobBase64, transcribeBlob, type TranscribeBlobResult } from './pentacleStream';

// Voice send is a THREE-leg optimistic unit: upload (the recorded audio blob) →
// transcribe (daemon, fleet vocabulary) → send (the transcript as ordinary
// text). Like the photo upload+send unit it has a definite terminal outcome:
// each leg either advances or fails visibly with Retry. The upload and
// transcribe legs run before any `send` is dispatched, so a rejection here can
// never be "kept pending" — the row fails and Retry re-drives the whole unit
// from the RETAINED local recording file (no re-record). The transcribe leg is
// idempotent: it reuses ONE stable request_id, and the blob is content-addressed,
// so a socket-generation retry never yields a second transcript or a second send.
// (spec_pentacle_mobile__voice_input_thoth_transcription_2026_09 § Journey.)

export interface VoiceRecordingAsset {
  /** Local file uri of the finished recording (retained until sent/discarded). */
  uri: string;
  /** Container mime the daemon verb accepts: audio/mp4 (M4A) or audio/wav. */
  mime: string;
  /** Whole/fractional seconds of captured audio; carried as meta.voice. */
  durationS: number;
  /** File size in bytes, if known (upload size hint). */
  bytes?: number;
}

export interface VoiceUnitTelemetryTags {
  stream_id: string;
  recording_id: string;
}

// Injectable IO so the unit is testable without a device, a socket, or the
// filesystem (harness invariance: the subject is the leg orchestration).
export interface VoiceUnitIO {
  readBase64: (uri: string) => Promise<string>;
  upload: (dataBase64: string, sizeHintBytes?: number) => Promise<{ blob_sha: string }>;
  transcribe: (
    blobSha: string,
    mime: string,
    options: { requestId: string },
  ) => Promise<TranscribeBlobResult>;
}

const defaultIO: VoiceUnitIO = {
  readBase64: readAttachmentBase64,
  upload: uploadBlobBase64,
  transcribe: transcribeBlob,
};

export interface VoiceUploadTranscribeResult {
  blobSha: string;
  transcript: TranscribeBlobResult;
}

/**
 * Run the upload + transcribe legs for one voice take and return the transcript.
 * The caller then delivers `transcript.text` through the existing text `send`
 * path (with meta.voice={duration_s}). Emits the tagged chat.voice.* telemetry
 * for each leg. Rejects (with the leg's error) on failure so the caller fails
 * the pending row visibly; `transcribeRequestId` must be stable across retries.
 */
export async function runVoiceUploadTranscribe(args: {
  recording: VoiceRecordingAsset;
  transcribeRequestId: string;
  tags: VoiceUnitTelemetryTags;
  io?: Partial<VoiceUnitIO>;
  isCancelled?: () => boolean;
}): Promise<VoiceUploadTranscribeResult> {
  const { recording, transcribeRequestId, tags } = args;
  const guardCancellation = () => {
    if (args.isCancelled?.()) throw Object.assign(new Error('voice_cancelled'), { code: 'voice_cancelled' });
  };
  const io: VoiceUnitIO = { ...defaultIO, ...args.io };
  const baseTags = {
    stream_id: tags.stream_id,
    recording_id: tags.recording_id,
    duration_s: recording.durationS,
  };

  // -- upload leg --
  let blobSha: string;
  try {
    const dataBase64 = await io.readBase64(recording.uri);
    guardCancellation();
    const uploaded = await io.upload(dataBase64, recording.bytes);
    guardCancellation();
    blobSha = uploaded.blob_sha;
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_UPLOAD_OK, { ...baseTags, blob_sha: blobSha });
  } catch (error) {
    if (errorCodeOf(error) === 'voice_cancelled') throw error;
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_UPLOAD_FAILED, {
      ...baseTags,
      error_code: errorCodeOf(error) ?? 'upload_error',
    });
    throw Object.assign(new Error(error instanceof Error ? error.message : 'upload_failed'), { code: 'upload_failed', cause: error });
  }

  // -- transcribe leg (idempotent on the stable request_id) --
  try {
    const transcript = await io.transcribe(blobSha, recording.mime, {
      requestId: transcribeRequestId,
    });
    guardCancellation();
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_OK, {
      ...baseTags,
      blob_sha: blobSha,
      request_id: transcribeRequestId,
      model: transcript.model,
      vocabulary_version: transcript.vocabulary_version,
    });
    return { blobSha, transcript };
  } catch (error) {
    if (errorCodeOf(error) === 'voice_cancelled') throw error;
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_FAILED, {
      ...baseTags,
      blob_sha: blobSha,
      request_id: transcribeRequestId,
      error_code: errorCodeOf(error) ?? 'transcribe_failed',
    });
    throw error;
  }
}

/** Map a daemon transcribe error_code to a distinct, user-facing message. */
export function voiceTranscribeFailureMessage(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'upload_failed':
      return 'Audio upload failed. Try again.';
    case 'backend_unavailable':
      return 'Transcription is unavailable right now. Try again in a moment.';
    case 'too_long':
      return 'That recording is too long to transcribe.';
    case 'mime_unsupported':
      return "That audio format can't be transcribed.";
    case 'blob_unknown':
      return 'The recording was lost before it could be transcribed.';
    default:
      return 'Transcription failed. Try again.';
  }
}

/** An empty transcript is a distinct, non-error terminal state (nothing said). */
export function isEmptyTranscript(transcript: TranscribeBlobResult): boolean {
  return transcript.text.trim().length === 0;
}

export const NOTHING_RECOGNIZED_MESSAGE = 'Nothing was recognized.';

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}
