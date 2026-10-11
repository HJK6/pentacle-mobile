import { AppState, type AppStateStatus } from 'react-native';
import { AudioModule, setAudioModeAsync } from 'expo-audio';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { VoiceTakeStore, type VoiceTakeIO } from '../src/services/voiceTakeStore';
import { createVoiceQuestionSnapshot, resetVoiceAnswersForTests } from '../src/components/questions/voice/voiceAnswersBinding';
import { MAX_DURATION_MS } from '../src/services/voiceRecording';
import { ExpoAudioEngine, voiceRecorder, setVoiceLifecycle, sendVoiceTake } from '../src/services/voiceRecordingEngine';

let mockStore: VoiceTakeStore;
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
const mockModes: boolean[] = [];
const mockAccept = jest.fn().mockResolvedValue(undefined);
const mockSend = jest.fn(async (id, options) => { await mockStore.requestSend(id, options); });
let mockSequence = 0;
let mockDuration = 3000;
let mockAuthNeeded = false;
let mockPrepare: Promise<void> | null = null;
let mockCurrentScope: { serverIdentity: string; credentialId: string };
const mockTransportListeners = new Set<() => void>();
const scope = { serverIdentity: 'wss://synthetic.invalid/ws', credentialId: 'operator-a' };
jest.mock('../src/services/voiceTakeStore', () => ({ ...jest.requireActual('../src/services/voiceTakeStore'), voiceTakeStore: new Proxy({}, { get: (_target, key) => { const value = (mockStore as any)[key]; return typeof value === 'function' ? value.bind(mockStore) : value; } }) }));
jest.mock('../src/services/voiceDelivery', () => ({ voiceDelivery: {
  accept: (...args: unknown[]) => mockAccept(...args), setLifecycle: jest.fn(),
  initialize: async () => { await mockStore.setScope(scope); },
  enqueue: (id: string, options: unknown) => mockSend(id, options),
  discard: (id: string, options?: { nativeUri?: string }) => mockStore.discard(id, options),
} }));
jest.mock('../src/services/pentacleStream', () => ({
  voiceTransportSnapshot: () => ({ ...mockCurrentScope, authNeeded: mockAuthNeeded, origins: [{ stream_id: 'hosta:origin', session_generation: 'generation-1', title: 'Origin' }] }),
  voiceOriginStatus: () => 'available', subscribeVoiceTransport: (listener: () => void) => { mockTransportListeners.add(listener); return () => mockTransportListeners.delete(listener); },
  getPentacleStreamState: () => ({ sessions: [], notifications: [] }),
}));
jest.mock('expo-audio', () => ({
  AudioModule: {
    AudioRecorder: jest.fn().mockImplementation(() => {
      const uri = `file:///cache/take-${++mockSequence}.m4a`; mockFiles.set(uri, 'audio');
      let active = false;
      return { uri, get isRecording() { return active; },
        prepareToRecordAsync: jest.fn(() => mockPrepare ?? Promise.resolve()),
        record: jest.fn(() => { active = true; }), pause: jest.fn(() => { active = false; }), stop: jest.fn(async () => { active = false; }),
        getStatus: jest.fn(() => ({ isRecording: active, durationMillis: mockDuration, metering: -20 })),
        addListener: jest.fn(() => ({ remove: jest.fn() })),
      };
    }),
    getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }), requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  },
  RecordingPresets: { HIGH_QUALITY: {} }, setAudioModeAsync: jest.fn(async mode => { mockModes.push(mode.allowsRecording); }),
}));
const listeners = new Set<(state: AppStateStatus) => void>();
async function flush() { for (let i = 0; i < 120; i += 1) await Promise.resolve(); }
function fixture() {
  let id = 0;
  const io: VoiceTakeIO = {
    root: 'file:///documents/voice-takes-v1/', cacheRoot: 'file:///cache/', now: () => 1000, uuid: () => `123e4567-e89b-42d3-a456-${String(++id).padStart(12, '0')}`,
    stat: async p => ({ exists: mockFiles.has(p) || mockDirs.has(p), size: mockFiles.get(p)?.length ?? 0, directory: mockDirs.has(p) }),
    list: async p => [...new Set([...mockFiles.keys(), ...mockDirs].filter(k => k.startsWith(p) && k !== p).map(k => k.slice(p.length).split('/')[0]))],
    mkdir: async p => { for (let i = 8; i < p.length; i++) if (p[i] === '/') mockDirs.add(p.slice(0, i + 1)); mockDirs.add(p); },
    read: async p => { if (!mockFiles.has(p)) throw Error('missing'); return mockFiles.get(p)!; }, write: async (p, text) => { mockFiles.set(p, text); },
    move: async (from, to) => { if (!mockFiles.has(from)) throw Error('missing'); mockFiles.set(to, mockFiles.get(from)!); mockFiles.delete(from); },
    copy: async (from, to) => { mockFiles.set(to, mockFiles.get(from)!); },
    remove: async p => { for (const k of [...mockFiles.keys()]) if (k === p || k.startsWith(p + '/')) mockFiles.delete(k); for (const k of [...mockDirs]) if (k === p || k.startsWith(p)) mockDirs.delete(k); },
    free: async () => 1024 ** 3, inspect: async p => { const bytes = mockFiles.get(p); if (!bytes) throw Error('missing'); return { bytes: bytes.length, sha256: bytesToHex(sha256(utf8ToBytes(bytes))) }; },
  };
  return new VoiceTakeStore(io);
}
beforeAll(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; });
});
beforeEach(() => { resetVoiceAnswersForTests(); jest.useFakeTimers(); mockFiles.clear(); mockDirs.clear(); mockModes.length = 0; mockDuration = 3000; mockPrepare = null; mockStore = fixture(); mockCurrentScope = scope; mockAuthNeeded = false; setVoiceLifecycle({ foreground: true, unlocked: true }); });
afterEach(async () => { await voiceRecorder.discard(); for (const take of mockStore.snapshot().takes) await mockStore.discard(take.recordingId); jest.useRealTimers(); });

test('R1 foreground route subscriber removal preserves the singleton capture and immutable origin', async () => {
  const unmountRoute = voiceRecorder.subscribe(() => undefined); await voiceRecorder.start('hosta:origin'); unmountRoute(); jest.advanceTimersByTime(180);
  expect(voiceRecorder.snapshot()).toMatchObject({ streamId: 'hosta:origin', status: 'recording' }); expect(mockAccept).not.toHaveBeenCalled();
});
test('R2 background never automatically hands a take to delivery', async () => {
  await voiceRecorder.start('hosta:origin'); listeners.forEach(listener => listener('background')); await flush();
  expect(mockAccept).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled(); expect(voiceRecorder.snapshot()?.status).toBe('paused');
});
test('R2 five-minute cap retains an unsent take without automatic delivery', async () => {
  const id = await voiceRecorder.start('hosta:origin');
  const recorder = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  recorder.getStatus.mockReturnValue({ isRecording: true, durationMillis: MAX_DURATION_MS, metering: -20 });
  jest.advanceTimersByTime(90); await flush();
  expect(mockAccept).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  expect(mockStore.get(id)).toMatchObject({ storage: 'finalized', sendRequestedAt: null, capturedAudioMs: MAX_DURATION_MS });
});
test('R11 native pause precedes disarm; Resume reuses recorder and file without prepare', async () => {
  const engine = new ExpoAudioEngine(); await engine.start();
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  const uri = engine.nativeUri; await engine.pause();
  expect(native.pause.mock.invocationCallOrder[0]).toBeLessThan((setAudioModeAsync as jest.Mock).mock.invocationCallOrder.at(-1)!);
  await engine.resume(); expect(engine.nativeUri).toBe(uri); expect(native.prepareToRecordAsync).toHaveBeenCalledTimes(1); expect(native.record).toHaveBeenCalledTimes(2);
  expect(native.record.mock.calls[1][0]).toEqual({ forDuration: 297 }); await engine.discard();
});
test('R11 delayed re-arm cannot record after X invalidates the operation', async () => {
  const engine = new ExpoAudioEngine(); await engine.start(); await engine.pause();
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  let resolve!: () => void; let valid = true;
  (setAudioModeAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const resume = engine.resume(() => valid).catch(error => error); valid = false; resolve();
  expect((await resume).message).toBe('voice_cancelled'); expect(native.record).toHaveBeenCalledTimes(1); expect(mockModes.at(-1)).toBe(false); await engine.discard();
});
test('R11 delayed native prepare cannot record after lock', async () => {
  let resolve!: () => void; let valid = true; mockPrepare = new Promise<void>(done => { resolve = done; });
  const engine = new ExpoAudioEngine(); const started = engine.start(() => valid).catch(error => error); await flush();
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  valid = false; resolve(); expect((await started).message).toBe('voice_cancelled'); expect(native.record).not.toHaveBeenCalled(); await engine.discard();
});
test('R11 failed disarm retains a paused native recorder and failed resume never claims recording', async () => {
  const engine = new ExpoAudioEngine(); await engine.start();
  (setAudioModeAsync as jest.Mock).mockRejectedValueOnce(new Error('mode_failed'));
  await expect(engine.pause()).rejects.toThrow('mode_failed'); expect(engine.poll().interrupted).toBe(true);
  (setAudioModeAsync as jest.Mock).mockRejectedValueOnce(new Error('arm_failed'));
  await expect(engine.resume()).rejects.toThrow('arm_failed'); expect(engine.poll().interrupted).toBe(true); await engine.discard();
});

test('R11 account switch fences rearm even with identical origin and generation; restoring scope permits explicit Resume', async () => {
  const id = await voiceRecorder.start('hosta:origin');
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  mockCurrentScope = { ...scope, credentialId: 'operator-b' };
  mockTransportListeners.forEach(listener => listener()); await flush();
  expect(voiceRecorder.snapshot()).toMatchObject({ recordingId: id, status: 'paused', pauseReason: 'origin' });
  await expect(voiceRecorder.resume()).rejects.toThrow('Original chat unavailable'); expect(native.record).toHaveBeenCalledTimes(1); expect(voiceRecorder.isOwnedByCurrentScope(id)).toBe(false);
  mockCurrentScope = scope; mockTransportListeners.forEach(listener => listener());
  expect(voiceRecorder.snapshot()?.pauseReason).toBeUndefined(); await voiceRecorder.resume(); expect(native.record).toHaveBeenCalledTimes(2);
});
test('R11 account switch during delayed native rearm cannot recapture', async () => {
  await voiceRecorder.start('hosta:origin'); await voiceRecorder.pause();
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  let resolve!: () => void;
  (setAudioModeAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const resumed = voiceRecorder.resume().catch(error => error); await flush();
  mockCurrentScope = { ...scope, serverIdentity: 'wss://different.invalid/ws' }; resolve();
  expect((await resumed).message).toBe('voice_cancelled'); expect(native.record).toHaveBeenCalledTimes(1);
});

test('R12 native deadline finish records the cap but early native finish never fabricates five minutes', async () => {
  const engine = new ExpoAudioEngine(); await engine.start();
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  engine.poll(); native.addListener.mock.calls[0][1]({ isFinished: true, hasError: false });
  expect(engine.poll()).toMatchObject({ capped: false, interrupted: true, durationMs: 3000 }); await engine.discard();
  await engine.start(); const cappedNative = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  jest.advanceTimersByTime(MAX_DURATION_MS); cappedNative.addListener.mock.calls[0][1]({ isFinished: true, hasError: false });
  expect(engine.poll()).toMatchObject({ capped: true, durationMs: MAX_DURATION_MS }); await engine.discard();
});

test('R11 revoked credentials pause capture and block rearm while retaining same-scope visibility', async () => {
  const id = await voiceRecorder.start('hosta:origin');
  const native = (AudioModule.AudioRecorder as unknown as jest.Mock).mock.results.at(-1)!.value;
  mockAuthNeeded = true; mockTransportListeners.forEach(listener => listener()); await flush();
  expect(voiceRecorder.snapshot()?.status).toBe('paused'); expect(voiceRecorder.isOwnedByCurrentScope(id)).toBe(true);
  await expect(voiceRecorder.resume()).rejects.toThrow('Original chat unavailable'); expect(native.record).toHaveBeenCalledTimes(1);
});

test('CAP-03 restored finalized question Send preserves committed frozen answers with an unavailable deck', async () => {
  await mockStore.setScope(scope);
  const item = { key: 'question:0', question_id: 'question', notification_id: 'notification', producer_stream_id: 'hosta:worker', surface_stream_id: 'hosta:origin', prompt: 'Synthetic choice?' };
  const questionBinding = { ...createVoiceQuestionSnapshot([item], 1, item.key, [item.key]), phase: 'finalized' as const, capturedAudioMs: 2500, visits: [{ key: item.key, startMs: 0, endMs: 2500 }] };
  const take = await mockStore.create({ scope, origin: { streamId: 'hosta:origin', generation: 'generation-1', label: 'Origin' }, operationKind: 'voice_answer', questionBinding });
  const uri = 'file:///cache/restored-answer.m4a'; mockFiles.set(uri, 'synthetic-audio');
  const frozenAnswers = [{ ...item, segment: { start_s: 0, end_s: 2.5 } }];
  await mockStore.adoptFinalized(take.recordingId, { uri, mime: 'audio/mp4', capturedAudioMs: 2500, questionBinding, frozenAnswers });
  resetVoiceAnswersForTests(); await sendVoiceTake(take.recordingId);
  expect(mockStore.get(take.recordingId)).toMatchObject({ storage: 'finalized', frozenAnswers, sendRequestedAt: expect.any(Number) });
  expect(mockSend).toHaveBeenCalledWith(take.recordingId, { frozenAnswers });
});
