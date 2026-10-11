// Real durable store, upload/transcription, transport and reducer journey. Only
// native file/UUID access and the external socket are synthetic boundaries.
import type { VoiceAnswersItem } from '../src/components/questions/voice/voiceAnswersBinding';

const mockDisk = new Map<string, Buffer>();
const mockDirectories = new Set<string>();
let mockUuidCounter = 0;
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://default.example/ws' }));
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  uuid: { v4: () => `123e4567-e89b-42d3-a456-${String(++mockUuidCounter).padStart(12, '0')}` },
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockDisk.has(uri) || mockDirectories.has(uri) || mockDirectories.has(`${uri}/`), size: mockDisk.get(uri)?.length ?? 0, isDirectory: mockDirectories.has(uri) || mockDirectories.has(`${uri}/`) })),
  readDirectoryAsync: jest.fn(async (uri: string) => [...new Set([...mockDisk.keys(), ...mockDirectories].filter(key => key.startsWith(uri) && key !== uri).map(key => key.slice(uri.length).split('/')[0]))]),
  makeDirectoryAsync: jest.fn(async (uri: string) => { for (let i = 8; i < uri.length; i++) if (uri[i] === '/') mockDirectories.add(uri.slice(0, i + 1)); mockDirectories.add(uri); }),
  readAsStringAsync: jest.fn(async (uri: string, options?: { encoding?: string; position?: number; length?: number }) => {
    const bytes = mockDisk.get(uri); if (!bytes) throw Error('ENOENT');
    const start = options?.position ?? 0;
    return bytes.subarray(start, options?.length === undefined ? undefined : start + options.length).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
  }),
  writeAsStringAsync: jest.fn(async (uri: string, text: string) => { mockDisk.set(uri, Buffer.from(text)); }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => { const bytes = mockDisk.get(from); if (!bytes) throw Error('ENOENT'); mockDisk.set(to, bytes); mockDisk.delete(from); }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => { const bytes = mockDisk.get(from); if (!bytes) throw Error('ENOENT'); mockDisk.set(to, Buffer.from(bytes)); }),
  deleteAsync: jest.fn(async (uri: string) => { const prefix = uri.endsWith('/') ? uri : `${uri}/`; for (const key of mockDisk.keys()) if (key === uri || key.startsWith(prefix)) mockDisk.delete(key); for (const key of mockDirectories) if (key === uri || key.startsWith(prefix)) mockDirectories.delete(key); }),
  getFreeDiskStorageAsync: jest.fn(async () => 1024 * 1024 * 1024),
}));

function digest(bytes: Buffer) { return require('crypto').createHash('sha256').update(bytes).digest('hex') as string; }
function audioBytes(seconds: number) {
  // Structurally valid synthetic PCM WAV, not native acoustic/device evidence.
  const dataBytes = seconds * 8000 * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40); bytes.fill(7, 44);
  return bytes;
}
class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static uploads = new Map<string, { bytes: Buffer; sha: string; total: number; complete: boolean }>();
  readyState = MockWebSocket.CONNECTING;
  sent: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  beforeTranscript?: () => void;
  transcript = 'spoken detail';
  transcribeErrors: string[] = [];
  receiptState: 'unknown' | 'not_landed' | 'landed' = 'unknown';
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(raw: string) {
    const frame = JSON.parse(raw); this.sent.push(frame);
    void Promise.resolve().then(() => {
      if (this.readyState !== MockWebSocket.OPEN) return;
      const request_id = frame.request_id;
      if (frame.type === 'upload_blob_init') {
        if (frame.protocol !== 2) { this.message({ type: 'upload_blob.init.ok', request_id }); return; }
        const prior = MockWebSocket.uploads.get(frame.upload_id);
        if (prior) { expect(prior.sha).toBe(frame.sha256); expect(prior.total).toBe(frame.total_bytes); }
        const upload = prior ?? { bytes: Buffer.alloc(0), sha: frame.sha256, total: frame.total_bytes, complete: false };
        MockWebSocket.uploads.set(frame.upload_id, upload);
        this.message({ type: 'upload_blob.init.ok', request_id, protocol: 2, upload_id: frame.upload_id, next_offset: upload.bytes.length, complete: upload.complete, ...(upload.complete ? { blob_sha: upload.sha } : {}) });
      }
      if (frame.type === 'upload_blob_chunk') {
        const bytes = Buffer.from(frame.data_b64, 'base64');
        if (frame.protocol !== 2) { if (frame.final) this.message({ type: 'upload_blob.ok', request_id, blob_sha: digest(bytes) }); return; }
        const upload = MockWebSocket.uploads.get(frame.upload_id)!;
        expect(frame.offset).toBe(upload.bytes.length); expect(bytes.length).toBeLessThanOrEqual(65536); expect(frame.chunk_sha256).toBe(digest(bytes));
        upload.bytes = Buffer.concat([upload.bytes, bytes]);
        if (frame.final) { expect(upload.bytes.length).toBe(upload.total); expect(digest(upload.bytes)).toBe(upload.sha); upload.complete = true; }
        this.message({ type: 'upload_blob.ok', request_id, protocol: 2, upload_id: frame.upload_id, next_offset: upload.bytes.length, complete: upload.complete, ...(upload.complete ? { blob_sha: upload.sha } : {}) });
      }
      if (frame.type === 'transcribe_blob') {
        this.beforeTranscript?.(); const error = this.transcribeErrors.shift();
        this.message(error ? { type: 'transcribe_blob.error', request_id, error_code: error } : { type: 'transcribe_blob.ok', request_id, text: this.transcript });
      }
      if (frame.type === 'send.receipt.get') this.message({ type: 'send.receipt.get.ok', request_id, found: this.receiptState !== 'unknown', receipts: this.receiptState === 'unknown' ? [] : [{ request_id, to_stream_id: frame.to_stream_id, state: this.receiptState }] });
    });
  }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  frames(type: string) { return this.sent.filter(frame => frame.type === type); }
  sends() { return this.frames('send'); }
}
const originId = 'hosta:assistant';
const otherId = 'hostb:other';
const generation = 'canonical-generation-1';
const origin = { stream_id: originId, host: 'hosta', session_name: 'assistant', provider: 'codex', session_kind: 'assistant_composite', online: true, session_generation: generation };
const other = { stream_id: otherId, host: 'hostb', session_name: 'other', provider: 'codex', online: true, session_generation: 'other-generation-1' };
const image = { uri: 'file:///picker/photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', width: 10, height: 12, bytes: 5 };
const imageBytes = Buffer.from('image');
const credentialId = '123e4567-e89b-12d3-a456-426614174000';
const envelope = 'pentacle-auth-v2:' + Buffer.from(JSON.stringify({ client_kind: 'pentacle-mobile', credential_id: credentialId, proof_key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'), version: 2 })).toString('base64url');
const scope = { serverIdentity: 'ws://default.example/ws', credentialId };
function authenticate(socket: MockWebSocket) {
  socket.open(); socket.message({ type: 'welcome', auth: { operator: { protocol_version: 2, scheme: 'hmac-sha256-v2', nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', expires_at: Date.now() / 1000 + 10 } } });
}
async function flush() { for (let i = 0; i < 500; i++) await Promise.resolve(); }
async function until(predicate: () => boolean) { for (let i = 0; i < 3000 && !predicate(); i++) await Promise.resolve(); expect(predicate()).toBe(true); }
async function connect(sessions: Record<string, unknown>[] = [origin, other]) {
  jest.resetModules();
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const { voiceDelivery, retryVoiceMessage } = require('../src/services/voiceDelivery') as typeof import('../src/services/voiceDelivery');
  const { voiceTakeStore: store } = require('../src/services/voiceTakeStore') as typeof import('../src/services/voiceTakeStore');
  const binding = require('../src/components/questions/voice/voiceAnswersBinding') as typeof import('../src/components/questions/voice/voiceAnswersBinding');
  stream.setPentacleAuthToken(envelope);
  const unsubscribe = stream.subscribePentacleStream(jest.fn()); jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances.at(-1)!;
  authenticate(socket); socket.message({ type: 'snapshot', sessions, events: [] });
  voiceDelivery.setLifecycle({ foreground: true, unlocked: true }); await voiceDelivery.initialize();
  expect(stream.voiceTransportSnapshot()).toMatchObject({ ready: true, credentialId, inventoryFresh: true });
  const unfocus = stream.registerFocusedPentacleStream(originId);
  return { stream, voiceDelivery, retryVoiceMessage, store, binding, socket, cleanup: () => { voiceDelivery.dispose(); unfocus(); unsubscribe(); for (const ws of MockWebSocket.instances) ws.close(); } };
}
type Journey = Awaited<ReturnType<typeof connect>>;
async function retain(journey: Journey, options: { withImage?: boolean; streamId?: string; originGeneration?: string; seconds?: number; answers?: VoiceAnswersItem[] } = {}) {
  const sendsBefore = journey.socket.sends().length;
  const streamId = options.streamId ?? originId, seconds = options.seconds ?? 3;
  const take = await journey.store.create({ scope, origin: { streamId, generation: options.originGeneration ?? (streamId === otherId ? other.session_generation : generation), label: 'Original chat' }, draft: { textPrefix: options.withImage ? 'Photo note' : '', images: options.withImage ? [image] : [] }, operationKind: options.answers ? 'voice_answer' : 'voice_chat' });
  const uri = `file:///cache/${take.recordingId}.wav`; mockDisk.set(uri, audioBytes(seconds));
  await journey.voiceDelivery.accept({ streamId, recordingId: take.recordingId, uri, mime: 'audio/wav', durationS: seconds, levels: [], interrupted: false });
  if (options.answers) { journey.binding.registerVoiceAnswersBinding(take.recordingId, options.answers); }
  expect(journey.store.get(take.recordingId)).toMatchObject({ storage: 'finalized', sendRequestedAt: null });
  expect(journey.socket.sends()).toHaveLength(sendsBefore);
  return journey.store.get(take.recordingId)!;
}
function land(socket: MockWebSocket, frame: Record<string, any>, streamId = originId) {
  socket.message({ type: 'send.result', request_id: frame.request_id, to_stream_id: streamId, delivery: 'landed' });
}
function answer(n: number): VoiceAnswersItem { return { key: `n-${n}:0`, question_id: `q-${n}`, notification_id: `n-${n}`, producer_stream_id: otherId, surface_stream_id: originId, prompt: `Prompt ${n}?`, segment: { start_s: n, end_s: n + 2 } }; }
beforeEach(() => { jest.useFakeTimers(); mockDisk.clear(); mockDirectories.clear(); mockUuidCounter = 0; MockWebSocket.instances = []; MockWebSocket.uploads.clear(); mockDisk.set(image.uri, imageBytes); delete process.env.EXPO_PUBLIC_HARNESS; delete process.env.EXPO_PUBLIC_HARNESS_FORCE_WS_RECONNECT; });

function sparseEcho(socket: MockWebSocket, frame: Record<string, any>, seq: number) {
  socket.message({ type: 'chat.event', event: { stream_id: originId, session_kind: 'assistant_composite', daemon_seq: seq,
    timestamp: new Date().toISOString(), kind: 'USER', text: frame.message, optimistic_id: frame.msg_id, event_id: `echo-${seq}` } });
}
test.each([false, true])('sparse USER echo then repeated voice (image=%s) retains the canonical origin', async withImage => {
  const j = await connect();
  try {
    const first = await retain(j); const sendingFirst = j.voiceDelivery.send(first.recordingId);
    await until(() => j.socket.sends().length === 1);
    const firstFrame = j.socket.sends()[0];
    expect(firstFrame).toMatchObject({ stream_id: originId, message: 'spoken detail', msg_id: expect.any(String) });
    land(j.socket, firstFrame); await sendingFirst; await flush();
    sparseEcho(j.socket, firstFrame, 1);
    // The sparse reducer loses the display host; authenticated origin inventory remains authoritative.
    expect(j.stream.getPentacleStreamState().sessions.find(s => s.stream_id === originId)?.host).toBe('');
    const answers = [answer(0)];
    const second = await retain(j, { withImage, answers });
    const sendingSecond = j.voiceDelivery.send(second.recordingId, { frozenAnswers: answers });
    await until(() => j.socket.sends().length === 2);
    const frame = j.socket.sends()[1];
    expect(frame).toMatchObject({ stream_id: originId, msg_id: expect.any(String), request_id: expect.stringMatching(/^voice-send-[0-9a-f]{40}$/), operation_id: second.recordingId,
      message: withImage ? 'Photo note\nspoken detail' : 'spoken detail', meta: { voice: { duration_s: 3 }, voice_answers: { recording_id: second.recordingId, blob_sha: second.audio!.sha256, items: answers } } });
    expect(frame).not.toHaveProperty('host'); expect(frame.msg_id).not.toBe(firstFrame.msg_id);
    if (withImage) expect(frame.attachments).toEqual([expect.objectContaining({ key: digest(imageBytes), mime: 'image/jpeg', width: 10, height: 12, bytes: 5 })]);
    else expect(frame.attachments).toBeUndefined();
    const uploaded = j.socket.frames('upload_blob_init').filter(f => f.protocol === 2 && f.voice_operation.operation_id === second.recordingId);
    const transcribed = j.socket.frames('transcribe_blob').find(f => f.request_id === `transcribe-${second.recordingId}`)!;
    expect(uploaded).toHaveLength(1); expect(uploaded[0].voice_operation).toEqual(second.operation); expect(transcribed.voice_operation).toEqual(second.operation);
    expect(Object.keys(second.operation)).toHaveLength(6);
    expect(mockDisk.has(j.store.audioUri(second))).toBe(true);
    land(j.socket, frame); await sendingSecond; await flush();
    expect(j.store.get(second.recordingId)).toBeUndefined(); expect(mockDisk.has(j.store.audioUri(second))).toBe(false);
    expect(j.voiceDelivery.snapshot()).toMatchObject({ takes: [], last: null });
    expect(mockDisk.get(image.uri)).toEqual(imageBytes);
  } finally { j.cleanup(); }
});

test('ordinary voice and ordinary text preserve their existing route encoding', async () => {
  const j = await connect([other]);
  try {
    const take = await retain(j, { streamId: otherId }); const voice = j.voiceDelivery.send(take.recordingId);
    await until(() => j.socket.sends().length === 1); const frame = j.socket.sends()[0];
    expect(frame).toMatchObject({ host: 'hostb', session_name: 'other', text: 'spoken detail', meta: { voice: { duration_s: 3 } } });
    expect(frame).not.toHaveProperty('stream_id'); land(j.socket, frame, otherId); await voice; await flush();
    const text = j.stream.sendPentacleMessage({ host: 'hostb', sessionName: 'other', text: 'plain text' });
    const textFrame = j.socket.sends()[1]; expect(textFrame).toMatchObject({ host: 'hostb', session_name: 'other', text: 'plain text' });
    expect(textFrame).not.toHaveProperty('meta'); land(j.socket, textFrame, otherId); await text;
    expect(j.voiceDelivery.snapshot().last).toBeNull();
  } finally { j.cleanup(); }
});

test('navigation during transcription does not change the recorded origin', async () => {
  const j = await connect(); let leaveOther = () => {};
  try {
    j.socket.beforeTranscript = () => { leaveOther = j.stream.registerFocusedPentacleStream(otherId); };
    const take = await retain(j); const work = j.voiceDelivery.send(take.recordingId);
    await until(() => j.socket.sends().length === 1);
    expect(j.stream.__getFocusedPentacleStreamForTests()).toBe(otherId);
    expect(j.socket.sends()[0]).toMatchObject({ stream_id: originId, operation_id: take.recordingId });
    land(j.socket, j.socket.sends()[0]); await work;
    expect(j.voiceDelivery.snapshot().last).toBeNull();
  } finally { leaveOther(); j.cleanup(); }
});

test.each(['missing', 'removed', 'replaced', 'closed'])('%s origin refuses before dispatch and retains the take', async mode => {
  const j = await connect(mode === 'missing' ? [other] : [origin, other]);
  try {
    if (mode !== 'missing') j.socket.beforeTranscript = () => j.socket.message({ type: 'session.inventory', sessions: mode === 'removed' ? [other] : [{ ...origin, ...(mode === 'closed' ? { status: 'closed' } : { session_generation: 'replacement' }) }, other] });
    const take = await retain(j); await j.voiceDelivery.send(take.recordingId); await flush();
    expect(j.socket.sends()).toHaveLength(0);
    expect(j.store.get(take.recordingId)).toMatchObject({ origin: { streamId: originId, generation }, storage: 'finalized' });
    expect(mockDisk.has(j.store.audioUri(take))).toBe(true);
    // Inventory absence is not authoritative closure; keep queued without inventing a replacement.
    expect(j.voiceDelivery.snapshot().takes[0].status).toBe(['closed', 'replaced'].includes(mode) ? 'origin_unavailable' : 'queued');
    if (['closed', 'replaced'].includes(mode)) expect(j.voiceDelivery.snapshot().takes[0].error).toBe('Original chat unavailable');
    expect(j.voiceDelivery.snapshot().last).toBeNull();
  } finally { j.cleanup(); }
});

test.each(['removed', 'replaced'])('origin %s by an optimistic-state observer never dispatches elsewhere', async mode => {
  const j = await connect(); let changed = false;
  const stopObserving = j.stream.subscribePentacleStream(() => {
    if (!changed && Object.keys(j.stream.getPentacleStreamState().optimisticSends ?? {}).length) {
      changed = true;
      j.socket.message({ type: 'session.inventory', sessions: mode === 'removed' ? [other] : [{ ...origin, session_generation: 'replacement' }, other] });
    }
  });
  try {
    const take = await retain(j); await j.voiceDelivery.send(take.recordingId); await flush();
    expect(changed).toBe(true); expect(j.socket.sends()).toHaveLength(0);
    expect(j.store.get(take.recordingId)).toMatchObject({ dispatchIntent: { streamId: originId, originGeneration: generation }, delivery: { phase: 'checking' } });
    expect(mockDisk.has(j.store.audioUri(take))).toBe(true);
  } finally { stopObserving(); j.cleanup(); }
});

test('an ordinary origin with no host fails closed instead of emitting an empty target', async () => {
  const j = await connect([{ ...other, host: '', session_name: '' }]);
  try {
    const take = await retain(j, { streamId: otherId }); await j.voiceDelivery.send(take.recordingId);
    expect(j.socket.sends()).toHaveLength(0); expect(j.store.get(take.recordingId)?.delivery.phase).toBe('failed');
    expect(mockDisk.has(j.store.audioUri(take))).toBe(true);
  } finally { j.cleanup(); }
});
