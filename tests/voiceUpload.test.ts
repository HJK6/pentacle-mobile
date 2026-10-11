jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' }, readAsStringAsync: jest.fn(), getInfoAsync: jest.fn(),
}));
import * as FileSystem from 'expo-file-system/legacy';
import { fromByteArray, toByteArray } from 'base64-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { inspectVoiceAudio, readVoiceRange, runVoiceUpload, validateVoiceContainer, VOICE_UPLOAD_CHUNK_BYTES, type VoiceUploadIO, type VoiceUploadStore } from '../src/services/voiceUpload';
import type { VoiceTakeManifest } from '../src/services/voiceTakeStore';
import type { VoiceUploadAck, VoiceUploadRpc } from '../src/services/pentacleStream';

const RECORDING_ID = '123e4567-e89b-42d3-a456-000000000001';
const UPLOAD_ID = '123e4567-e89b-42d3-a456-000000000002';
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const error = (code: string) => Object.assign(new Error(code), { code });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(size = 2 * VOICE_UPLOAD_CHUNK_BYTES + 17) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  let current: VoiceTakeManifest | undefined = {
    version: 1, scopeHash: 'a'.repeat(64), recordingId: RECORDING_ID, createdAt: 1000,
    sendRequestedAt: 1001, epoch: 0, storage: 'finalized', capturedAudioMs: 6000, levels: [],
    origin: { streamId: 'hosta:synthetic', generation: 'generation-1', label: 'Private target' },
    draft: { textPrefix: 'Private text', images: [] }, sequence: 1,
    operation: { version: 1, operation_id: RECORDING_ID, origin_stream_id: 'hosta:synthetic', origin_generation: 'generation-1', operation_kind: 'voice_chat', client_build: '1.0 (1)' },
    delivery: { phase: 'queued', retryCount: 0, retryAt: null },
    audio: { path: 'audio.m4a', bytes: size, sha256: digest(bytes), mime: 'audio/mp4', uploadId: UPLOAD_ID },
  };
  const take = current;
  let accepted = 0;
  let complete = false;
  const events: string[] = [];
  const store: VoiceUploadStore = {
    get: jest.fn(() => current), isCurrent: jest.fn((id, epoch) => !!current && current.recordingId === id && current.epoch === epoch),
    audioUri: jest.fn(() => 'file:///documents/owned/audio.m4a'),
    checkpointUpload: jest.fn(async (_id, progress) => { events.push(`persist:${progress.nextOffset}:${progress.complete}`); current = { ...current!, upload: progress }; return current; }),
  };
  const ack = (): VoiceUploadAck => ({ protocol: 2, upload_id: UPLOAD_ID, next_offset: accepted, complete, ...(complete ? { blob_sha: take.audio!.sha256 } : {}) });
  const rpc = jest.fn(async (fields: VoiceUploadRpc): Promise<VoiceUploadAck> => {
    events.push(fields.type === 'upload_blob_init' ? 'init' : `chunk:${fields.offset}:${fields.final}`);
    if (fields.type === 'upload_blob_init') return ack();
    const raw = toByteArray(fields.data_b64);
    expect(raw.length).toBeLessThanOrEqual(VOICE_UPLOAD_CHUNK_BYTES);
    expect(fields.chunk_sha256).toBe(digest(raw));
    expect(raw.every((value, index) => value === bytes[fields.offset + index])).toBe(true);
    if (fields.offset > accepted) throw error('offset_mismatch');
    if (fields.offset === accepted) accepted += raw.length;
    if (fields.final) { expect(accepted).toBe(size); complete = true; }
    return ack();
  });
  const readRange = jest.fn(async (_uri: string, offset: number, length: number) => { events.push(`read:${offset}`); return bytes.slice(offset, offset + length); });
  const io: VoiceUploadIO = { rpc, readRange };
  return { take, store, io, bytes, rpc, readRange, events, ack,
    get: () => current!, cancel: () => { current = undefined; },
    mutate: (fields: Partial<VoiceTakeManifest>) => { current = { ...current!, ...fields }; },
    accept: (offset: number, done = false) => { accepted = offset; complete = done; },
  };
}

test('U3 raw chunks are bounded, single in flight and each ACK is persisted before next read/final', async () => {
  const f = fixture();
  await expect(runVoiceUpload(f)).resolves.toEqual({ blob_sha: f.take.audio!.sha256 });
  expect(f.events).toEqual(['init', 'persist:0:false', 'read:0', 'chunk:0:false', 'persist:65536:false',
    'read:65536', 'chunk:65536:false', 'persist:131072:false', 'read:131072', 'chunk:131072:false',
    'persist:131089:false', 'chunk:131089:true', 'persist:131089:true']);
  expect(f.rpc.mock.calls[0][0]).toEqual({ type: 'upload_blob_init', protocol: 2, upload_id: UPLOAD_ID,
    total_bytes: f.bytes.length, sha256: f.take.audio!.sha256, mime: 'audio/mp4', voice_operation: f.take.operation });
  expect(Object.keys((f.rpc.mock.calls[0][0] as any).voice_operation)).toHaveLength(6);
  expect(f.readRange.mock.calls.every(call => call[2] <= 65536)).toBe(true);
});

test('U3 no next chunk is read or sent while a progress manifest checkpoint is pending', async () => {
  const f = fixture(); const saved = f.store.checkpointUpload; const gate = deferred<void>();
  f.store.checkpointUpload = jest.fn(async (id, progress) => { if (progress.nextOffset === 65536) await gate.promise; return saved(id, progress); });
  const work = runVoiceUpload(f);
  while (!(f.store.checkpointUpload as jest.Mock).mock.calls.some(call => call[1].nextOffset === 65536)) await Promise.resolve();
  expect(f.readRange).toHaveBeenCalledTimes(1); expect(f.rpc).toHaveBeenCalledTimes(2);
  gate.resolve(); await work;
});

test('U3 next invocation re-inits after lost chunk ACK and follows server raw offset without resending', async () => {
  const f = fixture(); const rpc = f.io.rpc; let lost = false;
  f.io.rpc = jest.fn(async fields => { const ack = await rpc(fields); if (!lost && fields.type === 'upload_blob_chunk') { lost = true; throw error('timeout'); } return ack; });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'timeout' });
  expect(f.get().upload?.nextOffset).toBe(0);
  await runVoiceUpload({ ...f, take: f.get() });
  expect(f.readRange.mock.calls.map(call => call[1])).toEqual([0, 65536, 131072]);
  expect(f.rpc.mock.calls.filter(call => call[0].type === 'upload_blob_init')).toHaveLength(2);
});

test('U3 lost final ACK resumes the server complete receipt, with no audio reread or duplicate final', async () => {
  const f = fixture(32); const rpc = f.io.rpc;
  f.io.rpc = jest.fn(async fields => { const ack = await rpc(fields); if (fields.type === 'upload_blob_chunk' && fields.final) throw error('disconnected'); return ack; });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'disconnected' });
  expect(f.get().upload).toMatchObject({ nextOffset: 32, complete: false });
  await expect(runVoiceUpload({ ...f, take: f.get() })).resolves.toEqual({ blob_sha: f.take.audio!.sha256 });
  expect(f.readRange).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.filter(call => call[0].type === 'upload_blob_chunk' && call[0].final)).toHaveLength(1);
});

test('U3 duplicated committed server data ACK can advance past the resent chunk safely', async () => {
  const f = fixture(); let calls = 0; const rpc = f.io.rpc;
  f.io.rpc = async fields => {
    if (fields.type === 'upload_blob_init') { calls++; return { ...f.ack(), next_offset: 0 }; }
    if (fields.type === 'upload_blob_chunk' && fields.offset === 0) f.accept(131072);
    return rpc(fields);
  };
  await runVoiceUpload(f);
  expect(calls).toBe(1); expect(f.readRange.mock.calls.map(c => c[1])).toEqual([0,131072]);
});

test('U3 failed local checkpoint stops before continuation and next init obtains server truth', async () => {
  const f = fixture(); const persist = f.store.checkpointUpload; let failed = false;
  f.store.checkpointUpload = jest.fn(async (id, progress) => { if (!failed && progress.nextOffset === 65536) { failed = true; throw error('storage_write_failed'); } return persist(id, progress); });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'storage_write_failed' });
  expect(f.readRange).toHaveBeenCalledTimes(1); expect(f.get().upload?.nextOffset).toBe(0);
  await runVoiceUpload({ ...f, take: f.get() });
  expect(f.readRange.mock.calls.map(call => call[1])).toEqual([0,65536,131072]);
});

test('U3 complete local checkpoint skips all transport and reads', async () => {
  const f = fixture(); f.mutate({ upload: { nextOffset: f.bytes.length, complete: true, blobSha: f.take.audio!.sha256 } });
  await runVoiceUpload({ ...f, take: f.get() }); expect(f.rpc).not.toHaveBeenCalled(); expect(f.readRange).not.toHaveBeenCalled();
});

test.each([undefined, {}, { protocol: 1 }, true])('U3 unsupported server response %p retains update-required without v1 fallback', async value => {
  const f = fixture(); f.io.rpc = jest.fn(async () => value as VoiceUploadAck);
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'server_update_required' });
  expect(f.io.rpc).toHaveBeenCalledTimes(1); expect(f.readRange).not.toHaveBeenCalled(); expect(f.get().upload).toBeUndefined();
});

test.each([
  { upload_id: 'different' }, { next_offset: -1 }, { next_offset: 99999999 }, { next_offset: 1.5 },
  { complete: 'yes' }, { complete: true }, { blob_sha: 'a'.repeat(64) },
])('U3 rejects malformed ACK %p before persisting', async bad => {
  const f = fixture(); f.io.rpc = async () => ({ ...f.ack(), ...bad }) as VoiceUploadAck;
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'invalid_upload_ack' });
  expect(f.store.checkpointUpload).not.toHaveBeenCalled(); expect(f.readRange).not.toHaveBeenCalled();
});

test('U3 nonadvancing intermediate ACK stops instead of looping', async () => {
  const f = fixture(); f.io.rpc = async () => f.ack();
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'invalid_upload_ack' });
  expect(f.readRange).toHaveBeenCalledTimes(1);
});

test('U3 a noncomplete empty-final ACK stops instead of looping', async () => {
  const f = fixture(5); f.accept(5); f.io.rpc = jest.fn(async () => f.ack());
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'invalid_upload_ack' });
  expect(f.io.rpc).toHaveBeenCalledTimes(2); expect(f.readRange).not.toHaveBeenCalled();
});

test('U3 expired upload permits one stable-ID re-init from server zero', async () => {
  const f = fixture(5); const rpc = f.io.rpc; let expired = false;
  f.mutate({ upload: { nextOffset: 4, complete: false } });
  f.io.rpc = jest.fn(async fields => { if (!expired) { expired = true; throw error('upload_expired'); } return rpc(fields); });
  await runVoiceUpload({ ...f, take: f.get() });
  expect((f.io.rpc as jest.Mock).mock.calls.slice(0,2).map(call => call[0].upload_id)).toEqual([UPLOAD_ID,UPLOAD_ID]);
  expect(f.readRange.mock.calls[0][1]).toBe(0);
});

test('U3 repeated expiry is a bounded error, never a busy loop', async () => {
  const f = fixture(); f.io.rpc = jest.fn(async () => { throw error('upload_expired'); });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'upload_expired' }); expect(f.io.rpc).toHaveBeenCalledTimes(2);
});

test.each(['init', 'read', 'ack', 'checkpoint'])('U3 discard during awaited %s prevents subsequent network/checkpoint work', async stage => {
  const f = fixture(); const rpc = f.io.rpc, read = f.io.readRange, persist = f.store.checkpointUpload;
  if (stage === 'init' || stage === 'ack') f.io.rpc = async fields => { const ack = await rpc(fields); if ((stage === 'init') === (fields.type === 'upload_blob_init')) f.cancel(); return ack; };
  if (stage === 'read') f.io.readRange = async (...args) => { const data = await read(...args); f.cancel(); return data; };
  if (stage === 'checkpoint') f.store.checkpointUpload = async (...args) => { const result = await persist(...args); f.cancel(); return result; };
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'voice_cancelled' });
  expect(f.rpc.mock.calls.filter(call => call[0].type === 'upload_blob_chunk')).toHaveLength(stage === 'ack' ? 1 : 0);
});

test('U3 cancellation/scope loss from caller after file read sends no old-identity bytes', async () => {
  const f = fixture(); let cancelled = false;
  f.io.readRange = async () => { cancelled = true; return f.bytes.slice(0,65536); };
  await expect(runVoiceUpload({ ...f, isCancelled: () => cancelled })).rejects.toMatchObject({ code: 'voice_cancelled' });
  expect(f.rpc).toHaveBeenCalledTimes(1);
});

test('U3 epoch changed without missing manifest cancels immediately', async () => {
  const f = fixture(); f.mutate({ epoch: 1 });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'voice_cancelled' }); expect(f.rpc).not.toHaveBeenCalled();
});

test('U3 short audio read and changed adopted metadata cannot reach chunk transport', async () => {
  const f = fixture(); f.io.readRange = async () => new Uint8Array(1);
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'audio_changed' }); expect(f.rpc).toHaveBeenCalledTimes(1);
  f.mutate({ audio: { ...f.take.audio!, sha256: 'b'.repeat(64) } });
  await expect(runVoiceUpload(f)).rejects.toMatchObject({ code: 'audio_changed' });
});

function file(bytes: Uint8Array) {
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: bytes.length });
  (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async (_uri, options) => fromByteArray(bytes.slice(options.position, options.position + options.length)));
}
function atom(kind: string, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.length); new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set([...kind].map(c => c.charCodeAt(0)),4); bytes.set(payload,8); return bytes;
}
function joined(...parts: Uint8Array[]) { const b = new Uint8Array(parts.reduce((n,p) => n+p.length,0)); let offset = 0; for (const part of parts) { b.set(part,offset); offset+=part.length; } return b; }
function m4a() { return joined(atom('ftyp',new Uint8Array(8)),atom('mdat',new Uint8Array(131101)),atom('moov',new Uint8Array(12))); }
function wav() {
  const bytes = new Uint8Array(48); const view = new DataView(bytes.buffer);
  for (const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const) bytes.set([...text].map(c=>c.charCodeAt(0)),offset);
  view.setUint32(4,40,true); view.setUint32(16,16,true); view.setUint32(40,4,true); return bytes;
}
beforeEach(() => { jest.clearAllMocks(); });

test('U1/U3 streaming inspection hashes valid finalized M4A with bounded range reads only', async () => {
  const bytes = m4a(); file(bytes);
  await expect(inspectVoiceAudio('file:///synthetic.m4a')).resolves.toEqual({ bytes: bytes.length, sha256: digest(bytes) });
  expect((FileSystem.readAsStringAsync as jest.Mock).mock.calls.every(call => call[1].length <= 65536 && call[1].position >= 0)).toBe(true);
});

test('U1/U3 WAV container passes complete framing and hashes correctly', async () => {
  const bytes = wav(); file(bytes); await expect(inspectVoiceAudio('file:///synthetic.wav')).resolves.toEqual({ bytes: bytes.length, sha256: digest(bytes) });
});

test.each(['m4a-tail', 'm4a-metadata', 'wav-data', 'wav-trailer', 'wav-size'])('U1/U3 truncated or malformed %s cannot be adopted/recovered', async kind => {
  let bytes: Uint8Array;
  if (kind === 'm4a-tail') bytes = m4a().slice(0,-1);
  else if (kind === 'm4a-metadata') bytes = joined(atom('ftyp',new Uint8Array(8)),atom('mdat',new Uint8Array(6)));
  else if (kind === 'wav-data') bytes = wav().slice(0,-1);
  else if (kind === 'wav-trailer') { bytes = joined(wav(),new Uint8Array(1)); new DataView(bytes.buffer).setUint32(4,bytes.length-8,true); }
  else { bytes = wav(); new DataView(bytes.buffer).setUint32(4,32,true); }
  file(bytes); await expect(validateVoiceContainer('file:///synthetic',bytes.length)).rejects.toMatchObject({ code: 'interrupted_recording' });
});

test('U1/U3 oversized, missing and zero-byte audio is rejected before any range read', async () => {
  for (const info of [{ exists:false }, { exists:true,isDirectory:false,size:0 }, { exists:true,isDirectory:false,size:16*1024*1024+1 }]) {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue(info);
    await expect(inspectVoiceAudio('file:///synthetic')).rejects.toMatchObject({ code: 'audio_unavailable' });
  }
  expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
});

test('U1/U3 range reader refuses unbounded and malformed ranges and rejects truncated reads', async () => {
  for (const [offset,length] of [[-1,5],[0,65537],[0,0],[0,1.5]]) await expect(readVoiceRange('file:///synthetic',offset,length)).rejects.toMatchObject({ code:'invalid_audio_range' });
  file(new Uint8Array(1)); await expect(readVoiceRange('file:///synthetic',0,2)).rejects.toMatchObject({ code:'audio_changed' });
});

test('U3 exact full-chunk boundary uses one empty final at total with SHA256(empty)', async () => {
  const f=fixture(65536);await runVoiceUpload(f);
  const final=f.rpc.mock.calls.at(-1)![0];
  expect(final).toEqual({type:'upload_blob_chunk',protocol:2,upload_id:UPLOAD_ID,offset:65536,data_b64:'',chunk_sha256:digest(new Uint8Array(0)),final:true});
  expect(f.readRange).toHaveBeenCalledTimes(1);
});

test('U3 server checkpoint behind local offset is authoritative after restart', async () => {
  const f=fixture();f.mutate({upload:{nextOffset:65536,complete:false}});
  await runVoiceUpload({...f,take:f.get()});
  expect(f.events.slice(0,3)).toEqual(['init','persist:0:false','read:0']);
});

test('U3 slow RPC never causes parallel chunks or speculative file reads', async () => {
  const f=fixture();const rpc=f.io.rpc;const gate=deferred<void>();let waiting=false;
  f.io.rpc=async fields=>{if(fields.type==='upload_blob_chunk' && fields.offset===0){waiting=true;await gate.promise;}return rpc(fields);};
  const work=runVoiceUpload(f);while(!waiting)await Promise.resolve();
  expect(f.readRange).toHaveBeenCalledTimes(1);expect(f.rpc).toHaveBeenCalledTimes(1);
  gate.resolve();await work;
});

test('U3 final receipt must be checkpointed before upload resolves, and failure remains resumable', async () => {
  const f=fixture(10);const persist=f.store.checkpointUpload;let failed=false;
  f.store.checkpointUpload=async(id,progress)=>{if(progress.complete && !failed){failed=true;throw error('storage_write_failed');}return persist(id,progress);};
  await expect(runVoiceUpload(f)).rejects.toMatchObject({code:'storage_write_failed'});
  expect(f.get().upload?.complete).toBe(false);
  await expect(runVoiceUpload({...f,take:f.get()})).resolves.toEqual({blob_sha:f.take.audio!.sha256});
  expect(f.readRange).toHaveBeenCalledTimes(1);
});

test('U3 unsent/capped work and already-cancelled callbacks never start upload', async () => {
  const f=fixture();f.mutate({sendRequestedAt:null});
  await expect(runVoiceUpload({...f,take:f.get()})).rejects.toMatchObject({code:'audio_unavailable'});
  f.mutate({sendRequestedAt:1001});
  await expect(runVoiceUpload({...f,take:f.get(),isCancelled:()=>true})).rejects.toMatchObject({code:'voice_cancelled'});
  expect(f.rpc).not.toHaveBeenCalled();
});
