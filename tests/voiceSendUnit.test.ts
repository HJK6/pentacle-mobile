jest.mock('../src/services/pentacleStream', () => ({ transcribeBlob: jest.fn() }));
jest.mock('../src/services/voiceUpload', () => ({ runVoiceUpload: jest.fn() }));
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { transcribeBlob } from '../src/services/pentacleStream';
import { runVoiceUpload, type VoiceUploadStore } from '../src/services/voiceUpload';
import type { VoiceTakeManifest } from '../src/services/voiceTakeStore';
import { runVoiceUploadTranscribe, voiceTranscribeFailureMessage, isEmptyTranscript, NOTHING_RECOGNIZED_MESSAGE, type VoiceUnitIO } from '../src/services/voiceSendUnit';

const ID = '123e4567-e89b-42d3-a456-000000000001';
const SHA = 'a'.repeat(64);
const RECORDING = { uri: 'file:///private/take.m4a', mime: 'audio/mp4', durationS: 6, bytes: 1234 };
const TAGS = { stream_id: 'hosta:synthetic', recording_id: ID };
function captureTelemetry() { const events: TelemetryPayload[] = []; setTelemetrySink(p => events.push(p)); return events; }
function fixture(overrides: Partial<VoiceUnitIO> = {}) {
  let current: VoiceTakeManifest | undefined = {
    version:1,scopeHash:'b'.repeat(64),recordingId:ID,createdAt:1000,sendRequestedAt:1001,epoch:0,storage:'finalized',
    origin:{streamId:TAGS.stream_id,generation:'generation-1',label:'Private origin'},draft:{textPrefix:'Private draft',images:[]},
    operation:{version:1,operation_id:ID,origin_stream_id:TAGS.stream_id,origin_generation:'generation-1',operation_kind:'voice_chat',client_build:'1.0 (1)'},
    audio:{path:'audio.m4a',bytes:1234,sha256:SHA,mime:'audio/mp4',uploadId:'123e4567-e89b-42d3-a456-000000000002'},
    capturedAudioMs:6000,levels:[],delivery:{phase:'queued',retryCount:0,retryAt:null},sequence:1,
  };
  const take = current;
  const store: VoiceUploadStore = {
    get: () => current, isCurrent: (_id,epoch) => !!current && current.epoch===epoch,
    audioUri: () => RECORDING.uri,
    checkpointUpload: jest.fn(async (_id,progress) => { current={...current!,upload:progress}; return current; }),
  };
  const upload = jest.fn(async () => { await store.checkpointUpload(ID,{nextOffset:1234,complete:true,blobSha:SHA}); return {blob_sha:SHA}; });
  const io: VoiceUnitIO = { upload, transcribe: jest.fn(async () => ({text:'Hey Juniper',duration_s:6,model:'large-v3',vocabulary_version:'fleet-v3'})), ...overrides };
  return { recording:RECORDING,take,store,tags:TAGS,io, get:()=>current!, cancel:()=>{current=undefined;}, mutate:(fields:Partial<VoiceTakeManifest>)=>{current={...current!,...fields};} };
}
afterEach(() => { setTelemetrySink(null); jest.clearAllMocks(); });

test('U3 happy path durably uploads, sends exact operation metadata and stable ASR identity', async () => {
  const events=captureTelemetry();const f=fixture();const stages:string[]=[];
  const result=await runVoiceUploadTranscribe({...f,onStage:async stage=>{stages.push(stage);}});
  expect(result).toMatchObject({blobSha:SHA,transcript:{text:'Hey Juniper'}});
  expect(f.io.upload).toHaveBeenCalledWith({take:f.take,store:f.store,isCancelled:undefined});
  expect(f.io.transcribe).toHaveBeenCalledWith(SHA,'audio/mp4',{requestId:`transcribe-${ID}`,voiceOperation:f.take.operation,isCancelled:expect.any(Function)});
  expect(stages).toEqual(['uploading','transcribing']);
  expect(events.map(e=>[e.data.stage,e.data.state])).toEqual([['upload','complete'],['transcribe','complete']]);
  expect(events.every(e=>e.subsystem==='voice_delivery' && e.data.bug_ref==='continuous_voice')).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/Hey Juniper|Private|file:\/|large-v3|fleet-v3|hosta:/);
});

test('U3 default IO uses acknowledged voice upload and never a whole-file base64 upload path', async () => {
  const f=fixture();
  (runVoiceUpload as jest.Mock).mockImplementation(f.io.upload);
  (transcribeBlob as jest.Mock).mockImplementation(f.io.transcribe);
  await runVoiceUploadTranscribe({...f,io:undefined});
  expect(runVoiceUpload).toHaveBeenCalledWith({take:f.take,store:f.store,isCancelled:undefined});
  expect(transcribeBlob).toHaveBeenCalledTimes(1);
});

test('U3 upload transport failure preserves typed queue reason and never transcribes', async () => {
  const events=captureTelemetry();const err=Object.assign(new Error('Private socket URI must not leak'),{code:'disconnected'});
  const f=fixture({upload:jest.fn(async()=>{throw err;})});
  await expect(runVoiceUploadTranscribe(f)).rejects.toBe(err);
  expect(f.io.transcribe).not.toHaveBeenCalled();
  expect(events.map(e=>e.data)).toEqual([expect.objectContaining({stage:'upload',state:'failed',error:'disconnected'})]);
  expect(JSON.stringify(events)).not.toMatch(/Private|URI/);
});

test('U3 upload domain rejection remains distinct and never falls back to legacy upload', async () => {
  const err=Object.assign(new Error('server_update_required'),{code:'server_update_required'});
  const f=fixture({upload:jest.fn(async()=>{throw err;})});
  await expect(runVoiceUploadTranscribe(f)).rejects.toBe(err);expect(f.io.upload).toHaveBeenCalledTimes(1);expect(f.io.transcribe).not.toHaveBeenCalled();
});

test('U3 uncheckpointed successful upload cannot start transcription', async () => {
  const f=fixture({upload:jest.fn(async()=>({blob_sha:SHA}))});
  await expect(runVoiceUploadTranscribe(f)).rejects.toMatchObject({code:'invalid_upload_ack'});expect(f.io.transcribe).not.toHaveBeenCalled();
});

test('U3 durable successful transcript is reused without upload, transcription or phase transitions', async () => {
  const f=fixture();f.mutate({upload:{nextOffset:1234,complete:true,blobSha:SHA},transcription:{blobSha:SHA,requestId:`transcribe-${ID}`,result:{text:'Cached transcript'}}});
  const onStage=jest.fn(async()=>undefined);
  await expect(runVoiceUploadTranscribe({...f,take:f.get(),onStage})).resolves.toEqual({blobSha:SHA,transcript:{text:'Cached transcript'}});
  expect(f.io.upload).not.toHaveBeenCalled();expect(f.io.transcribe).not.toHaveBeenCalled();expect(onStage).not.toHaveBeenCalled();
});

test('U3 durable blob without transcript skips the uploading phase and uses same blob/MIME/ASR ID', async () => {
  const f=fixture();f.mutate({upload:{nextOffset:1234,complete:true,blobSha:SHA}});
  const onStage=jest.fn(async()=>undefined);
  await runVoiceUploadTranscribe({...f,take:f.get(),onStage});
  expect(onStage).toHaveBeenCalledTimes(1);expect(onStage).toHaveBeenCalledWith('transcribing');
  expect(f.io.transcribe).toHaveBeenCalledWith(SHA,'audio/mp4',expect.objectContaining({requestId:`transcribe-${ID}`}));
});

test('U3 transcription failure is retained and telemetry error is allowlisted', async () => {
  const events=captureTelemetry();const err=Object.assign(new Error('backend down'),{code:'backend_unavailable'});
  const f=fixture({transcribe:jest.fn(async()=>{throw err;})});
  await expect(runVoiceUploadTranscribe(f)).rejects.toBe(err);
  expect(events.at(-1)?.data).toMatchObject({stage:'transcribe',state:'failed',error:'backend_unavailable'});
  expect(f.get().audio).toEqual(f.take.audio);expect(f.get().upload?.complete).toBe(true);
});

test('U3 untrusted server error strings never enter lifecycle telemetry', async () => {
  const events=captureTelemetry();const f=fixture({transcribe:jest.fn(async()=>{throw Object.assign(new Error('private'),{code:'file:///private secret transcript'});})});
  await expect(runVoiceUploadTranscribe(f)).rejects.toThrow('private');
  expect(events.at(-1)?.data.error).toBe('transcribe_failed');expect(JSON.stringify(events)).not.toMatch(/private|secret|transcript/);
});

test.each(['upload','transcribe','uploading','transcribing'])('U3 cancellation during awaited %s prevents remaining work', async stage => {
  const f=fixture();const upload=f.io.upload,transcribe=f.io.transcribe;
  if(stage==='upload')f.io.upload=async args=>{const result=await upload(args);f.cancel();return result;};
  if(stage==='transcribe')f.io.transcribe=async(...args)=>{const result=await transcribe(...args);f.cancel();return result;};
  const onStage=async(value:string)=>{if(stage===value)f.cancel();};
  await expect(runVoiceUploadTranscribe({...f,onStage})).rejects.toMatchObject({code:'voice_cancelled'});
  if(stage!=='transcribe')expect(transcribe).not.toHaveBeenCalled();
});

test('U3 scope switch during transcribe is observable to transport cancellation guard', async () => {
  const f=fixture(); f.io.transcribe=jest.fn(async(_sha,_mime,options)=>{f.mutate({scopeHash:'c'.repeat(64)});expect(options.isCancelled?.()).toBe(true);return{text:'late response'};});
  await expect(runVoiceUploadTranscribe(f)).rejects.toMatchObject({code:'voice_cancelled'});
});

test('U3 arbitrary transcription request ID is refused before upload', async () => {
  const f=fixture();await expect(runVoiceUploadTranscribe({...f,transcribeRequestId:'new-id'})).rejects.toMatchObject({code:'invalid_transcribe_id'});expect(f.io.upload).not.toHaveBeenCalled();
});

test('voiceTranscribeFailureMessage maps domain failures and keeps lost-server-blob wording honest', () => {
  const mk=(code:string)=>Object.assign(new Error(code),{code});
  expect(voiceTranscribeFailureMessage(mk('backend_unavailable'))).toMatch(/unavailable/i);
  expect(voiceTranscribeFailureMessage(mk('too_long'))).toMatch(/too long/i);
  expect(voiceTranscribeFailureMessage(mk('mime_unsupported'))).toMatch(/format/i);
  expect(voiceTranscribeFailureMessage(mk('blob_unknown'))).toMatch(/retained/i);
  expect(voiceTranscribeFailureMessage(mk('server_update_required'))).toBe('Server update required');
  expect(voiceTranscribeFailureMessage(new Error('other'))).toMatch(/failed/i);
});

test('empty transcript remains an actionable retained result', async () => {
  const f=fixture({transcribe:jest.fn(async()=>({text:'  '}))});const result=await runVoiceUploadTranscribe(f);
  expect(isEmptyTranscript(result.transcript)).toBe(true);expect(f.get().audio).toEqual(f.take.audio);
  expect(isEmptyTranscript({text:'Host A'})).toBe(false);expect(NOTHING_RECOGNIZED_MESSAGE).toMatch(/nothing/i);
});
