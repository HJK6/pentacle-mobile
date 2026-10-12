// Durable delivery tests use real manifests/atomic operations and deterministic IO.
// Only the native filesystem and socket boundaries are synthetic.
jest.mock('../src/services/pentacleStream', () => ({
  ...jest.requireActual('../src/services/pentacleStream'),
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
import { VoiceDelivery, type VoiceDeliveryIO } from '../src/services/voiceDelivery';
import { createVoiceContext } from '../src/services/voiceContext';
import {
  VoiceTakeStore,
  type VoiceTakeIO,
  type VoiceTakeManifest,
} from '../src/services/voiceTakeStore';
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
      context_v1?: NonNullable<VoiceTakeManifest['context_v1']>;
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
      capturedAudioMs: options.context_v1 ? 15000 : 4000,
      context_v1: options.context_v1,
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

// Original delivery regressions now enter through durable ownership + explicit Send.
test('stop retains an unsent row; explicit Send preserves captured destination and voice metadata', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take();
  await h.delivery.accept({
    streamId: take.origin.streamId,
    recordingId: take.recordingId,
    uri: h.store.audioUri(take),
    mime: 'audio/mp4',
    durationS: 4,
    levels: [0.8],
    interrupted: false,
  });
  expect(h.delivery.snapshot().takes[0]).toMatchObject({
    streamId: 'hosta:origin',
    status: 'unsent',
  });
  expect(h.io.transcribe).not.toHaveBeenCalled();
  await h.delivery.send(take.recordingId);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      streamId: 'hosta:origin',
      text: 'spoken detail',
      meta: { voice: { duration_s: 4 } },
    }),
  );
  expect(h.delivery.snapshot().takes).toHaveLength(0);
  expect(h.files.has(h.store.audioUri(take))).toBe(false);
  h.delivery.dispose();
});
test('cancel while transcription is in flight removes row and never sends late transcript', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take(),
    result = deferred<any>();
  h.io.transcribe = jest.fn(() => result.promise);
  const work = h.delivery.send(take.recordingId);
  await flush();
  await h.delivery.discard(take.recordingId);
  result.resolve({
    blobSha: take.audio!.sha256,
    transcript: { text: 'must not send' },
  });
  await work;
  expect(h.io.dispatch).not.toHaveBeenCalled();
  expect(h.delivery.snapshot().takes).toHaveLength(0);
  expect(h.files.has(h.store.audioUri(take))).toBe(false);
  h.delivery.dispose();
});
test('failed transcription retains audio; retry reuses transcription identity and sends once', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take();
  (h.io.transcribe as jest.Mock).mockRejectedValueOnce(
    Object.assign(Error('backend down'), { code: 'backend_unavailable' }),
  );
  await h.delivery.send(take.recordingId);
  expect(h.delivery.snapshot().takes[0].status).toBe('failed');
  expect(h.files.has(h.store.audioUri(take))).toBe(true);
  await h.delivery.retry(take.recordingId);
  expect((h.io.transcribe as jest.Mock).mock.calls[1][0].transcribeRequestId).toBe(
    (h.io.transcribe as jest.Mock).mock.calls[0][0].transcribeRequestId,
  );
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('empty transcript fails visibly and retains audio for retry or discard', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take();
  h.io.transcribe = jest.fn(async () => ({
    blobSha: take.audio!.sha256,
    transcript: { text: ' ' },
  }));
  await h.delivery.send(take.recordingId);
  expect(h.delivery.snapshot().takes[0]).toMatchObject({
    status: 'failed',
    error: 'Nothing was recognized.',
  });
  expect(h.io.dispatch).not.toHaveBeenCalled();
  expect(h.files.has(h.store.audioUri(take))).toBe(true);
  h.delivery.dispose();
});
test('image upload retry keeps completed transcript, captured draft and origin in one delivery', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take({ images: true });
  (h.io.uploadImages as jest.Mock).mockRejectedValueOnce(Error('image upload failed'));
  await h.delivery.send(take.recordingId);
  expect(h.delivery.snapshot().takes[0].status).toBe('failed');
  expect(h.io.dispatch).not.toHaveBeenCalled();
  await h.delivery.retry(take.recordingId);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  expect(h.io.uploadImages).toHaveBeenCalledTimes(2);
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      streamId: take.origin.streamId,
      originGeneration: 'generation-1',
      text: 'photo note\nspoken detail',
      attachments: [expect.objectContaining({ key: 'image-sha', mime: 'image/jpeg' })],
    }),
  );
  expect(h.files.has('file:///picker/image.jpg')).toBe(true);
  h.delivery.dispose();
});
test('discard during image upload blocks the late combined send', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take({ images: true }),
    uploaded = deferred<any>();
  h.io.uploadImages = jest.fn(() => uploaded.promise);
  const work = h.delivery.send(take.recordingId);
  await flush();
  expect(h.io.uploadImages).toHaveBeenCalledTimes(1);
  await h.delivery.discard(take.recordingId);
  uploaded.resolve([{ key: 'image', mime: 'image/jpeg' }]);
  await work;
  expect(h.io.dispatch).not.toHaveBeenCalled();
  h.delivery.dispose();
});
test('R3 retained audio remains present while send result is unresolved', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take(),
    sent = deferred<VoiceSendEvidence>();
  h.io.dispatch = jest.fn(() => sent.promise);
  const work = h.delivery.send(take.recordingId);
  await flush();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  expect(h.files.has(h.store.audioUri(take))).toBe(true);
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  sent.resolve(h.proofs(h.store.get(take.recordingId)!.dispatchIntent!, 'unknown'));
  await work;
  h.delivery.dispose();
});
test('R7 ambiguous accepted outcome retains a visible take and its audio', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take();
  h.io.dispatch = jest.fn(async (intent) => h.proofs(intent, 'unknown'));
  await h.delivery.send(take.recordingId);
  expect(h.files.has(h.store.audioUri(take))).toBe(true);
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  expect(h.delivery.snapshot().last).toBeNull();
  h.delivery.dispose();
});
test('R6 re-created delivery owner discovers a retained failed take', async () => {
  const h = harness();
  await h.ready();
  const take = await h.take();
  h.io.transcribe = jest
    .fn()
    .mockRejectedValue(Object.assign(Error('backend down'), { code: 'backend_unavailable' }));
  await h.delivery.send(take.recordingId);
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  expect(h.files.has(h.store.audioUri(take))).toBe(true);
  await h.restart();
  expect(h.delivery.snapshot().takes).toHaveLength(1);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});


const contextFixture = { visits: [
  { offset_ms: 0, page_id: 'personal', title: 'Personal' },
  { offset_ms: 3100, page_id: 'calendar', title: 'Calendar' },
  { offset_ms: 7200, page_id: 'questions', title: 'Questions', question_id: 'q-example-1' },
  { offset_ms: 11000, page_id: 'questions', title: 'Questions', question_id: 'q-example-2' },
] };
test('bounded context is frozen in the request digest and survives unknown receipt/restart/retry', async () => {
  const h = harness(); await h.ready();
  h.io.dispatch = jest.fn(async intent => h.proofs(intent, 'unknown'));
  const t = await h.take({ context_v1: contextFixture });
  await h.delivery.send(t.recordingId);
  const first = h.store.get(t.recordingId)!.dispatchIntent!;
  expect(first.payload.meta).toEqual({ voice: { duration_s: 15, context_v1: contextFixture } });
  expect(first.payloadSha256).toBe(hash(JSON.stringify(first.payload)));
  expect(h.prepare.mock.calls[0][0].meta.voice_answers).toBeUndefined();
  await h.restart(); await flush();
  const restored = h.store.get(t.recordingId)!.dispatchIntent!;
  expect(JSON.stringify(restored)).toBe(JSON.stringify(first));
  h.io.query = jest.fn(async intent => h.proofs(intent, 'not_landed'));
  await h.delivery.checkAgain(t.recordingId);
  await h.delivery.retry(t.recordingId);
  const retry = h.store.get(t.recordingId)!.dispatchIntent!;
  expect(retry.sequence).toBe(2);
  expect(retry.payload.meta).toEqual(first.payload.meta);
  expect(h.io.transcribe).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('an old daemon may ignore optional context and still land ordinary voice', async () => {
  const h = harness(); await h.ready();
  h.io.dispatch = jest.fn(async intent => {
    const meta = intent.payload.meta as { voice: { duration_s: number } };
    expect(meta.voice.duration_s).toBe(15);
    return h.proofs(intent);
  });
  const t = await h.take({ context_v1: contextFixture });
  await h.delivery.send(t.recordingId);
  expect(h.store.get(t.recordingId)).toBeUndefined();
  expect(h.io.dispatch).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});
test('landed subscribers receive only matching authoritative proof after owned cleanup', async () => {
  const h = harness(); await h.ready();
  const landed = jest.fn(); h.delivery.subscribeLanded(landed);
  h.io.dispatch = jest.fn(async intent => h.proofs(intent, 'unknown'));
  const t = await h.take(); await h.delivery.send(t.recordingId);
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  expect(landed).not.toHaveBeenCalled();
  h.evidence({ ...h.proofs(intent), generation: 'different-generation' }); await flush();
  expect(landed).not.toHaveBeenCalled();
  h.evidence(h.proofs(intent)); await flush();
  expect(landed).toHaveBeenCalledTimes(1);
  expect(landed).toHaveBeenCalledWith({ recordingId: t.recordingId, streamId: t.origin.streamId, originLabel: t.origin.label, landedAt: 1000 });
  expect(h.files.has(h.store.audioUri(t))).toBe(false);
  h.evidence(h.proofs(intent)); await flush();
  expect(landed).toHaveBeenCalledTimes(1);
  const cancelled = await h.take(); await h.delivery.discard(cancelled.recordingId);
  expect(landed).toHaveBeenCalledTimes(1);
  h.delivery.dispose();
});

test.each(['locked', 'auth', 'scope'] as const)('landed proof never creates a receipt across %s state', async change => {
  const h = harness(); await h.ready();
  h.io.dispatch = jest.fn(async intent => h.proofs(intent, 'unknown'));
  const landed = jest.fn(); h.delivery.subscribeLanded(landed);
  const t = await h.take(); await h.delivery.send(t.recordingId);
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  if (change === 'locked') h.delivery.setLifecycle({ foreground: true, unlocked: false });
  if (change === 'auth') { h.transport.authNeeded = true; h.notify(); }
  if (change === 'scope') { h.transport.credentialId = '123e4567-e89b-12d3-a456-426614174111'; h.notify(); }
  h.evidence(h.proofs(intent)); await flush();
  expect(landed).not.toHaveBeenCalled();
  h.delivery.dispose();
});

test('lock while landed cleanup is pending suppresses Sent even if the view unlocks before cleanup', async () => {
  const h = harness(); await h.ready();
  const landed = jest.fn(); h.delivery.subscribeLanded(landed);
  h.io.dispatch = jest.fn(async intent => h.proofs(intent, 'unknown'));
  const t = await h.take(); await h.delivery.send(t.recordingId);
  const intent = h.store.get(t.recordingId)!.dispatchIntent!;
  const gate = deferred<void>(), started = deferred<void>(), remove = h.disk.remove;
  h.disk.remove = async uri => { if (uri.endsWith('audio.m4a')) { started.resolve(); await gate.promise; } return remove(uri); };
  h.evidence(h.proofs(intent)); await started.promise;
  h.delivery.setLifecycle({ foreground: false, unlocked: false });
  h.delivery.setLifecycle({ foreground: true, unlocked: true });
  gate.resolve(); await flush();
  expect(landed).not.toHaveBeenCalled();
  expect(h.store.get(t.recordingId)).toBeUndefined();
  h.delivery.dispose();
});


test.each([
  ['A \u200b B', 'A B'],
  ['a'.repeat(47) + ' b', 'a'.repeat(47)],
  ['你好\t😀 \u200b B', '你好 😀 B'],
])('normalized title %p survives capture checkpoint, immutable dispatch and restart', async (input, expected) => {
  const h = harness(); await h.ready();
  h.io.dispatch = jest.fn(async intent => h.proofs(intent, 'unknown'));
  const context_v1 = createVoiceContext({ page_id: 'list', title: input, entity_id: 'item-1' });
  const take = await h.store.create({ scope: SCOPE, origin: ORIGIN });
  const uri = 'file:///cache/title.m4a'; h.files.set(uri, 'audio-bytes');
  await h.store.noteCapture(take.recordingId, { nativeUri: uri, capturedAudioMs: 1000, phase: 'recording', context_v1 });
  await h.delivery.accept({ recordingId: take.recordingId, streamId: take.origin.streamId, uri, mime: 'audio/mp4', durationS: 1, levels: [], interrupted: false, context_v1 });
  expect(h.store.get(take.recordingId)?.context_v1?.visits[0].title).toBe(expected);
  await h.delivery.send(take.recordingId);
  const intent = h.store.get(take.recordingId)!.dispatchIntent!;
  expect(intent.payload.meta).toEqual({ voice: { duration_s: 1, context_v1: { visits: [{ offset_ms: 0, page_id: 'list', title: expected, entity_id: 'item-1' }] } } });
  expect(intent.payloadSha256).toBe(hash(JSON.stringify(intent.payload)));
  await h.restart(); await flush();
  expect(JSON.stringify(h.store.get(take.recordingId)!.dispatchIntent)).toBe(JSON.stringify(intent));
  expect(h.store.snapshot().recoveryFailures).toHaveLength(0);
  h.delivery.dispose();
});
