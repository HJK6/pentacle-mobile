import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fromByteArray, toByteArray } from 'base64-js';
// Type-only: adoption must not initialize the socket owner.
import type { VoiceTakeManifest, VoiceTakeStore, VoiceUploadProgress } from './voiceTakeStore';
import type { VoiceUploadAck, VoiceUploadRpc } from './pentacleStream';

export const VOICE_UPLOAD_CHUNK_BYTES=65536;
export async function readVoiceRange(uri:string,offset:number,length:number):Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > VOICE_UPLOAD_CHUNK_BYTES) throw Object.assign(new Error('invalid_audio_range'), {code:'invalid_audio_range'});
  const encoded=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64,position:offset,length});
  const bytes=toByteArray(encoded);
  if(bytes.length!==length) throw Object.assign(new Error('audio_changed'),{code:'audio_changed'});
  return bytes;
}
/** Bounded 64 KiB buffers; a five-minute take is never a whole-file base64 string. */
export async function inspectVoiceAudio(uri:string):Promise<{bytes:number;sha256:string}> {
  const info=await FileSystem.getInfoAsync(uri);
  if(!info.exists || info.isDirectory || !Number.isInteger(info.size) || info.size<1 || info.size>16*1024*1024) throw Object.assign(new Error('audio_unavailable'),{code:'audio_unavailable'});
  await validateVoiceContainer(uri,info.size);
  const digest=sha256.create();
  for(let offset=0;offset<info.size;offset+=VOICE_UPLOAD_CHUNK_BYTES) digest.update(await readVoiceRange(uri,offset,Math.min(VOICE_UPLOAD_CHUNK_BYTES,info.size-offset)));
  return {bytes:info.size,sha256:bytesToHex(digest.digest())};
}

/** Reject truncated native containers on recovery; not a claim of acoustic/device proof. */
export async function validateVoiceContainer(uri:string,size:number):Promise<void> {
  const fail=()=>{throw Object.assign(new Error('interrupted_recording'),{code:'interrupted_recording'});};
  if(size<12)return fail();
  const first=await readVoiceRange(uri,0,12);
  const ascii=(b:Uint8Array,start:number,end:number)=>String.fromCharCode(...b.slice(start,end));
  const u32=(b:Uint8Array,start:number,little=false)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(start,little);
  if(ascii(first,0,4)==='RIFF' && ascii(first,8,12)==='WAVE') {
    if(u32(first,4,true)+8!==size)return fail();
    let offset=12,format=false,data=false;
    while(offset+8<=size) {const header=await readVoiceRange(uri,offset,8);const length=u32(header,4,true);const kind=ascii(header,0,4);if(offset+8+length>size)return fail();if(kind==='fmt ' && length>=16)format=true;if(kind==='data' && length>0)data=true;offset+=8+length+(length%2);}
    if(offset!==size||!format||!data)return fail();return;
  }
  let offset=0,format=false,metadata=false,data=false;
  while(offset+8<=size) {
    const header=await readVoiceRange(uri,offset,Math.min(16,size-offset));
    let length=u32(header,0);const kind=ascii(header,4,8);let headerSize=8;
    if(length===1) {if(header.length<16)return fail();const high=u32(header,8),low=u32(header,12);length=high*4294967296+low;headerSize=16;}
    if(length===0)length=size-offset;
    if(!Number.isSafeInteger(length)||length<headerSize||offset+length>size)return fail();
    if(kind==='ftyp' && length>=16)format=true;if(kind==='moov' && length>headerSize)metadata=true;if(kind==='mdat' && length>headerSize)data=true;
    offset+=length;
  }
  if(offset!==size||!format||!metadata||!data)return fail();
}

export type VoiceUploadStore = Pick<VoiceTakeStore, 'get' | 'isCurrent' | 'audioUri' | 'checkpointUpload'>;
export type VoiceUploadIO = {
  readRange(uri: string, offset: number, length: number): Promise<Uint8Array>;
  rpc(fields: VoiceUploadRpc): Promise<VoiceUploadAck>;
};
export type VoiceUploadArgs = {
  take: VoiceTakeManifest;
  store: VoiceUploadStore;
  isCancelled?: () => boolean;
  io?: Partial<VoiceUploadIO>;
};
const uploadError = (code: string) => Object.assign(new Error(code), { code });
const defaultUploadIO: VoiceUploadIO = {
  readRange: readVoiceRange,
  // Static require keeps store/adoption independent of transport initialization.
  rpc: fields => (require('./pentacleStream') as typeof import('./pentacleStream')).uploadVoiceBlobRpc(fields),
};

/** Never trust an ACK until identity, raw-byte bounds and completion digest match. */
function validatedProgress(value: VoiceUploadAck, take: VoiceTakeManifest, minimum: number): VoiceUploadProgress {
  if (!value || value.protocol !== 2) throw uploadError('server_update_required');
  const audio = take.audio!;
  if (value.upload_id !== audio.uploadId || !Number.isInteger(value.next_offset)
      || value.next_offset < minimum || value.next_offset > audio.bytes
      || typeof value.complete !== 'boolean') throw uploadError('invalid_upload_ack');
  if (value.complete) {
    if (value.next_offset !== audio.bytes || value.blob_sha !== audio.sha256) throw uploadError('invalid_upload_ack');
    return { nextOffset: value.next_offset, complete: true, blobSha: value.blob_sha };
  }
  if (value.blob_sha !== undefined) throw uploadError('invalid_upload_ack');
  return { nextOffset: value.next_offset, complete: false };
}

/** One acknowledged raw-byte chunk in flight, with durable client progress before continuation. */
export async function runVoiceUpload(args: VoiceUploadArgs): Promise<{ blob_sha: string }> {
  const { take, store } = args;
  const { recordingId, epoch, audio } = take;
  const io = { ...defaultUploadIO, ...args.io };
  const guard = () => {
    if (args.isCancelled?.() || !store.isCurrent(recordingId, epoch)) throw uploadError('voice_cancelled');
    const current = store.get(recordingId);
    if (!current || current.scopeHash !== take.scopeHash) throw uploadError('voice_cancelled');
    if (JSON.stringify(current.audio) !== JSON.stringify(audio)) throw uploadError('audio_changed');
    return current;
  };
  let current = guard();
  if (!audio || current.sendRequestedAt === null || !['finalized', 'interrupted'].includes(current.storage)) throw uploadError('audio_unavailable');
  if (current.upload?.complete) {
    if (current.upload.blobSha !== audio.sha256 || current.upload.nextOffset !== audio.bytes) throw uploadError('invalid_upload_ack');
    return { blob_sha: current.upload.blobSha };
  }
  const uri = store.audioUri(take);
  const persist = async (ack: VoiceUploadAck, minimum: number) => {
    guard();
    const progress = validatedProgress(ack, take, minimum);
    await store.checkpointUpload(recordingId, progress);
    guard();
    return progress;
  };
  let restartedExpired = false;
  for (;;) {
    try {
      guard();
      const initial = await io.rpc({ type: 'upload_blob_init', protocol: 2, upload_id: audio.uploadId,
        total_bytes: audio.bytes, sha256: audio.sha256, mime: audio.mime, voice_operation: take.operation });
      guard();
      let progress = await persist(initial, 0);
      guard();
      // Re-init is always authoritative, even if a prior local checkpoint was ahead.
      while (!progress.complete) {
        const offset = progress.nextOffset;
        const length = Math.min(VOICE_UPLOAD_CHUNK_BYTES, audio.bytes - offset);
        const bytes = length ? await io.readRange(uri, offset, length) : new Uint8Array(0);
        guard();
        if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw uploadError('audio_changed');
        const ack = await io.rpc({ type: 'upload_blob_chunk', protocol: 2, upload_id: audio.uploadId,
          offset, data_b64: fromByteArray(bytes), chunk_sha256: bytesToHex(sha256(bytes)), final: length === 0 });
        guard();
        progress = await persist(ack, offset + length);
        guard();
        // An empty final that did not commit is a bad response, never a busy loop.
        if (length === 0 && !progress.complete) throw uploadError('invalid_upload_ack');
      }
      current = guard();
      if (!current.upload?.complete || current.upload.blobSha !== audio.sha256) throw uploadError('invalid_upload_ack');
      return { blob_sha: current.upload.blobSha };
    } catch (error) {
      guard();
      if (!restartedExpired && error && typeof error === 'object' && 'code' in error && error.code === 'upload_expired') {
        restartedExpired = true;
        continue;
      }
      throw error;
    }
  }
}
