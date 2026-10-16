import { uuid } from 'expo-modules-core';
import {
  VoiceRecorder,
  type FinishedRecording,
  type RecordingEngine,
  type VoicePermission,
} from '../../src/services/voiceRecording';

// A recorder wired to a fake engine whose clock is Date.now (jest fake timers), so the
// overlay's segment clock and the recorder's own duration agree in tests.
export class FakeEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  permission: VoicePermission = 'granted';
  startedAt = 0;
  accumulated = 0;
  paused = false;
  discarded = false;
  stopped = false;
  stopFails = false;
  async requestPermission() { return this.permission; }
  async getPermission() { return this.permission; }
  async start() { this.startedAt = Date.now(); this.accumulated = 0; this.paused = false; }
  async pause() { if (!this.paused) this.accumulated += Date.now() - this.startedAt; this.paused = true; }
  async resume() { this.startedAt = Date.now(); this.paused = false; }
  poll() { return { level: 0.5, durationMs: this.accumulated + (this.paused ? 0 : Date.now() - this.startedAt) }; }
  async stop() {
    if (this.stopFails) throw new Error('stop_failed');
    this.stopped = true;
    return { uri: 'file:///tmp/p6-take.m4a', durationMs: this.accumulated + (this.paused ? 0 : Date.now() - this.startedAt), bytes: 1000 };
  }
  async discard() { this.discarded = true; }
}

export function makeRecorderHarness() {
  jest.spyOn(uuid, 'v4').mockReturnValue('efbc042e-ce76-48fb-8dfc-2606f46243dc');
  const engine = new FakeEngine();
  const recorder = new VoiceRecorder(engine);
  const stopped: FinishedRecording[] = [];
  recorder.subscribeStopped((take) => { stopped.push(take); });
  return { engine, recorder, stopped };
}

// Shared synthetic OS/socket boundary for real composer -> recorder -> durable
// repository -> upload/transcription -> typed-receipt journeys. No subject mocked.
export function makeVoiceCaptureFsMock(onDelete?: (...args: any[]) => unknown) {
  const files = new Map<string, Buffer>(); const dirs = new Set<string>();
  return {
    __files: files, documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
    getInfoAsync: jest.fn(async (uri: string) => files.has(uri) ? { exists: true, isDirectory: false, size: files.get(uri)!.length, uri } : { exists: dirs.has(uri), isDirectory: dirs.has(uri), size: 0, uri }),
    readAsStringAsync: jest.fn(async (uri: string, options?: { encoding?: string; position?: number; length?: number }) => {
      const bytes = files.get(uri); if (!bytes) throw new Error('ENOENT');
      return options?.encoding === 'base64' ? bytes.subarray(options.position ?? 0, (options.position ?? 0) + (options.length ?? bytes.length)).toString('base64') : bytes.toString('utf8');
    }),
    writeAsStringAsync: jest.fn(async (uri: string, value: string) => { files.set(uri, Buffer.from(value)); }),
    makeDirectoryAsync: jest.fn(async (uri: string) => { for (let i = 8; i < uri.length; i++) if (uri[i] === '/') dirs.add(uri.slice(0, i + 1)); dirs.add(uri); }),
    readDirectoryAsync: jest.fn(async (uri: string) => [...new Set([...files.keys(), ...dirs].filter(key => key.startsWith(uri) && key !== uri).map(key => key.slice(uri.length).split('/')[0]))]),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => { if (!files.has(from)) throw new Error('ENOENT'); files.set(to, files.get(from)!); files.delete(from); }),
    copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => { if (!files.has(from)) throw new Error('ENOENT'); files.set(to, files.get(from)!); }),
    deleteAsync: jest.fn(async (uri: string, options?: unknown) => { onDelete?.(uri, options); for (const key of [...files.keys()]) if (key === uri || key.startsWith(uri.endsWith('/') ? uri : uri + '/')) files.delete(key); for (const key of [...dirs]) if (key === uri || key.startsWith(uri)) dirs.delete(key); }),
    getFreeDiskStorageAsync: jest.fn(async () => 1024 ** 3),
  };
}
export function makeNativeVoiceMock() {
  let next = 0;
  return {
    AudioModule: {
      AudioRecorder: jest.fn().mockImplementation(() => {
        const uri = `file:///cache/voice-${++next}.m4a`; let recording = false;
        const box = (kind: string, payload: string) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(kind, 4); b.write(payload, 8); return b; };
        require('expo-file-system/legacy').__files.set(uri, Buffer.concat([box('ftyp', 'M4A \0\0\0\0'), box('moov', 'synthetic'), box('mdat', 'audio')]));
        return { uri, get isRecording() { return recording; }, prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
          record: jest.fn(() => { recording = true; }), pause: jest.fn(() => { recording = false; }), stop: jest.fn(async () => { recording = false; }),
          getStatus: jest.fn(() => ({ isRecording: recording, durationMillis: 3000, metering: -20 })), addListener: jest.fn(() => ({ remove: jest.fn() })),
        };
      }),
      getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }), requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    },
    RecordingPresets: { HIGH_QUALITY: {} }, setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  };
}
export function makeVoiceTransportMock(state: () => any, transcribe: (...args: any[]) => any, send: (...args: any[]) => any) {
  const scope = { serverIdentity: 'wss://synthetic.invalid/ws', credentialId: '123e4567-e89b-12d3-a456-426614174000' };
  const uploads = new Map<string, { total: number; sha: string }>();
  const hash = (text: string) => require('crypto').createHash('sha256').update(text).digest('hex');
  const origins = () => (state()?.sessions ?? []).map((row: any) => ({ ...row, session_generation: row.session_generation ?? 'generation-1' }));
  const evidence = (intent: any, status: string) => ({ recordingId: intent.recordingId, requestId: intent.requestId, streamId: intent.streamId, generation: intent.originGeneration, source: 'send.result', state: status });
  // Lookup outcome for dispatched takes: unknown, or proven absent (daemon holds no receipt).
  let receiptAbsent = false;
  const dispatch = async (intent: any) => {
    const reply = await send({ streamId: intent.streamId, text: intent.payload.text, optimisticId: intent.optimisticId, originGeneration: intent.originGeneration, meta: intent.payload.meta, ...(intent.payload.attachments ? { attachments: intent.payload.attachments } : {}) });
    return evidence(intent, reply?.delivery === 'landed' ? 'landed' : 'unknown');
  };
  return {
    setVoiceReceiptAbsentForTests: (value: boolean) => { receiptAbsent = value; },
    validateVoiceDispatchIntent: jest.requireActual('../../src/services/pentacleStream').validateVoiceDispatchIntent,
    getPentacleStreamState: state,
    voiceTransportSnapshot: () => ({ ...scope, ready: !!state()?.connected, authNeeded: false, inventoryFresh: true, scopeGeneration: 1, socketGeneration: 1, origins: origins() }),
    voiceOriginStatus: (id: string, generation: string) => origins().find((row: any) => row.stream_id === id)?.session_generation === generation ? 'available' : 'unavailable',
    subscribeVoiceTransport: () => () => {}, subscribeVoiceSendEvidence: () => () => {},
    uploadVoiceBlobRpc: jest.fn(async (frame: any) => {
      if (frame.type === 'upload_blob_init') { uploads.set(frame.upload_id, { total: frame.total_bytes, sha: frame.sha256 }); return { protocol: 2, upload_id: frame.upload_id, next_offset: 0, complete: false }; }
      const upload = uploads.get(frame.upload_id)!;
      const offset = frame.offset + Buffer.from(frame.data_b64, 'base64').length;
      return { protocol: 2, upload_id: frame.upload_id, next_offset: offset, complete: frame.final, ...(frame.final ? { blob_sha: upload.sha } : {}) };
    }),
    prepareVoiceDispatchIntent: (args: any) => {
      const originalRequest = { protocol: 'voice-v1', logical_id: args.recordingId, target: args.streamId, generation: args.originGeneration, sequence: args.sequence };
      const requestId = 'voice-send-' + hash(JSON.stringify([args.recordingId, args.streamId, args.originGeneration, args.sequence])).slice(0, 40);
      const payload = { type: 'send', request_id: requestId, host: 'hosta', session_name: 'origin', text: args.text, optimistic_id: 'optimistic-voice', operation_id: args.recordingId, meta: args.meta, ...(args.attachments ? { attachments: args.attachments } : {}) };
      return { version: 1, ...scope, recordingId: args.recordingId, streamId: args.streamId, originGeneration: args.originGeneration, sequence: args.sequence, optimisticId: 'optimistic-voice', requestId, originalRequest, payload, payloadSha256: hash(JSON.stringify(payload)), createdAt: Date.now() };
    },
    hydrateVoiceDispatchIntent: jest.fn(), forgetVoiceDispatchIntent: jest.fn(),
    dispatchVoiceDispatchIntent: dispatch,
    redispatchVoiceDispatchIntent: dispatch,
    queryVoiceDispatchReceipt: async (intent: any) => ({ ...evidence(intent, 'unknown'), source: 'receipt', ...(receiptAbsent ? { absent: true } : {}) }),
    appendOptimisticUserMessage: jest.fn(() => 'optimistic-voice'), sendPentacleMessage: send,
    uploadBlobBase64: jest.fn().mockResolvedValue({ blob_sha: 'image-sha' }), transcribeBlob: transcribe,
    usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(state()), usePentacleStreamActions: () => ({}),
  };
}
