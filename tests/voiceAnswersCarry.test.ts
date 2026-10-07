// P6 shared leg (spec_pentacle_mobile__voice_answers_2026_10 § V3): the voice send leg attaches
// meta.voice_answers for a recording the Questions overlay bound, with stage-specific retry identity.
import {
  installVoiceAnswersCarrier,
  isVoiceAnswersCarrierInstalled,
  registerVoiceAnswersBinding,
  resetVoiceAnswersForTests,
  voiceAnswersItemCount,
} from '../src/components/questions/voice/voiceAnswersBinding';

const mockSend = jest.fn();
const mockAppend = jest.fn();
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => ({
    sessions: [{ stream_id: 'bart:assistant', host: 'bart', session_name: 'assistant' }],
    optimisticSends: { 'opt-1': { request_id: 'req-1' } },
  }),
  appendOptimisticUserMessage: (...args: unknown[]) => mockAppend(...args),
  sendPentacleMessage: (...args: unknown[]) => mockSend(...args),
  markOptimisticFailed: jest.fn(),
}));
const mockTranscribe = jest.fn();
jest.mock('../src/services/voiceSendUnit', () => ({
  ...jest.requireActual('../src/services/voiceSendUnit'),
  runVoiceUploadTranscribe: (...args: unknown[]) => mockTranscribe(...args),
}));

// eslint-disable-next-line import/first
import { voiceDelivery } from '../src/services/voiceDelivery';

const take = (recordingId: string) => ({
  streamId: 'bart:assistant', recordingId, uri: 'file://p6.m4a', mime: 'audio/mp4', durationS: 8, levels: [0.5], interrupted: false,
});
const item = (n: number) => ({
  key: `n-${n}:0`, question_id: `q-${n}`, notification_id: `n-${n}`, producer_stream_id: `hostc:codex:seat-${n}`,
  surface_stream_id: 'bart:assistant', prompt: `Prompt ${n}?`, segment: { start_s: n, end_s: n + 2 },
});

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue(true);
  mockAppend.mockReset().mockReturnValue('opt-1');
  mockTranscribe.mockReset().mockResolvedValue({ blobSha: 'sha256:audio', transcript: { text: 'Hold the deploy. Go with option two.' } });
  for (const pending of voiceDelivery.snapshot().takes) voiceDelivery.discard(pending.recordingId);
  const keepCarrier = isVoiceAnswersCarrierInstalled();
  resetVoiceAnswersForTests();
  if (keepCarrier) installVoiceAnswersCarrier();
});

test('importing the voice send leg declares the carrier (the overlay mic appears)', () => {
  expect(isVoiceAnswersCarrierInstalled()).toBe(true);
});

test('a bound recording sends meta.voice + meta.voice_answers with the uploaded blob_sha', async () => {
  registerVoiceAnswersBinding('rec-1', [item(1), item(2)]);
  expect(voiceAnswersItemCount('rec-1')).toBe(2);
  await voiceDelivery.accept(take('rec-1'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  const args = mockSend.mock.calls[0][0];
  expect(args.text).toBe('Hold the deploy. Go with option two.');
  expect(args.meta).toEqual({
    voice: { duration_s: 8 },
    voice_answers: { version: 1, recording_id: 'rec-1', blob_sha: 'sha256:audio', duration_s: 8, items: [item(1), item(2)] },
  });
  // Once dispatched the binding lives in the optimistic event's meta; the registry lets go.
  expect(voiceAnswersItemCount('rec-1')).toBe(0);
});

test('a plain voice note (no binding) sends only meta.voice', async () => {
  await voiceDelivery.accept(take('rec-plain'));
  expect(mockSend.mock.calls[0][0].meta).toEqual({ voice: { duration_s: 8 } });
});

test('stage 1 retry: a failed transcription re-runs under the same transcribe id and sends the identical binding once', async () => {
  registerVoiceAnswersBinding('rec-2', [item(1)]);
  mockTranscribe.mockRejectedValueOnce(new Error('backend down'));
  await voiceDelivery.accept(take('rec-2'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(voiceDelivery.snapshot().takes[0].status).toBe('failed');
  expect(voiceAnswersItemCount('rec-2')).toBe(1);
  await voiceDelivery.retry('rec-2');
  expect(mockTranscribe.mock.calls[1][0].transcribeRequestId).toBe(mockTranscribe.mock.calls[0][0].transcribeRequestId);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].meta.voice_answers).toMatchObject({ recording_id: 'rec-2', items: [item(1)] });
});

test('a pre-dispatch delivery failure keeps the binding for the retry', async () => {
  registerVoiceAnswersBinding('rec-3', [item(1), item(2)]);
  mockAppend.mockReturnValueOnce(null);
  await voiceDelivery.accept(take('rec-3'));
  expect(voiceDelivery.snapshot().takes[0].status).toBe('failed');
  expect(voiceAnswersItemCount('rec-3')).toBe(2);
  await voiceDelivery.retry('rec-3');
  expect(mockSend.mock.calls[0][0].meta.voice_answers.items).toHaveLength(2);
});

test('discarding a take forgets its binding', async () => {
  registerVoiceAnswersBinding('rec-4', [item(1)]);
  mockTranscribe.mockRejectedValueOnce(new Error('down'));
  await voiceDelivery.accept(take('rec-4'));
  voiceDelivery.discard('rec-4');
  expect(voiceAnswersItemCount('rec-4')).toBe(0);
});
