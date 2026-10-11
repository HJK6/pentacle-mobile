import { AppState, type AppStateStatus } from 'react-native';
import { AudioModule, setAudioModeAsync } from 'expo-audio';
import type { CaptureStatus } from '../modules/pentacle-voice-capture';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { VoiceTakeStore, type VoiceTakeIO } from '../src/services/voiceTakeStore';
import { createVoiceQuestionSnapshot, resetVoiceAnswersForTests } from '../src/components/questions/voice/voiceAnswersBinding';
import { MAX_DURATION_MS } from '../src/services/voiceRecording';
import { NativeCaptureEngine, voiceRecorder, setVoiceLifecycle, sendVoiceTake } from '../src/services/voiceRecordingEngine';

let mockStore: VoiceTakeStore;
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();
let mockStatus: CaptureStatus = { state: 'idle', reason: null, recordingId: null, pauseEpoch: 0, capturedMs: 0, uri: null, metering: -20 };
let mockGeneration = 0;
const mockRecord = jest.fn();
const mockNative = {
  getCaptureContract: () => ({ contract: 'pentacle-voice-capture', revision: 1, nativeBuild: '101' }),
  getStatus: () => ({ ...mockStatus, capturedMs: mockStatus.state === 'recording' ? mockDuration : mockStatus.capturedMs }),
  getAdmission: () => mockGeneration, revokeAdmissions: jest.fn(() => { mockGeneration++; }),
  getPermission: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }), requestPermission: jest.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
  start: jest.fn(async (id: string, admission: number): Promise<CaptureStatus> => {
    const uri = `file:///cache/take-${++mockSequence}.m4a`; mockFiles.set(uri, 'audio');
    mockStatus = { ...mockStatus, recordingId: id, state: 'starting', capturedMs: 0, pauseEpoch: 0, uri };
    if (mockPrepare) await mockPrepare;
    if (admission !== mockGeneration) throw new Error('cancelled');
    mockStatus.state = 'recording'; mockRecord(); return mockNative.getStatus();
  }),
  pause: jest.fn(async (): Promise<CaptureStatus> => {
    if (mockStatus.state === 'recording') { mockStatus.capturedMs = mockDuration; mockStatus.pauseEpoch++; mockStatus.state = 'paused'; }
    else if (mockStatus.state === 'starting') { mockStatus.pauseEpoch++; mockStatus.state = 'paused'; }
    return mockNative.getStatus();
  }),
  resume: jest.fn(async (_id: string, epoch: number, admission: number): Promise<CaptureStatus> => {
    if (mockPrepare) await mockPrepare;
    if (admission !== mockGeneration) throw new Error('cancelled');
    if (epoch !== mockStatus.pauseEpoch) throw new Error('stale_epoch');
    mockStatus.state = 'recording'; mockRecord(); return mockNative.getStatus();
  }),
  stop: jest.fn(async (): Promise<CaptureStatus> => { if (mockStatus.state === 'recording') mockStatus.capturedMs = mockDuration; mockStatus.state = 'stopped'; return mockNative.getStatus(); }),
  discard: jest.fn(async () => { mockStatus.state = 'discarded'; }),
};
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
jest.mock('../modules/pentacle-voice-capture', () => ({ ACCEPTED_CAPTURE_REVISION: 1, nativeVoiceCapture: () => mockNative, getCaptureContract: () => mockNative.getCaptureContract() }));
jest.mock('../src/config/appIdentity', () => ({ getAppIdentity: () => ({ version: '1', buildNumber: '101' }) }));
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
beforeEach(() => { resetVoiceAnswersForTests(); jest.useFakeTimers(); mockFiles.clear(); mockDirs.clear(); mockStatus = { state: 'idle', reason: null, recordingId: null, pauseEpoch: 0, capturedMs: 0, uri: null, metering: -20 }; mockGeneration = 0; mockDuration = 3000; mockPrepare = null; mockStore = fixture(); mockCurrentScope = scope; mockAuthNeeded = false; setVoiceLifecycle({ foreground: true, unlocked: true }); });
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
  mockDuration = MAX_DURATION_MS; mockStatus.state = 'capped'; mockStatus.capturedMs = MAX_DURATION_MS;
  jest.advanceTimersByTime(90); await flush();
  expect(mockAccept).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  expect(mockStore.get(id)).toMatchObject({ storage: 'finalized', sendRequestedAt: null, capturedAudioMs: MAX_DURATION_MS });
});
test('R11 native pause revokes admission first; Resume keeps its native identity/file', async () => {
  const engine = new NativeCaptureEngine(); await engine.start();
  const uri = engine.nativeUri; const id = mockStatus.recordingId; await engine.pause();
  expect(mockNative.revokeAdmissions.mock.invocationCallOrder.at(-1)).toBeLessThan(mockNative.pause.mock.invocationCallOrder.at(-1)!);
  await engine.resume(); expect(engine.nativeUri).toBe(uri); expect(mockStatus.recordingId).toBe(id);
  expect(mockNative.start).toHaveBeenCalledTimes(1); expect(mockRecord).toHaveBeenCalledTimes(2);
  expect(mockNative.resume).toHaveBeenCalledWith(id, 1, mockGeneration);
  expect(AudioModule.AudioRecorder).not.toHaveBeenCalled(); expect(setAudioModeAsync).not.toHaveBeenCalled(); await engine.discard();
});
test('R11 account switch fences rearm even with identical origin and generation; restoring scope permits explicit Resume', async () => {
  const id = await voiceRecorder.start('hosta:origin');
  mockCurrentScope = { ...scope, credentialId: 'operator-b' };
  mockTransportListeners.forEach(listener => listener()); await flush();
  expect(voiceRecorder.snapshot()).toMatchObject({ recordingId: id, status: 'paused', pauseReason: 'origin' });
  await expect(voiceRecorder.resume()).rejects.toThrow('Original chat unavailable'); expect(mockRecord).toHaveBeenCalledTimes(1); expect(voiceRecorder.isOwnedByCurrentScope(id)).toBe(false);
  mockCurrentScope = scope; mockTransportListeners.forEach(listener => listener());
  expect(voiceRecorder.snapshot()?.pauseReason).toBeUndefined(); await voiceRecorder.resume(); expect(mockRecord).toHaveBeenCalledTimes(2);
});
test('R11 account switch during delayed native rearm cannot recapture', async () => {
  await voiceRecorder.start('hosta:origin'); await voiceRecorder.pause();
  let resolve!: () => void;
  mockPrepare = new Promise<void>(done => { resolve = done; });
  const resumed = voiceRecorder.resume().catch(error => error); await flush();
  mockCurrentScope = { ...scope, serverIdentity: 'wss://different.invalid/ws' }; mockTransportListeners.forEach(listener => listener()); resolve();
  expect((await resumed).message).toBe('cancelled'); expect(mockRecord).toHaveBeenCalledTimes(1);
});

test('R11 revoked credentials pause capture and block rearm while retaining same-scope visibility', async () => {
  const id = await voiceRecorder.start('hosta:origin');
  mockAuthNeeded = true; mockTransportListeners.forEach(listener => listener()); await flush();
  expect(voiceRecorder.snapshot()?.status).toBe('paused'); expect(voiceRecorder.isOwnedByCurrentScope(id)).toBe(true);
  await expect(voiceRecorder.resume()).rejects.toThrow('Original chat unavailable'); expect(mockRecord).toHaveBeenCalledTimes(1);
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
