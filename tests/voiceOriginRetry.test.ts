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

async function reconnect(j: Journey, sessions: Record<string, unknown>[], receiptState: MockWebSocket['receiptState'] = 'unknown') {
  jest.advanceTimersByTime(2000); await flush();
  const socket = MockWebSocket.instances.at(-1)!; expect(socket).not.toBe(j.socket);
  socket.receiptState = receiptState; authenticate(socket); await flush();
  // OPEN and a completed local hello are insufficient before authenticated inventory.
  expect(j.stream.voiceTransportSnapshot().ready).toBe(false); expect(socket.sends()).toHaveLength(0);
  expect(socket.frames('upload_blob_init')).toHaveLength(0);
  socket.message({ type: 'snapshot', sessions, events: [] }); await flush();
  return socket;
}

test('voice retry must not send to a generation replaced while reconnect is awaited', async () => {
  const j = await connect();
  try {
    const take = await retain(j); const work = j.voiceDelivery.send(take.recordingId);
    await until(() => j.socket.sends().length === 1); const first = j.socket.sends()[0];
    j.socket.close(); await work; await flush();
    const intent = j.store.get(take.recordingId)!.dispatchIntent!;
    expect(j.store.get(take.recordingId)?.delivery.phase).toBe('checking');
    j.stream.markOptimisticFailed(intent.optimisticId, 'unconfirmed');
    expect(await j.stream.retryOptimisticSend(intent.optimisticId)).toBe(false);
    expect(await j.retryVoiceMessage(intent.optimisticId, j.stream.retryOptimisticSend)).toBe(false);
    const recovered = await reconnect(j, [{ ...origin, session_generation: 'replacement' }, other], 'not_landed');
    await until(() => j.store.get(take.recordingId)?.delivery.phase === 'not_landed');
    const query = recovered.frames('send.receipt.get').at(-1)!;
    expect(query).toMatchObject({ to_stream_id: originId, request_id: first.request_id, original_request: intent.originalRequest });
    await j.voiceDelivery.retry(take.recordingId); await flush();
    expect(recovered.sends()).toHaveLength(0);
    expect(j.store.get(take.recordingId)).toMatchObject({ origin: { streamId: originId, generation }, sequence: 1, dispatchIntent: { requestId: first.request_id } });
    expect(mockDisk.has(j.store.audioUri(take))).toBe(true); expect(j.voiceDelivery.snapshot().last).toBeNull();
  } finally { j.cleanup(); }
});

test.each(['original', 'replacement'])('offline voice replay waits for fresh inventory and respects %s generation', async currentGeneration => {
  const j = await connect();
  try {
    const take = await retain(j); j.socket.close(); await j.voiceDelivery.send(take.recordingId);
    expect(j.store.get(take.recordingId)).toMatchObject({ sendRequestedAt: expect.any(Number), delivery: { phase: 'queued' } });
    expect(j.store.get(take.recordingId)?.dispatchIntent).toBeUndefined();
    const recovered = await reconnect(j, [{ ...origin, session_generation: currentGeneration === 'original' ? generation : 'replacement' }, other]);
    if (currentGeneration === 'original') {
      await until(() => recovered.sends().length === 1); const frame = recovered.sends()[0];
      expect(frame).toMatchObject({ stream_id: originId, request_id: expect.stringMatching(/^voice-send-/), operation_id: take.recordingId });
      land(recovered, frame); await until(() => !j.store.get(take.recordingId));
      expect(j.voiceDelivery.snapshot()).toMatchObject({ takes: [], last: null });
    } else {
      expect(recovered.sends()).toHaveLength(0); expect(recovered.frames('upload_blob_init')).toHaveLength(0);
      expect(j.store.get(take.recordingId)).toMatchObject({ origin: { generation }, delivery: { phase: 'origin_unavailable' } });
      expect(mockDisk.has(j.store.audioUri(take))).toBe(true);
    }
  } finally { j.cleanup(); }
});

test('unknown voice reconnect only checks receipts; explicit not_landed retry keeps logical identity with a new voice-v1 attempt', async () => {
  const j = await connect();
  try {
    const take = await retain(j); const sending = j.voiceDelivery.send(take.recordingId);
    await until(() => j.socket.sends().length === 1); const first = j.socket.sends()[0];
    j.socket.message({ type: 'send.result', request_id: first.request_id, to_stream_id: originId, state: 'accepted', delivery: 'proof_unavailable' });
    await sending; await flush(); const originalIntent = j.store.get(take.recordingId)!.dispatchIntent!;
    expect(j.store.get(take.recordingId)?.delivery.phase).toBe('checking');
    expect(mockDisk.has(j.store.audioUri(take))).toBe(true); expect(j.voiceDelivery.snapshot().last).toBeNull();
    j.socket.close(); const recovered = await reconnect(j, [origin, other]);
    expect(recovered.sends()).toHaveLength(0);
    expect(recovered.frames('send.receipt.get').at(-1)).toMatchObject({ to_stream_id: originId, request_id: first.request_id, original_request: originalIntent.originalRequest });
    expect(await j.stream.retryOptimisticSend(originalIntent.optimisticId)).toBe(false);
    expect(await j.retryVoiceMessage(originalIntent.optimisticId, j.stream.retryOptimisticSend)).toBe(false);
    expect(recovered.sends()).toHaveLength(0);
    expect(j.store.get(take.recordingId)).toMatchObject({ sequence: 1, dispatchIntent: originalIntent, delivery: { phase: 'checking' } });
    recovered.receiptState = 'not_landed'; await j.voiceDelivery.checkAgain(take.recordingId); await flush();
    expect(j.store.get(take.recordingId)?.delivery.phase).toBe('not_landed');
    expect(recovered.sends()).toHaveLength(0);
    recovered.receiptState = 'unknown';
    const retry = j.retryVoiceMessage(originalIntent.optimisticId, j.stream.retryOptimisticSend);
    await until(() => recovered.sends().length === 1); const second = recovered.sends()[0];
    const retriedIntent = j.store.get(take.recordingId)!.dispatchIntent!;
    expect(retriedIntent).toMatchObject({ sequence: 2, optimisticId: originalIntent.optimisticId, msgId: originalIntent.msgId,
      originalRequest: { protocol: 'voice-v1', logical_id: take.recordingId, target: originId, generation, sequence: 2 } });
    expect(second.request_id).toMatch(/^voice-send-[0-9a-f]{40}$/); expect(second.request_id).not.toBe(first.request_id);
    expect(second).toEqual({ ...first, request_id: second.request_id });
    const manifestUri = [...mockDisk.keys()].find(uri => uri.includes(take.recordingId) && uri.endsWith('/manifest.json'))!;
    expect(JSON.parse(mockDisk.get(manifestUri)!.toString()).dispatchIntent).toEqual(retriedIntent);
    expect(recovered.frames('upload_blob_init')).toHaveLength(0); expect(recovered.frames('transcribe_blob')).toHaveLength(0);
    // A late receipt for attempt 1 cannot retire attempt 2.
    land(recovered, first); await flush(); expect(j.store.get(take.recordingId)).toBeDefined();
    // Matching proof owns asynchronous tombstone/cleanup, independently of the timeline retry boolean.
    land(recovered, second); await retry; await until(() => !j.store.get(take.recordingId)); await flush();
    expect(j.socket.sends()).toHaveLength(1); expect(recovered.sends()).toHaveLength(1);
    expect(j.voiceDelivery.snapshot()).toMatchObject({ takes: [], last: null });
    expect(mockDisk.has(j.store.audioUri(take))).toBe(false);
  } finally { j.cleanup(); }
});
