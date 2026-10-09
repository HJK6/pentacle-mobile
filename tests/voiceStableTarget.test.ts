// Exercise the real upload/transcribe/delivery/reducer/send path. Only native
// file access and the external socket are replaced; all fixtures are synthetic.
import type { FinishedRecording } from '../src/services/voiceRecording';

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://default.example/ws' }));
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn(async (uri: string) => uri.endsWith('.jpg') ? 'aW1hZ2U=' : 'YXVkaW8='),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  beforeTranscript?: () => void;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    // Responses occur after the real command owner installs its pending entry.
    void Promise.resolve().then(() => {
      const request_id = frame.request_id;
      if (frame.type === 'upload_blob_init') this.message({ type: 'upload_blob.init.ok', request_id });
      if (frame.type === 'upload_blob_chunk' && frame.final) this.message({ type: 'upload_blob.ok', request_id, blob_sha: frame.data_b64 === 'aW1hZ2U=' ? 'image-sha' : 'audio-sha' });
      if (frame.type === 'transcribe_blob') {
        this.beforeTranscript?.();
        this.message({ type: 'transcribe_blob.ok', request_id, text: 'spoken detail' });
      }
    });
  }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  sends() { return this.sent.filter(frame => frame.type === 'send'); }
}

const originId = 'hosta:assistant';
const otherId = 'hostb:other';
const origin = { stream_id: originId, host: 'hosta', session_name: 'assistant', provider: 'codex', session_kind: 'assistant_composite', online: true };
const other = { stream_id: otherId, host: 'hostb', session_name: 'other', provider: 'codex', online: true };
const image = { uri: 'file://photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', width: 10, height: 12, bytes: 5 };
const envelope = 'pentacle-auth-v2:' + Buffer.from(JSON.stringify({ client_kind: 'pentacle-mobile', credential_id: '123e4567-e89b-12d3-a456-426614174000', proof_key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'), version: 2 })).toString('base64url');

function recording(id: string, images = false, streamId = originId, generation: string | null = null): FinishedRecording {
  return { streamId, recordingId: id, uri: `file://${id}.m4a`, mime: 'audio/mp4', durationS: 3, levels: [], interrupted: false,
    draft: { originGeneration: generation, originLabel: 'Origin', textPrefix: images ? 'Photo note' : '', images: images ? [image] : [] } };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function connect(sessions: Record<string, unknown>[] = [origin, other]) {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const { voiceDelivery } = require('../src/services/voiceDelivery') as typeof import('../src/services/voiceDelivery');
  stream.setPentacleAuthToken(envelope);
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'welcome', auth: { operator: { protocol_version: 2, scheme: 'hmac-sha256-v2', nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', expires_at: Date.now() / 1000 + 10 } } });
  socket.message({ type: 'snapshot', sessions, events: [] });
  const unfocus = stream.registerFocusedPentacleStream(originId);
  return { stream, voiceDelivery, socket, cleanup: () => { unfocus(); unsubscribe(); socket.close(); } };
}
function land(socket: MockWebSocket, frame: Record<string, any>) {
  socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed' });
}
function sparseEcho(socket: MockWebSocket, frame: Record<string, any>, seq: number) {
  socket.message({ type: 'chat.event', event: { stream_id: originId, session_kind: 'assistant_composite', daemon_seq: seq,
    timestamp: new Date().toISOString(), kind: 'USER', text: frame.message, optimistic_id: frame.msg_id, event_id: `echo-${seq}` } });
}
beforeEach(() => jest.useFakeTimers());

test.each([false, true])('sparse USER echo then repeated voice (image=%s) retains the canonical origin', async withImage => {
  const { stream, voiceDelivery, socket, cleanup } = connect();
  try {
    const first = voiceDelivery.accept(recording('first'));
    await flush();
    expect(socket.sends()).toHaveLength(1);
    expect(socket.sends()[0]).toMatchObject({ stream_id: originId, message: 'spoken detail', msg_id: expect.any(String) });
    land(socket, socket.sends()[0]);
    await first;
    sparseEcho(socket, socket.sends()[0], 1);
    // Prove the real sparse reducer precondition, rather than forging state.
    expect(stream.getPentacleStreamState().sessions.find(s => s.stream_id === originId)?.host).toBe('');
    const binding = require('../src/components/questions/voice/voiceAnswersBinding');
    binding.registerVoiceAnswersBinding('second', [{ key: 'n:0', question_id: 'q', notification_id: 'n', producer_stream_id: otherId, surface_stream_id: originId, prompt: 'Proceed?', segment: { start_s: 0, end_s: 2 } }]);
    const second = voiceDelivery.accept(recording('second', withImage));
    await flush();
    expect(socket.sends()).toHaveLength(2);
    const frame = socket.sends()[1];
    // Always settle the promise, including on the failing baseline.
    land(socket, frame);
    await second;
    expect(frame).toMatchObject({ stream_id: originId, msg_id: expect.any(String), message: withImage ? 'Photo note\nspoken detail' : 'spoken detail', meta: { voice: { duration_s: 3 }, voice_answers: { recording_id: 'second', blob_sha: 'audio-sha' } } });
    expect(frame).not.toHaveProperty('host');
    expect(frame.msg_id).not.toBe(socket.sends()[0].msg_id);
    if (withImage) expect(frame.attachments).toEqual([expect.objectContaining({ key: 'image-sha', mime: 'image/jpeg', width: 10, height: 12, bytes: 5 })]);
    else expect(frame.attachments).toBeUndefined();
    expect(voiceDelivery.snapshot().last?.label).toBe('Sent');
  } finally { cleanup(); }
});

test('ordinary voice and ordinary text preserve their existing route encoding', async () => {
  const { stream, voiceDelivery, socket, cleanup } = connect([other]);
  try {
    const voice = voiceDelivery.accept(recording('ordinary', false, otherId));
    await flush();
    const frame = socket.sends()[0];
    expect(frame).toMatchObject({ host: 'hostb', session_name: 'other', text: 'spoken detail', meta: { voice: { duration_s: 3 } } });
    expect(frame).not.toHaveProperty('stream_id');
    land(socket, frame); await voice;
    const text = stream.sendPentacleMessage({ host: 'hostb', sessionName: 'other', text: 'plain text' });
    expect(socket.sends()[1]).toMatchObject({ host: 'hostb', session_name: 'other', text: 'plain text' });
    expect(socket.sends()[1]).not.toHaveProperty('meta');
    land(socket, socket.sends()[1]); await text;
  } finally { cleanup(); }
});

test('navigation during transcription does not change the recorded origin', async () => {
  const { stream, voiceDelivery, socket, cleanup } = connect();
  let leaveOther = () => {};
  try {
    socket.beforeTranscript = () => { leaveOther = stream.registerFocusedPentacleStream(otherId); };
    const work = voiceDelivery.accept(recording('navigation'));
    await flush();
    expect(stream.__getFocusedPentacleStreamForTests()).toBe(otherId);
    expect(socket.sends()).toHaveLength(1);
    expect(socket.sends()[0]).toMatchObject({ stream_id: originId });
    land(socket, socket.sends()[0]); await work;
  } finally { leaveOther(); cleanup(); }
});

test.each(['missing', 'removed', 'replaced'])('%s origin refuses before dispatch and retains the take', async mode => {
  const original = { ...origin, session_generation: 'original' };
  const { voiceDelivery, socket, cleanup } = connect(mode === 'missing' ? [other] : [original, other]);
  try {
    if (mode !== 'missing') socket.beforeTranscript = () => socket.message({ type: 'session.inventory', sessions: mode === 'removed' ? [other] : [{ ...original, session_generation: 'replacement' }, other] });
    await voiceDelivery.accept(recording(`invalid-${mode}`, false, originId, 'original'));
    expect(socket.sends()).toHaveLength(0);
    expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'failed', error: 'Originating chat is unavailable or has been replaced.' });
    expect(require('expo-file-system/legacy').deleteAsync).not.toHaveBeenCalled();
  } finally { cleanup(); }
});

test.each(['removed', 'replaced'])('origin %s by an optimistic-state observer never dispatches elsewhere', async mode => {
  const { stream, voiceDelivery, socket, cleanup } = connect([{ ...origin, session_generation: 'original' }, other]);
  let changed = false;
  const stopObserving = stream.subscribePentacleStream(() => {
    if (!changed && Object.keys(stream.getPentacleStreamState().optimisticSends ?? {}).length) {
      changed = true;
      socket.message({ type: 'session.inventory', sessions: mode === 'removed' ? [other] : [{ ...origin, session_generation: 'replacement' }, other] });
    }
  });
  try {
    const work = voiceDelivery.accept(recording('observer', false, originId, 'original'));
    await flush();
    const sends = socket.sends();
    // Settle any baseline misroute so the assertion, not a timeout, is the RED.
    for (const frame of sends) land(socket, frame);
    await work;
    expect(changed).toBe(true);
    expect(sends).toHaveLength(0);
  } finally { stopObserving(); cleanup(); }
});

test('an ordinary origin with no host fails closed instead of emitting an empty target', async () => {
  const { voiceDelivery, socket, cleanup } = connect([{ ...other, host: '', session_name: '' }]);
  try {
    const work = voiceDelivery.accept(recording('unaddressable', false, otherId));
    await flush();
    const sends = socket.sends();
    for (const frame of sends) land(socket, frame);
    await work;
    expect(sends).toHaveLength(0);
  } finally { cleanup(); }
});
