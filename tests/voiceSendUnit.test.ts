// The unit takes injectable IO; mock the heavy transport/file modules so their
// import side effects never load in the test (harness invariance).
jest.mock('../src/services/pentacleStream', () => ({
  uploadBlobBase64: jest.fn(),
  transcribeBlob: jest.fn(),
}));
jest.mock('../src/services/attachmentUpload', () => ({
  readAttachmentBase64: jest.fn(),
}));

import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';

import {
  runVoiceUploadTranscribe,
  voiceTranscribeFailureMessage,
  isEmptyTranscript,
  NOTHING_RECOGNIZED_MESSAGE,
  type VoiceUnitIO,
} from '../src/services/voiceSendUnit';

const RECORDING = { uri: 'file:///tmp/take.m4a', mime: 'audio/mp4', durationS: 6, bytes: 1234 };
const TAGS = { stream_id: 'hosta:agent-1', recording_id: 'rec-42' };

function captureTelemetry() {
  const events: TelemetryPayload[] = [];
  setTelemetrySink((p) => events.push(p));
  return events;
}

function io(overrides: Partial<VoiceUnitIO> = {}): VoiceUnitIO {
  return {
    readBase64: jest.fn(async () => 'BASE64'),
    upload: jest.fn(async () => ({ blob_sha: 'sha-abc' })),
    transcribe: jest.fn(async () => ({
      text: 'Hey Juniper',
      duration_s: 6,
      model: 'large-v3',
      vocabulary_version: 'fleet-v3',
    })),
    ...overrides,
  };
}

afterEach(() => setTelemetrySink(null));

test('happy path uploads then transcribes and returns the transcript', async () => {
  const events = captureTelemetry();
  const injected = io();
  const result = await runVoiceUploadTranscribe({
    recording: RECORDING,
    transcribeRequestId: 'transcribe-1',
    tags: TAGS,
    io: injected,
  });

  expect(result.blobSha).toBe('sha-abc');
  expect(result.transcript.text).toBe('Hey Juniper');
  expect(injected.readBase64).toHaveBeenCalledWith(RECORDING.uri);
  expect(injected.upload).toHaveBeenCalledWith('BASE64', 1234);
  // stable request_id threads to the idempotent transcribe verb
  expect(injected.transcribe).toHaveBeenCalledWith('sha-abc', 'audio/mp4', {
    requestId: 'transcribe-1',
  });

  const names = events.map((e) => e.message);
  expect(names).toEqual(['chat.voice.upload_ok', 'chat.voice.transcribe_ok']);
  expect(events.every((e) => e.subsystem === 'mobile_voice')).toBe(true);
  const okEvent = events[1];
  expect(okEvent.data).toMatchObject({
    stream_id: 'hosta:agent-1',
    recording_id: 'rec-42',
    blob_sha: 'sha-abc',
    request_id: 'transcribe-1',
    model: 'large-v3',
    vocabulary_version: 'fleet-v3',
  });
  expect(okEvent.bug_ref).toBe('spec_pentacle_mobile__voice_input_thoth_transcription_2026_09');
});

test('upload failure rejects, emits upload_failed, never transcribes', async () => {
  const events = captureTelemetry();
  const injected = io({
    upload: jest.fn(async () => {
      throw new Error('socket dropped');
    }),
  });
  await expect(
    runVoiceUploadTranscribe({
      recording: RECORDING,
      transcribeRequestId: 't-1',
      tags: TAGS,
      io: injected,
    }),
  ).rejects.toThrow('socket dropped');
  expect(injected.transcribe).not.toHaveBeenCalled();
  expect(events.map((e) => e.message)).toEqual(['chat.voice.upload_failed']);
});

test('transcribe failure rejects and carries the daemon error_code in telemetry', async () => {
  const events = captureTelemetry();
  const err = Object.assign(new Error('backend down'), { code: 'backend_unavailable' });
  const injected = io({ transcribe: jest.fn(async () => Promise.reject(err)) });
  await expect(
    runVoiceUploadTranscribe({
      recording: RECORDING,
      transcribeRequestId: 't-1',
      tags: TAGS,
      io: injected,
    }),
  ).rejects.toBe(err);
  const failed = events.find((e) => e.message === 'chat.voice.transcribe_failed');
  expect(failed?.data.error_code).toBe('backend_unavailable');
});

test('voiceTranscribeFailureMessage maps error codes to distinct messages', () => {
  const mk = (code: string) => Object.assign(new Error(code), { code });
  expect(voiceTranscribeFailureMessage(mk('backend_unavailable'))).toMatch(/unavailable/i);
  expect(voiceTranscribeFailureMessage(mk('too_long'))).toMatch(/too long/i);
  expect(voiceTranscribeFailureMessage(mk('mime_unsupported'))).toMatch(/format/i);
  expect(voiceTranscribeFailureMessage(mk('blob_unknown'))).toMatch(/lost/i);
  expect(voiceTranscribeFailureMessage(new Error('other'))).toMatch(/failed/i);
});

test('isEmptyTranscript detects the nothing-recognized terminal state', () => {
  expect(isEmptyTranscript({ text: '   ' })).toBe(true);
  expect(isEmptyTranscript({ text: 'Host A' })).toBe(false);
  expect(NOTHING_RECOGNIZED_MESSAGE).toMatch(/nothing/i);
});

test('cancellation during upload abandons the remaining transcription leg', async () => {
  let cancelled = false;
  const injected = io({ upload: jest.fn(async () => { cancelled = true; return { blob_sha: 'sha-cancel' }; }) });
  const events = captureTelemetry();
  await expect(runVoiceUploadTranscribe({ recording: RECORDING, transcribeRequestId: 'cancel-1', tags: TAGS, io: injected, isCancelled: () => cancelled })).rejects.toThrow('voice_cancelled');
  expect(injected.transcribe).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});
