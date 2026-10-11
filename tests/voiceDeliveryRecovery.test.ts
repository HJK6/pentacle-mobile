jest.mock('../src/services/attachmentUpload', () => ({
  ...jest.requireActual('../src/services/attachmentUpload'),
  readAttachmentBase64: jest.fn(),
}));
// Durable delivery tests use real manifests/atomic operations and deterministic IO.
// Only the native filesystem and socket boundaries are synthetic.
jest.mock('../src/services/pentacleStream', () => ({
  ...jest.requireActual('../src/services/pentacleStream'),
  uploadVoiceImageBase64: jest.fn(async () => ({ blob_sha: 'synthetic-image-sha' })),
  subscribeVoiceTransport: () => () => {},
  subscribeVoiceSendEvidence: () => () => {},
  voiceTransportSnapshot: () => ({
    serverIdentity: 'wss://synthetic.invalid/ws',
    credentialId: '123e4567-e89b-12d3-a456-426614174000',
    ready: false,
    inventoryFresh: false,
    authNeeded: false,
    scopeGeneration: 1,
    socketGeneration: 1,
    origins: [],
  }),
}));
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  VoiceDelivery,
  voiceDelivery as defaultVoiceDelivery,
  type VoiceDeliveryIO,
} from '../src/services/voiceDelivery';
import {
  VoiceTakeStore,
  type VoiceTakeIO,
  type VoiceTakeManifest,
} from '../src/services/voiceTakeStore';
import { readAttachmentBase64 } from '../src/services/attachmentUpload';
import { uploadVoiceImageBase64 } from '../src/services/pentacleStream';
import {
  startVoiceQuestionSession,
  freezeVoiceQuestionAnswers,
  voiceQuestionSnapshot,
  voiceAnswersItemCount,
  resetVoiceAnswersForTests,
} from '../src/components/questions/voice/voiceAnswersBinding';
import type { VoiceDispatchIntent, VoiceSendEvidence } from '../src/services/pentacleStream';

const hash = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));
const SCOPE = {
  serverIdentity: 'wss://synthetic.invalid/ws',
  credentialId: '123e4567-e89b-12d3-a456-426614174000',
};
const ORIGIN = {
  streamId: 'hosta:origin',
  generation: 'generation-1',
  label: 'Synthetic origin',
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}
function harness() {
  let next = 0,
    now = 1000,
    transportListener = () => {};
  let evidenceListener: (proof: VoiceSendEvidence) => void = () => {};
  const files = new Map<string, string>(),
    dirs = new Set<string>(),
    calls: string[] = [];
  const disk: VoiceTakeIO = {
    root: 'file:///documents/voice-takes-v1/',
    cacheRoot: 'file:///cache/',
    now: () => now,
    uuid: () => `123e4567-e89b-42d3-a456-${String(++next).padStart(12, '0')}`,
    stat: async (p) => ({
      exists: files.has(p) || dirs.has(p),
      size: files.get(p)?.length ?? 0,
      directory: dirs.has(p),
    }),
    list: async (p) => [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((k) => k.startsWith(p) && k !== p)
          .map((k) => k.slice(p.length).split('/')[0]),
      ),
    ],
    mkdir: async (p) => {
      for (let i = 8; i < p.length; i++) if (p[i] === '/') dirs.add(p.slice(0, i + 1));
      dirs.add(p);
    },
    read: async (p) => {
      if (!files.has(p)) throw Error('ENOENT');
      return files.get(p)!;
    },
    write: async (p, t) => {
      calls.push('write');
      files.set(p, t);
    },
    move: async (a, b) => {
      calls.push('move');
      if (!files.has(a)) throw Error('ENOENT');
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    copy: async (a, b) => {
      files.set(b, files.get(a)!);
    },
    remove: async (p) => {
      calls.push('remove');
      for (const k of [...files.keys()])
        if (k === p || k.startsWith(p.endsWith('/') ? p : p + '/')) files.delete(k);
      for (const k of [...dirs]) if (k === p || k.startsWith(p)) dirs.delete(k);
    },
    free: async () => 1024 * 1024 * 1024,
    inspect: async (p) => {
      const value = files.get(p);
      if (!value) throw Error('missing');
      return { bytes: value.length, sha256: hash(value) };
    },
  };
  let store = new VoiceTakeStore(disk);
  const transport = {
    ...SCOPE,
    ready: true,
    inventoryFresh: true,
    authNeeded: false,
    scopeGeneration: 1,
    socketGeneration: 1,
    origins: [],
  };
  const proofs = (
    intent: VoiceDispatchIntent,
    state: VoiceSendEvidence['state'] = 'landed',
  ): VoiceSendEvidence => ({
    recordingId: intent.recordingId,
    requestId: intent.requestId,
    streamId: intent.streamId,
    generation: intent.originGeneration,
    state,
    source: 'send.result',
    ...(intent.msgId ? { msgId: intent.msgId } : {}),
  });
  const prepare = jest.fn((args: any): VoiceDispatchIntent => {
    const prior = args.previousIntent as VoiceDispatchIntent | undefined;
    const originalRequest = {
      protocol: 'voice-v1' as const,
      logical_id: args.recordingId,
      target: args.streamId,
      generation: args.originGeneration,
      sequence: args.sequence,
    };
    const requestId =
      'voice-send-' +
      hash(
        JSON.stringify([args.recordingId, args.streamId, args.originGeneration, args.sequence]),
      ).slice(0, 40);
    const optimisticId = prior?.optimisticId ?? 'voice-opt-' + args.recordingId;
    const payload = prior
      ? { ...prior.payload, request_id: requestId }
      : {
          type: 'send',
          request_id: requestId,
          host: 'hosta',
          session_name: 'origin',
          text: args.text,
          optimistic_id: optimisticId,
          operation_id: args.recordingId,
          meta: args.meta ?? {},
          ...(args.attachments ? { attachments: args.attachments } : {}),
        };
    return {
      version: 1,
      recordingId: args.recordingId,
      sequence: args.sequence,
      streamId: args.streamId,
      originGeneration: args.originGeneration,
      optimisticId,
      requestId,
      createdAt: now,
      originalRequest,
      payload,
      payloadSha256: hash(JSON.stringify(payload)),
      ...SCOPE,
    };
  });
  const io: VoiceDeliveryIO = {
    transcribe: jest.fn(async (args: any) => {
      await args.onStage?.('transcribing');
      return {
        blobSha: args.take.audio.sha256,
        transcript: { text: 'spoken detail' },
      };
    }),
    uploadImages: jest.fn(async () => [{ key: 'image-sha', mime: 'image/jpeg' }]),
    prepare,
    hydrate: jest.fn(),
    dispatch: jest.fn(async (intent) => proofs(intent)),
    query: jest.fn(async (intent) => proofs(intent, 'unknown')),
    forget: jest.fn(),
    transport: () => transport,
    origin: jest.fn(() => 'available'),
    subscribeTransport: (fn) => {
      transportListener = fn;
      return () => {};
    },
    subscribeEvidence: (fn) => {
      evidenceListener = fn;
      return () => {};
    },
    now: () => now,
  };
  let delivery = new VoiceDelivery(io, store);
  const ready = async () => {
    delivery.setLifecycle({ foreground: true, unlocked: true });
    await delivery.initialize();
  };
  const take = async (
    options: {
      images?: boolean;
      question?: boolean;
      origin?: typeof ORIGIN;
    } = {},
  ) => {
    files.set('file:///picker/image.jpg', 'image');
    const created = await store.create({
      scope: {
        serverIdentity: transport.serverIdentity,
        credentialId: transport.credentialId,
      },
      origin: options.origin ?? ORIGIN,
      operationKind: options.question ? 'voice_answer' : 'voice_chat',
      draft: {
        textPrefix: options.images ? 'photo note' : '',
        images: options.images
          ? [
              {
                uri: 'file:///picker/image.jpg',
                fileName: 'image.jpg',
                mimeType: 'image/jpeg',
                width: 1,
                height: 1,
                bytes: 5,
              },
            ]
          : [],
      },
    });
    const uri = `file:///cache/${created.recordingId}.m4a`;
    files.set(uri, 'audio-bytes');
    return store.adoptFinalized(created.recordingId, {
      uri,
      mime: 'audio/mp4',
      capturedAudioMs: 4000,
    });
  };
  const restart = async () => {
    delivery.dispose();
    store = new VoiceTakeStore(disk);
    delivery = new VoiceDelivery(io, store);
    await ready();
  };
  return {
    files,
    calls,
    disk,
    io,
    transport,
    proofs,
    prepare,
    ready,
    take,
    restart,
    get store() {
      return store;
    },
    get delivery() {
      return delivery;
    },
    notify: () => transportListener(),
    evidence: (proof: VoiceSendEvidence) => evidenceListener(proof),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('R3 correction: audio exists before unresolved send and stays retained for accepted/unknown', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take(),
    sent = deferred<VoiceSendEvidence>();
  h.io.dispatch = jest.fn(() => sent.promise);
  const work = h.delivery.send(t.recordingId);
  await flush();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  sent.resolve(h.proofs(intent, 'unknown'));
  await work;
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('checking');
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  expect(h.delivery.snapshot().last).toBeNull();
  h.delivery.dispose();
});
test('R6 correction: recreated delivery discovers retained take/audio/transcript and only queries same intent', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'unknown'));
  await h.delivery.send(t.recordingId);
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  await h.restart();
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.io.query).toHaveBeenLastCalledWith(intent);
  expect(h.files.has(h.store.audioUri(h.store.get(t.recordingId)!))).toBe(true);
  h.delivery.dispose();
});
test('U3 capture/cap acceptance is retained unsent and never schedules delivery', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  await h.delivery.accept({
    recordingId: t.recordingId,
    streamId: t.origin.streamId,
    uri: h.store.audioUri(t),
    mime: 'audio/mp4',
    durationS: 4,
    levels: [],
    interrupted: false,
  });
  await h.delivery.drain();
  expect(h.io.transcribe).not.toHaveBeenCalled();
  expect(h.store.get(t.recordingId)?.sendRequestedAt).toBeNull();
  h.delivery.dispose();
});
test('U3 landed requires exact correlated typed evidence before terminal tombstone and cleanup', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.dispatch = jest.fn(async (intent) => ({
    ...h.proofs(intent),
    generation: 'replacement',
  }));
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)).toBeDefined();
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  h.evidence({ ...h.proofs(intent), requestId: 'unrelated' });
  await flush();
  expect(h.store.get(t.recordingId)).toBeDefined();
  h.evidence(h.proofs(intent));
  await flush();
  expect(h.store.get(t.recordingId)).toBeUndefined();
  expect(h.files.has(h.store.audioUri(t))).toBe(false);
  expect(h.delivery.snapshot().last).toBeNull();
  h.delivery.dispose();
});
test('U3 unknown never blindly retries; explicit proved-not-landed Retry advances only attempt', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'unknown'));
  await h.delivery.send(t.recordingId);
  const first = h.store.get(t.recordingId)!.dispatchIntent!;
  await h.delivery.retry(t.recordingId);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.store.get(t.recordingId)?.sequence).toBe(1);
  h.evidence(h.proofs(first, 'not_landed'));
  await flush();
  await Promise.all([h.delivery.retry(t.recordingId), h.delivery.retry(t.recordingId)]);
  const second = h.store.get(t.recordingId)!.dispatchIntent!;
  expect(h.io.dispatch).toHaveBeenCalledTimes(2);
  expect(second.sequence).toBe(2);
  expect(second.optimisticId).toBe(first.optimisticId);
  expect(second.requestId).not.toBe(first.requestId);
  expect(second.payload).toEqual({
    ...first.payload,
    request_id: second.requestId,
  });
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 same transcript and uploaded images survive failed dispatch preparation', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take({ images: true });
  h.prepare.mockImplementationOnce(() => {
    throw Object.assign(Error('prepare_failed'), { code: 'prepare_failed' });
  });
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('failed');
  await h.delivery.retry(t.recordingId);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  expect(h.io.uploadImages).toHaveBeenCalledTimes(1);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.prepare.mock.calls[1][0]).toMatchObject({
    streamId: ORIGIN.streamId,
    text: 'photo note\nspoken detail',
    attachments: [{ key: 'image-sha', mime: 'image/jpeg' }],
  });
  h.delivery.dispose();
});
test('U3 explicit send persists intent before hydrate or first possible frame', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.hydrate = jest.fn((intent) => {
    const manifest = [...h.files.values()].find((value) => value.startsWith('{"version":1'))!;
    expect(JSON.parse(manifest).dispatchIntent).toEqual(intent);
  });
  await h.delivery.send(t.recordingId);
  expect(h.io.hydrate).toHaveBeenCalledTimes(1);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 failed dispatch-intent checkpoint emits no send and keeps bytes', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const write = h.disk.write;
  h.disk.write = async (path, text) => {
    if (text.includes('"dispatchIntent"')) throw Error('disk full');
    return write(path, text);
  };
  await h.delivery.send(t.recordingId);
  expect(h.io.dispatch).not.toHaveBeenCalled();
  expect(h.io.hydrate).not.toHaveBeenCalled();
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  h.delivery.dispose();
});
test.each(['transcribe', 'images', 'prepare'])(
  'U3 X during %s blocks all later frames',
  async (stage) => {
    const h = harness();
    await h.ready();
    const t = await h.take({ images: stage === 'images' });
    const pause = deferred<any>();
    if (stage === 'transcribe') h.io.transcribe = jest.fn(() => pause.promise);
    else if (stage === 'images') h.io.uploadImages = jest.fn(() => pause.promise);
    else
      h.io.prepare = jest.fn((args) => {
        void h.delivery.discard(t.recordingId);
        return h.prepare(args);
      });
    const sending = h.delivery.send(t.recordingId);
    await flush();
    if (stage !== 'prepare') await h.delivery.discard(t.recordingId);
    pause.resolve(
      stage === 'images'
        ? [{ key: 'image' }]
        : { blobSha: t.audio!.sha256, transcript: { text: 'late' } },
    );
    await sending;
    expect(h.io.dispatch).not.toHaveBeenCalled();
    expect(h.store.get(t.recordingId)).toBeUndefined();
    h.delivery.dispose();
  },
);
test('U3 X after dispatch retains honest unknown identity until durable discard and ignores late landed', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const pending = deferred<VoiceSendEvidence>();
  h.io.dispatch = jest.fn(() => pending.promise);
  const sending = h.delivery.send(t.recordingId);
  await flush();
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  await h.delivery.discard(t.recordingId);
  pending.resolve(h.proofs(intent));
  await sending;
  expect(h.store.get(t.recordingId)).toBeUndefined();
  expect(h.io.forget).toHaveBeenCalledWith(intent);
  h.delivery.dispose();
});
test('U3 closed origin skipped while second queued take still sends to its frozen origin', async () => {
  const h = harness();
  await h.ready();
  const first = await h.take();
  const second = await h.take({
    origin: { ...ORIGIN, streamId: 'hostb:second' },
  });
  h.io.origin = jest.fn((id) => (id === ORIGIN.streamId ? 'unavailable' : 'available'));
  await h.delivery.send(first.recordingId);
  await h.delivery.send(second.recordingId);
  expect(h.store.get(first.recordingId)?.delivery.phase).toBe('origin_unavailable');
  expect(h.store.get(second.recordingId)).toBeUndefined();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 missing inventory is transient and queued work automatically drains when it returns', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.origin = jest.fn(() => 'unverified');
  h.transport.inventoryFresh = false;
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('queued');
  expect(h.io.dispatch).not.toHaveBeenCalled();
  h.io.origin = jest.fn(() => 'available');
  h.transport.inventoryFresh = true;
  h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 background stops scheduling and unknown foreground recovery queries instead of resending', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const pending = deferred<VoiceSendEvidence>();
  h.io.dispatch = jest.fn(() => pending.promise);
  const sending = h.delivery.send(t.recordingId);
  await flush();
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  h.delivery.setLifecycle({ foreground: false, unlocked: false });
  pending.resolve(h.proofs(intent, 'unknown'));
  await sending;
  expect(h.io.query).not.toHaveBeenCalled();
  h.delivery.setLifecycle({ foreground: true, unlocked: true });
  await flush();
  await h.delivery.drain();
  expect(h.io.query).toHaveBeenCalledWith(intent);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 credential switch holds old scope and late old result cannot affect new scope', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const pending = deferred<VoiceSendEvidence>();
  h.io.dispatch = jest.fn(() => pending.promise);
  const sending = h.delivery.send(t.recordingId);
  await flush();
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  h.transport.credentialId = '123e4567-e89b-12d3-a456-426614174001';
  h.transport.scopeGeneration++;
  h.notify();
  pending.resolve(h.proofs(intent));
  await sending;
  await flush();
  expect(h.delivery.snapshot()).toMatchObject({ takes: [], heldCount: 1 });
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  h.delivery.dispose();
});
test('U3 duplicate Send has one serial drain and one immutable logical identity', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  await Promise.all([h.delivery.send(t.recordingId), h.delivery.send(t.recordingId)]);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 transport retry backoff is bounded and stops timers in background', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const timers: Array<{ fn: () => void; delay: number }> = [];
  h.io.setTimer = (fn, delay) => {
    timers.push({ fn, delay });
    return timers.length;
  };
  h.io.clearTimer = jest.fn();
  h.io.transcribe = jest
    .fn()
    .mockRejectedValue(Object.assign(Error('offline'), { code: 'offline' }));
  await h.delivery.send(t.recordingId);
  expect(timers.at(-1)?.delay).toBe(1000);
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    h.advance(timers.at(-1)!.delay);
    await h.delivery.drain();
    expect(timers.at(-1)?.delay).toBe(delay);
  }
  h.delivery.setLifecycle({ foreground: false, unlocked: false });
  expect(h.io.clearTimer).toHaveBeenCalled();
  h.delivery.dispose();
});
test('U3 empty transcript retains finalized audio with explicit action-needed failure', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.transcribe = jest.fn(async () => ({
    blobSha: t.audio!.sha256,
    transcript: { text: ' ' },
  }));
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)).toMatchObject({
    delivery: { phase: 'failed', error: 'no_speech' },
  });
  expect(h.io.dispatch).not.toHaveBeenCalled();
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  h.delivery.dispose();
});
test('U3 question carrier comes from frozen durable items after restart', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take({ question: true });
  const item = {
    key: 'n:0',
    question_id: 'q',
    notification_id: 'n',
    producer_stream_id: 'hostb:asker',
    surface_stream_id: ORIGIN.streamId,
    prompt: 'Proceed?',
    segment: { start_s: 0, end_s: 2 },
  };
  h.transport.ready = false;
  await h.delivery.send(t.recordingId, { frozenAnswers: [item] });
  await h.restart();
  h.transport.ready = true;
  h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      meta: {
        voice: { duration_s: 4 },
        voice_answers: {
          version: 1,
          recording_id: t.recordingId,
          blob_sha: t.audio!.sha256,
          duration_s: 4,
          items: [item],
        },
      },
    }),
  );
  h.delivery.dispose();
});
test('U3 voice transcription phase timeout is retained explicit Retry, never automatic backoff', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const timers = jest.fn();
  h.io.setTimer = timers;
  h.io.transcribe = jest.fn(async (args) => {
    await args.onStage?.('transcribing');
    throw Error('Pentacle command timed out');
  });
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)).toMatchObject({
    delivery: { phase: 'failed', error: 'transcribe_timeout', retryAt: null },
  });
  expect(timers).not.toHaveBeenCalled();
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  await h.delivery.drain();
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  await h.delivery.retry(t.recordingId);
  expect(h.io.transcribe).toHaveBeenCalledTimes(2);
  h.delivery.dispose();
});
test('U3 auth-blocked take ignores unrelated stream notifications until renewed ready epoch', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.transcribe = jest
    .fn()
    .mockRejectedValue(Object.assign(Error('upload_forbidden'), { code: 'upload_forbidden' }));
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('auth_needed');
  for (let i = 0; i < 10; i++) h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  h.transport.socketGeneration++;
  h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.io.transcribe).toHaveBeenCalledTimes(2);
  h.delivery.dispose();
});
test('U3 a transient transport auth block clears to queued once the credential is present, even offline', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.transcribe = jest.fn();
  h.transport.ready = false;
  h.notify();
  await flush();
  await h.delivery.send(t.recordingId);
  await flush();
  // Relaunch can briefly report authNeeded before the stored credential is current.
  h.transport.authNeeded = true;
  h.notify();
  await flush();
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('auth_needed');
  h.transport.authNeeded = false;
  h.notify();
  await flush();
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('queued');
  expect(h.store.get(t.recordingId)?.delivery.error).toBeUndefined();
  expect(h.io.transcribe).not.toHaveBeenCalled();
  h.delivery.dispose();
});
test('U3 a persisted transport auth block is requeued after an offline restart with a current credential', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.transcribe = jest.fn();
  h.transport.ready = false;
  h.notify();
  await flush();
  await h.delivery.send(t.recordingId);
  h.transport.authNeeded = true;
  h.notify();
  await flush();
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('auth_needed');
  // Relaunch offline: the credential is current again before any connection is ready.
  h.transport.authNeeded = false;
  await h.restart();
  await flush();
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('queued');
  expect(h.store.get(t.recordingId)?.delivery.error).toBeUndefined();
  expect(h.io.transcribe).not.toHaveBeenCalled();
  h.delivery.dispose();
});
test('U3 a server credential rejection survives an offline restart until a renewed ready epoch', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.transcribe = jest
    .fn()
    .mockRejectedValue(Object.assign(Error('upload_forbidden'), { code: 'upload_forbidden' }));
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('auth_needed');
  h.transport.ready = false;
  await h.restart();
  await flush();
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('auth_needed');
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 enqueue releases the capture command after durable Send while ASR remains pending', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take(),
    pending = deferred<any>();
  h.io.transcribe = jest.fn(() => pending.promise);
  await h.delivery.enqueue(t.recordingId);
  expect(h.store.get(t.recordingId)?.sendRequestedAt).not.toBeNull();
  const next = await h.take();
  expect(next.recordingId).not.toBe(t.recordingId);
  pending.resolve({ blobSha: t.audio!.sha256, transcript: { text: 'done' } });
  await h.delivery.drain();
  h.delivery.dispose();
});

test('U3 definitely pre-intent queued crash resumes cached transcript without reupload or new capture', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  await h.store.requestSend(t.recordingId);
  await h.store.saveTranscription(t.recordingId, {
    blobSha: t.audio!.sha256,
    requestId: `transcribe-${t.recordingId}`,
    result: { text: 'durable transcript' },
  });
  await h.restart();
  await h.delivery.drain();
  expect(h.io.transcribe).not.toHaveBeenCalled();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ text: 'durable transcript' }));
  h.delivery.dispose();
});
test('U3 attempt exhaustion stays visible with same last identity and no further dispatch', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'not_landed'));
  await h.delivery.send(t.recordingId);
  const original = h.store.get(t.recordingId)!;
  const last = h.prepare({
    recordingId: t.recordingId,
    sequence: 1000,
    streamId: t.origin.streamId,
    originGeneration: t.origin.generation,
    text: 'spoken detail',
    operationId: t.recordingId,
    previousIntent: original.dispatchIntent,
  });
  const path = [...h.files.keys()].find((p) => p.endsWith('manifest.json'))!;
  h.files.set(path, JSON.stringify({ ...original, sequence: 1000, dispatchIntent: last }));
  await h.restart();
  await h.delivery.retry(t.recordingId);
  expect(h.store.get(t.recordingId)).toMatchObject({
    sequence: 1000,
    delivery: { phase: 'failed', error: 'attempt_limit' },
    dispatchIntent: { requestId: last.requestId },
  });
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('U3 changed persisted intent checksum is quarantined without hydrate, query, or send', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'unknown'));
  await h.delivery.send(t.recordingId);
  const path = [...h.files.keys()].find((p) => p.endsWith('manifest.json'))!;
  const value = JSON.parse(h.files.get(path)!);
  value.dispatchIntent.payload.text = 'tampered';
  h.files.set(path, JSON.stringify(value));
  (h.io.hydrate as jest.Mock).mockClear();
  (h.io.query as jest.Mock).mockClear();
  await h.restart();
  await h.delivery.drain();
  expect(h.delivery.snapshot().recoveryFailures).toHaveLength(1);
  expect(h.io.hydrate).not.toHaveBeenCalled();
  expect(h.io.query).not.toHaveBeenCalled();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.files.has(h.store.audioUri(t))).toBe(true);
  h.delivery.dispose();
});

test('U3 missing origin at an expired retry deadline suspends timer rather than spinning at 1ms', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  const timers: Array<{ fn: () => void; delay: number }> = [];
  h.io.setTimer = (fn, delay) => {
    timers.push({ fn, delay });
    return timers.length;
  };
  h.io.clearTimer = jest.fn();
  h.io.transcribe = jest
    .fn()
    .mockRejectedValue(Object.assign(Error('offline'), { code: 'offline' }));
  await h.delivery.send(t.recordingId);
  expect(timers).toHaveLength(1);
  h.advance(1000);
  h.io.origin = jest.fn(() => 'unverified');
  await h.delivery.drain();
  expect(timers).toHaveLength(1);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  expect(h.store.get(t.recordingId)?.delivery.phase).toBe('queued');
  for (let i = 0; i < 4; i++) h.notify();
  await flush();
  expect(timers).toHaveLength(1);
  h.io.origin = jest.fn(() => 'available');
  h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.io.transcribe).toHaveBeenCalledTimes(2);
  h.delivery.dispose();
});

test('U3 origin verification lost between selection and work stays queued until inventory returns', async () => {
  const h = harness();
  await h.ready();
  const t = await h.take();
  h.io.origin = jest.fn().mockReturnValueOnce('available').mockReturnValue('unverified');
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)?.delivery).toMatchObject({ phase: 'queued', retryAt: 2000 });
  expect(h.io.transcribe).not.toHaveBeenCalled();
  h.io.origin = jest.fn(() => 'available');
  h.advance(1000);
  h.notify();
  await flush();
  await h.delivery.drain();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});

test.each(['scope', 'discard', 'background'] as const)(
  'MOB-02 production image read is fenced after %s change',
  async (change) => {
    const h = harness();
    const read = deferred<string>();
    const reader = readAttachmentBase64 as jest.Mock;
    const upload = uploadVoiceImageBase64 as jest.Mock;
    reader.mockReset().mockReturnValue(read.promise);
    upload.mockClear();
    h.io.uploadImages = (defaultVoiceDelivery as any).io.uploadImages;
    await h.ready();
    const take = await h.take({ images: true });
    const work = h.delivery.send(take.recordingId);
    await flush();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    if (change === 'scope') {
      h.transport.credentialId = '123e4567-e89b-12d3-a456-426614174999';
      h.transport.scopeGeneration++;
      h.notify();
    } else if (change === 'discard') await h.delivery.discard(take.recordingId);
    else h.delivery.setLifecycle({ foreground: false, unlocked: false });
    read.resolve('aW1hZ2U=');
    await work;
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(h.io.dispatch).not.toHaveBeenCalled();
    if (change === 'scope')
      expect(h.delivery.snapshot()).toMatchObject({ takes: [], heldCount: 1 });
    h.delivery.dispose();
  },
);

test('MOB-02 production image path freezes scope and retains ordinary attachment shape', async () => {
  const h = harness();
  const reader = readAttachmentBase64 as jest.Mock;
  const upload = uploadVoiceImageBase64 as jest.Mock;
  reader.mockReset().mockResolvedValue('aW1hZ2U=');
  upload.mockReset().mockResolvedValue({ blob_sha: 'synthetic-image-sha' });
  h.io.uploadImages = (defaultVoiceDelivery as any).io.uploadImages;
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'unknown'));
  await h.ready();
  const take = await h.take({ images: true });
  await h.delivery.send(take.recordingId);
  expect(upload).toHaveBeenCalledWith(
    'aW1hZ2U=',
    5,
    expect.objectContaining({
      scope: { ...SCOPE, scopeGeneration: 1, socketGeneration: 1 },
      isCancelled: expect.any(Function),
    }),
  );
  expect(h.store.get(take.recordingId)?.attachments).toEqual([
    { key: 'synthetic-image-sha', mime: 'image/jpeg', width: 1, height: 1, bytes: 5 },
  ]);
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [
        { key: 'synthetic-image-sha', mime: 'image/jpeg', width: 1, height: 1, bytes: 5 },
      ],
      text: 'photo note\nspoken detail',
    }),
  );
  h.delivery.dispose();
});

test('CAP-05 real held discard releases only committed question bindings across a partial batch', async () => {
  resetVoiceAnswersForTests();
  const h = harness();
  await h.ready();
  const bind = (id: string) => {
    const item = {
      key: 'n:0',
      question_id: 'q',
      notification_id: 'n',
      producer_stream_id: 'hosta:worker',
      surface_stream_id: 'hosta:origin',
      prompt: 'Synthetic question?',
    };
    startVoiceQuestionSession(id, {
      version: 1,
      eligibleItems: [item],
      durableTotal: 1,
      currentKey: null,
      liveKeys: [item.key],
      visits: [{ key: item.key, startMs: 0, endMs: 2000 }],
      capturedAudioMs: 300000,
      phase: 'finalized',
    });
    freezeVoiceQuestionAnswers(id, 300000);
  };
  const first = await h.take({ question: true }),
    second = await h.take({ question: true });
  bind(first.recordingId);
  bind(second.recordingId);
  h.transport.credentialId = '123e4567-e89b-12d3-a456-426614174999';
  h.notify();
  await flush();
  const current = await h.take({ question: true });
  bind(current.recordingId);
  const write = h.disk.write;
  h.disk.write = async (p, value) => {
    if (p.includes(second.recordingId) && JSON.parse(value).storage === 'discarded')
      throw Error('second tombstone failed');
    await write(p, value);
  };
  await expect(h.delivery.discardHeld()).rejects.toThrow('second tombstone failed');
  expect(voiceQuestionSnapshot(first.recordingId)).toBeUndefined();
  expect(voiceAnswersItemCount(first.recordingId)).toBe(0);
  expect(voiceQuestionSnapshot(second.recordingId)).toBeDefined();
  expect(voiceAnswersItemCount(second.recordingId)).toBe(1);
  expect(voiceQuestionSnapshot(current.recordingId)).toBeDefined();
  expect(h.store.get(current.recordingId)).toBeDefined();
  h.disk.write = write;
  await h.delivery.discardHeld();
  expect(voiceQuestionSnapshot(second.recordingId)).toBeUndefined();
  expect(voiceQuestionSnapshot(current.recordingId)).toBeDefined();
  h.delivery.dispose();
  resetVoiceAnswersForTests();
});
