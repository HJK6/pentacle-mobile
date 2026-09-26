import { VoiceDelivery } from '../src/services/voiceDelivery';

const take = { streamId: 'hosta:origin', recordingId: 'rec-1', uri: 'file://take.m4a', mime: 'audio/mp4', durationS: 4, levels: [0.8], interrupted: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  const result = deferred<any>();
  const io = { transcribe: jest.fn((_args: any) => result.promise), deliver: jest.fn().mockResolvedValue({ landed: true }), removeFile: jest.fn().mockResolvedValue(undefined) };
  return { delivery: new VoiceDelivery(io), io, result };
}
test('stop inserts a transcribing row; navigation cannot change delivery destination or voice metadata', async () => {
  const { delivery, io, result } = setup();
  const work = delivery.accept(take);
  expect(delivery.snapshot().takes[0]).toMatchObject({ streamId: 'hosta:origin', status: 'transcribing' });
  result.resolve({ transcript: { text: 'Hello Atlas' } });
  await work;
  expect(io.deliver).toHaveBeenCalledTimes(1);
  expect(io.deliver).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'hosta:origin', text: 'Hello Atlas', durationS: 4 }));
  expect(delivery.snapshot().takes).toHaveLength(0);
  expect(io.removeFile).toHaveBeenCalledWith(take.uri);
});
test('cancel while transcription is in flight removes row and never sends late transcript', async () => {
  const { delivery, io, result } = setup();
  const work = delivery.accept(take);
  delivery.discard(take.recordingId);
  result.resolve({ transcript: { text: 'must not send' } });
  await work;
  expect(io.deliver).not.toHaveBeenCalled();
  expect(delivery.snapshot().takes).toHaveLength(0);
  expect(io.removeFile).toHaveBeenCalledWith(take.uri);
});
test('failed transcription retains audio; retry reuses transcription identity and sends once', async () => {
  const { delivery, io, result } = setup();
  io.transcribe.mockRejectedValueOnce(new Error('backend down'));
  await delivery.accept(take);
  expect(delivery.snapshot().takes[0].status).toBe('failed');
  expect(io.removeFile).not.toHaveBeenCalled();
  const retry = delivery.retry(take.recordingId);
  result.resolve({ transcript: { text: 'retry transcript' } });
  await retry;
  expect(io.transcribe.mock.calls[1][0].transcribeRequestId).toBe(io.transcribe.mock.calls[0][0].transcribeRequestId);
  expect(io.deliver).toHaveBeenCalledTimes(1);
});
test('empty transcript fails visibly and retains audio for retry or discard', async () => {
  const { delivery, io, result } = setup();
  const work = delivery.accept(take);
  result.resolve({ transcript: { text: ' ' } });
  await work;
  expect(delivery.snapshot().takes[0]).toMatchObject({ status: 'failed', error: 'Nothing was recognized.' });
  expect(io.deliver).not.toHaveBeenCalled();
  expect(io.removeFile).not.toHaveBeenCalled();
});
