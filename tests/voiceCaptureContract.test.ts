import { AudioModule, setAudioModeAsync } from 'expo-audio';
import { NativeCaptureEngine, ACCEPTED_CAPTURE_REVISION } from '../src/services/voiceRecordingEngine';
import { CaptureUnsupportedError, VoiceRecorder, type RecordingDraft } from '../src/services/voiceRecording';
import type { NativeVoiceCapture } from '../modules/pentacle-voice-capture';

jest.mock('../src/services/voiceDelivery', () => ({ voiceDelivery: { setLifecycle: jest.fn() } }));
jest.mock('../src/services/pentacleStream', () => ({ subscribeVoiceTransport: jest.fn(), voiceTransportSnapshot: jest.fn() }));

const valid = { contract: 'pentacle-voice-capture', revision: 1, nativeBuild: '101' };
function nativeModule() {
  return {
    getCaptureContract: jest.fn(() => valid),
    getStatus: jest.fn(() => ({ state: 'idle', reason: null, pauseEpoch: 0, capturedMs: 0, metering: null, uri: null, recordingId: null })),
    getAdmission: jest.fn(() => 0), revokeAdmissions: jest.fn(),
    getPermission: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    requestPermission: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
    start: jest.fn(), pause: jest.fn(), resume: jest.fn(), stop: jest.fn(), discard: jest.fn(),
  } as unknown as jest.Mocked<NativeVoiceCapture>;
}
const cases: Array<[string, unknown, boolean?]> = [
  ['missing module', valid, true], ['throwing contract', new Error('bridge missing')],
  ['null contract', null], ['string contract', 'pentacle-voice-capture'], ['array contract', [valid]],
  ['wrong contract', { ...valid, contract: 'expo-audio' }], ['revision zero', { ...valid, revision: 0 }],
  ['revision two', { ...valid, revision: 2 }], ['missing revision', { contract: valid.contract, nativeBuild: '101' }],
  ['multiple revisions', { ...valid, revision: [1, 2] }], ['string revision', { ...valid, revision: '1' }],
  ['empty build', { ...valid, nativeBuild: '' }], ['whitespace build', { ...valid, nativeBuild: ' ' }],
  ['mismatched build', { ...valid, nativeBuild: '100' }], ['non-string build', { ...valid, nativeBuild: 101 }],
];

test.each(cases.map(([name, value, missing]) => [name, value, !!missing] as const))('CAP-01 handshake refuses %s before permissions, ownership, or draft transfer', async (_name, value, missing) => {
  const native = nativeModule();
  const engine = new NativeCaptureEngine(undefined, {
    module: () => missing ? null : native,
    contract: () => { if (value instanceof Error) throw value; return value; },
    build: () => '101',
  });
  const ownership = {
    create: jest.fn(), checkpoint: jest.fn(), finalize: jest.fn(), requestSend: jest.fn(), discard: jest.fn(), originAvailable: () => true,
  };
  const release = jest.fn();
  const recorder = new VoiceRecorder(engine, { setInterval: jest.fn(), clearInterval: jest.fn() }, ownership);
  const draft: RecordingDraft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: 'Keep my draft', images: [{ uri: 'file:///draft/photo.jpg' } as any] };
  const before = JSON.parse(JSON.stringify(draft));
  await expect(recorder.start('hosta:origin', draft, release)).rejects.toMatchObject({ code: 'capture_unsupported' });
  await expect(engine.getPermission()).rejects.toBeInstanceOf(CaptureUnsupportedError);
  await expect(engine.requestPermission()).rejects.toBeInstanceOf(CaptureUnsupportedError);
  await expect(engine.start()).rejects.toBeInstanceOf(CaptureUnsupportedError);
  expect(draft).toEqual(before); expect(release).not.toHaveBeenCalled(); expect(ownership.create).not.toHaveBeenCalled();
  expect(ownership.discard).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull(); expect(recorder.isActive()).toBe(false);
  expect(native.getPermission).not.toHaveBeenCalled(); expect(native.requestPermission).not.toHaveBeenCalled();
  expect(native.getAdmission).not.toHaveBeenCalled(); expect(native.start).not.toHaveBeenCalled();
  expect(AudioModule.AudioRecorder).not.toHaveBeenCalled(); expect(setAudioModeAsync).not.toHaveBeenCalled();
});

test('CAP-01 accepts exactly the reviewed revision and binary build before reading permission', async () => {
  const native = nativeModule(); const order: string[] = [];
  native.getPermission.mockImplementation(async () => { order.push('permission'); return { granted: true, canAskAgain: true }; });
  const engine = new NativeCaptureEngine(undefined, {
    module: () => native, contract: () => { order.push('contract'); return valid; }, build: () => '101',
  });
  expect(ACCEPTED_CAPTURE_REVISION).toBe(1);
  await expect(engine.getPermission()).resolves.toBe('granted');
  expect(order).toEqual(['contract', 'permission']);
  expect(AudioModule.AudioRecorder).not.toHaveBeenCalled(); expect(setAudioModeAsync).not.toHaveBeenCalled();
});

test('CAP-01 a partial bridge is unavailable even with a matching handshake', async () => {
  const native = nativeModule(); (native as any).revokeAdmissions = undefined;
  const engine = new NativeCaptureEngine(undefined, { module: () => native, contract: () => valid, build: () => '101' });
  await expect(engine.getPermission()).rejects.toBeInstanceOf(CaptureUnsupportedError);
  expect(native.getPermission).not.toHaveBeenCalled();
});
