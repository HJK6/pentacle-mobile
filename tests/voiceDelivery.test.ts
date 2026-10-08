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

const imageDraft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: 'Photo note', images: [{ uri: 'file://photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', width: 10, height: 10, bytes: 123 }] };
test('image upload retry keeps completed transcript, captured draft and origin in one delivery', async () => {
  const io = { transcribe: jest.fn().mockResolvedValue({ transcript: { text: 'spoken detail' }, blobSha: 'audio' }),
    uploadImages: jest.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValueOnce([{ key: 'image', mime: 'image/jpeg' }]),
    deliver: jest.fn().mockResolvedValue({ landed: true }), removeFile: jest.fn().mockResolvedValue(undefined) };
  const delivery = new VoiceDelivery(io);
  await delivery.accept({ ...take, draft: imageDraft });
  expect(delivery.snapshot().takes[0].status).toBe('failed');
  expect(io.deliver).not.toHaveBeenCalled();
  await delivery.retry(take.recordingId);
  expect(io.transcribe).toHaveBeenCalledTimes(1);
  expect(io.uploadImages).toHaveBeenCalledTimes(2);
  expect(io.deliver).toHaveBeenCalledTimes(1);
  expect(io.deliver).toHaveBeenCalledWith(expect.objectContaining({ streamId: take.streamId, originGeneration: 'generation-1', text: 'Photo note\nspoken detail', attachments: [expect.objectContaining({ key: 'image', uri: 'file://photo.jpg' })] }));
});
test('discard during image upload blocks the late combined send', async () => {
  const uploaded = deferred<any>();
  const io = { transcribe: jest.fn().mockResolvedValue({ transcript: { text: 'late' } }), uploadImages: jest.fn(() => uploaded.promise), deliver: jest.fn(), removeFile: jest.fn().mockResolvedValue(undefined) };
  const delivery = new VoiceDelivery(io);
  const work = delivery.accept({ ...take, draft: imageDraft });
  await Promise.resolve();
  expect(io.uploadImages).toHaveBeenCalledTimes(1);
  delivery.discard(take.recordingId);
  uploaded.resolve([{ key: 'image', mime: 'image/jpeg' }]);
  await work;
  expect(io.deliver).not.toHaveBeenCalled();
});
