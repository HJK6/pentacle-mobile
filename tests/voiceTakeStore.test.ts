import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  VoiceTakeStore,
  voiceScopeHash,
  VOICE_MAX_AUDIO_BYTES,
  type VoiceTakeIO,
} from '../src/services/voiceTakeStore';

const scope = {
  serverIdentity: 'wss://synthetic.invalid/stream',
  credentialId: 'operator-a',
};
const origin = {
  streamId: 'hosta:chat',
  generation: 'generation-1',
  label: 'Synthetic',
};
let counter = 0;
function fixture() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  const io: VoiceTakeIO = {
    root: 'file:///documents/voice-takes-v1/',
    cacheRoot: 'file:///cache/',
    now: () => 1000,
    uuid: () => `123e4567-e89b-42d3-a456-${String(++counter).padStart(12, '0')}`,
    stat: async (uri) => ({
      exists: files.has(uri) || dirs.has(uri),
      size: files.get(uri)?.length ?? 0,
      directory: dirs.has(uri),
    }),
    list: async (uri) => [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((k) => k.startsWith(uri) && k !== uri)
          .map((k) => k.slice(uri.length).split('/')[0]),
      ),
    ],
    mkdir: async (uri) => {
      for (let i = 8; i < uri.length; i++) if (uri[i] === '/') dirs.add(uri.slice(0, i + 1));
      dirs.add(uri);
    },
    read: async (uri) => {
      if (!files.has(uri)) throw Error('ENOENT');
      return files.get(uri)!;
    },
    write: async (uri, text) => {
      calls.push('write:' + uri);
      files.set(uri, text);
    },
    move: async (from, to) => {
      calls.push('move:' + from + ':' + to);
      if (!files.has(from)) throw Error('ENOENT');
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    copy: async (from, to) => {
      if (!files.has(from)) throw Error('ENOENT');
      files.set(to, files.get(from)!);
    },
    remove: async (uri) => {
      calls.push('remove:' + uri);
      for (const p of [...files.keys()])
        if (p === uri || p.startsWith(uri.endsWith('/') ? uri : uri + '/')) files.delete(p);
      for (const p of [...dirs]) if (p === uri || p.startsWith(uri)) dirs.delete(p);
    },
    free: async () => 1024 * 1024 * 1024,
    inspect: async (uri) => {
      const text = files.get(uri);
      if (!text) throw Error('bad_audio');
      return {
        bytes: text.length,
        sha256: bytesToHex(sha256(utf8ToBytes(text))),
      };
    },
  };
  const store = new VoiceTakeStore(io);
  const create = async () => {
    await store.setScope(scope);
    return store.create({ scope, origin });
  };
  const finish = async (id: string) => {
    files.set('file:///cache/take.m4a', 'audio-bytes');
    return store.adoptFinalized(id, {
      uri: 'file:///cache/take.m4a',
      mime: 'audio/mp4',
      capturedAudioMs: 4000,
    });
  };
  return { store, io, files, dirs, calls, create, finish };
}
beforeEach(() => {
  counter = 0;
});
test('U1 ownership copies images and atomically publishes only after manifest rename', async () => {
  const { store, io, files, calls } = fixture();
  await store.setScope(scope);
  files.set('file:///picker/photo.jpg', 'photo');
  let published = 0;
  store.subscribe(() => published++);
  const t = await store.create({
    scope,
    origin,
    draft: {
      textPrefix: 'text',
      images: [
        {
          uri: 'file:///picker/photo.jpg',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
          bytes: 999,
        },
      ],
    },
  });
  expect(published).toBe(1);
  expect(t.draft.images[0].bytes).toBe(5);
  expect(files.get(store.images(t)[0].uri)).toBe('photo');
  expect(files.has('file:///picker/photo.jpg')).toBe(true);
  expect(calls.at(-1)).toContain('manifest.tmp.json:');
  expect(t.operation).toMatchObject({
    operation_id: t.recordingId,
    origin_generation: origin.generation,
    operation_kind: 'voice_chat',
  });
  await store.discard(t.recordingId);
  expect(files.has('file:///picker/photo.jpg')).toBe(true);
});
test('U1 failed ownership write keeps original draft and publishes no safe transfer', async () => {
  const { store, io, files } = fixture();
  await store.setScope(scope);
  files.set('file:///picker/photo.jpg', 'image');
  io.write = async () => {
    throw Error('disk full');
  };
  await expect(
    store.create({
      scope,
      origin,
      draft: {
        textPrefix: 'text',
        images: [
          {
            uri: 'file:///picker/photo.jpg',
            fileName: 'photo',
            mimeType: 'image/jpeg',
            width: 1,
            height: 1,
            bytes: 5,
          },
        ],
      },
    }),
  ).rejects.toThrow('disk full');
  expect(store.snapshot().takes).toHaveLength(0);
  expect(files.get('file:///picker/photo.jpg')).toBe('image');
});
test('U1 finalized audio moves to owned documents and remains unsent after restart', async () => {
  const f = fixture();
  const t = await f.create();
  const final = await f.finish(t.recordingId);
  expect(final.storage).toBe('finalized');
  expect(final.sendRequestedAt).toBeNull();
  expect(f.files.has('file:///cache/take.m4a')).toBe(false);
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.snapshot().takes[0]).toMatchObject({
    recordingId: t.recordingId,
    storage: 'finalized',
    sendRequestedAt: null,
  });
  expect(f.files.get(restored.audioUri(restored.get(t.recordingId)!))).toBe('audio-bytes');
});
test('U1 persisted Send and successful transcript survive restart without rerunning capture', async () => {
  const f = fixture();
  const t = await f.create();
  const done = await f.finish(t.recordingId);
  await f.store.requestSend(t.recordingId);
  await f.store.checkpointUpload(t.recordingId, {
    nextOffset: done.audio!.bytes,
    complete: true,
    blobSha: done.audio!.sha256,
  });
  await f.store.saveTranscription(t.recordingId, {
    blobSha: done.audio!.sha256,
    requestId: `transcribe-${t.recordingId}`,
    result: { text: 'hello' },
  });
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    sendRequestedAt: 1000,
    transcription: { result: { text: 'hello' } },
    delivery: { phase: 'queued' },
  });
});
test('U1 orphan temp JSON ignored, corrupt manifest visible and never automatically uploaded', async () => {
  const f = fixture();
  const t = await f.create();
  await f.finish(t.recordingId);
  const manifest = [...f.files.keys()].find((p) => p.endsWith('manifest.json'))!;
  f.files.set(manifest.replace('manifest.json', 'manifest.tmp.json'), '{');
  let recovered = new VoiceTakeStore(f.io);
  await recovered.setScope(scope);
  expect(recovered.snapshot().takes).toHaveLength(1);
  f.files.set(manifest, '{');
  recovered = new VoiceTakeStore(f.io);
  await recovered.setScope(scope);
  expect(recovered.snapshot().takes).toHaveLength(0);
  expect(recovered.snapshot().recoveryFailures).toHaveLength(1);
  expect(f.files.has(manifest)).toBe(true);
});
test('U1 active native recovery is interrupted unsent and cannot resume after process death', async () => {
  const f = fixture();
  const t = await f.create();
  f.files.set('file:///cache/active.m4a', 'valid-synthetic-container');
  await f.store.noteCapture(t.recordingId, {
    nativeUri: 'file:///cache/active.m4a',
    capturedAudioMs: 2000,
    phase: 'paused',
  });
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    storage: 'interrupted',
    sendRequestedAt: null,
    capturedAudioMs: 2000,
  });
});
test('U1 missing interrupted audio remains actionable without invented bytes', async () => {
  const f = fixture();
  const t = await f.create();
  await f.store.noteCapture(t.recordingId, {
    nativeUri: 'file:///cache/missing.m4a',
    capturedAudioMs: 2000,
    phase: 'paused',
  });
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    storage: 'failed',
    sendRequestedAt: null,
    delivery: { error: 'interrupted_recording' },
  });
});
test('U1 quotas reserve audio plus actual images and never evict old work', async () => {
  const f = fixture();
  await f.store.setScope(scope);
  f.io.free = async () => VOICE_MAX_AUDIO_BYTES - 1;
  await expect(f.store.create({ scope, origin })).rejects.toMatchObject({
    code: 'storage_full',
  });
  f.io.free = async () => 1024 * 1024 * 1024;
  for (let i = 0; i < 8; i++) await f.store.create({ scope, origin });
  await expect(f.store.create({ scope, origin })).rejects.toMatchObject({
    code: 'storage_full',
  });
  expect(f.store.snapshot().takes).toHaveLength(8);
});
test('U1 ten-take limit is global across identities and scope projection hides old labels', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    const t = await f.create();
    await f.finish(t.recordingId);
  }
  const other = { ...scope, credentialId: 'operator-b' };
  await f.store.setScope(other);
  expect(f.store.snapshot()).toMatchObject({ takes: [], heldCount: 10 });
  await expect(f.store.create({ scope: other, origin })).rejects.toMatchObject({
    code: 'take_limit',
  });
  await f.store.setScope(scope);
  expect(f.store.snapshot().takes).toHaveLength(10);
});
test('U1 tombstone precedes cleanup, cleanup retries after crash and never sends', async () => {
  const f = fixture();
  const t = await f.create();
  const done = await f.finish(t.recordingId);
  const remove = f.io.remove;
  f.io.remove = async () => {
    throw Error('delete interrupted');
  };
  await expect(f.store.landed(t.recordingId)).rejects.toThrow('delete interrupted');
  expect(f.store.snapshot().takes).toHaveLength(0);
  const persisted = JSON.parse(
    f.files.get([...f.files.keys()].find((p) => p.endsWith('manifest.json'))!)!,
  );
  expect(persisted.storage).toBe('landed');
  f.io.remove = remove;
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.snapshot().takes).toHaveLength(0);
  expect(f.files.has(f.store.audioUri(done))).toBe(false);
});
test('U1 commit failure publishes prior state and repeated ACK can reconcile server truth', async () => {
  const f = fixture();
  const t = await f.create();
  await f.finish(t.recordingId);
  const prior = f.store.get(t.recordingId);
  const write = f.io.write;
  f.io.write = async () => {
    throw Error('disk full');
  };
  await expect(
    f.store.checkpointUpload(t.recordingId, { nextOffset: 3, complete: false }),
  ).rejects.toThrow('disk full');
  expect(f.store.get(t.recordingId)).toBe(prior);
  f.io.write = write;
  await f.store.checkpointUpload(t.recordingId, {
    nextOffset: 3,
    complete: false,
  });
  expect(f.store.get(t.recordingId)?.upload?.nextOffset).toBe(3);
});
test('U1 path traversal and forged ACK reject without deleting unrelated assets', async () => {
  const f = fixture();
  const t = await f.create();
  await f.finish(t.recordingId);
  expect(() => f.store.ownedUri(t, '../secret')).toThrow('invalid_owned_path');
  await expect(
    f.store.noteCapture(t.recordingId, {
      nativeUri: 'file:///documents/secret',
      capturedAudioMs: 0,
      phase: 'paused',
    }),
  ).rejects.toThrow('invalid_native_path');
  await expect(
    f.store.checkpointUpload(t.recordingId, {
      nextOffset: 99999,
      complete: true,
      blobSha: 'fake',
    }),
  ).rejects.toThrow('invalid_manifest');
});
test('U1 cancellation epoch fences a pending adoption before it can publish finalized audio', async () => {
  const f = fixture();
  const t = await f.create();
  f.files.set('file:///cache/take.m4a', 'bytes');
  const original = f.io.inspect;
  let resolve!: () => void;
  const wait = new Promise<void>((r) => (resolve = r));
  f.io.inspect = async (uri) => {
    await wait;
    return original(uri);
  };
  const adopting = f.store.adoptFinalized(t.recordingId, {
    uri: 'file:///cache/take.m4a',
    mime: 'audio/mp4',
    capturedAudioMs: 1000,
  });
  await Promise.resolve();
  const discard = f.store.discard(t.recordingId);
  resolve();
  await expect(adopting).rejects.toThrow('voice_cancelled');
  await discard;
  expect(f.store.snapshot().takes).toHaveLength(0);
});
test('U1 finalizing journal recovers both sides of the native-file move crash', async () => {
  const f = fixture();
  const t = await f.create();
  f.files.set('file:///cache/take.m4a', 'audio-bytes');
  const move = f.io.move;
  f.io.move = async (from, to) => {
    if (from === 'file:///cache/take.m4a') throw Error('crash before move');
    return move(from, to);
  };
  await expect(
    f.store.adoptFinalized(t.recordingId, {
      uri: 'file:///cache/take.m4a',
      mime: 'audio/mp4',
      capturedAudioMs: 1000,
    }),
  ).rejects.toThrow('crash before move');
  f.io.move = move;
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    storage: 'interrupted',
    sendRequestedAt: null,
  });
  expect(f.files.has('file:///cache/take.m4a')).toBe(false);
});
test('U1 an invalid active container stays interrupted failure rather than invented audio', async () => {
  const f = fixture();
  const t = await f.create();
  f.files.set('file:///cache/incomplete.m4a', 'incomplete');
  await f.store.noteCapture(t.recordingId, {
    nativeUri: 'file:///cache/incomplete.m4a',
    capturedAudioMs: 2000,
    phase: 'paused',
  });
  f.io.inspect = async () => {
    throw Error('interrupted_recording');
  };
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    storage: 'failed',
    sendRequestedAt: null,
    delivery: { error: 'interrupted_recording' },
  });
  expect(f.files.get('file:///cache/incomplete.m4a')).toBe('incomplete');
});
test('U1 old composite constant is never accepted as canonical generation', async () => {
  const f = fixture();
  await f.store.setScope(scope);
  await expect(
    f.store.create({
      scope,
      origin: { ...origin, generation: 'assistant-composite-v1' },
    }),
  ).rejects.toThrow('origin_unverifiable');
});
test('U1 capped question binding is durably frozen before explicit Send and survives restart', async () => {
  const f = fixture();
  await f.store.setScope(scope);
  const t = await f.store.create({
    scope,
    origin,
    operationKind: 'voice_answer',
  });
  f.files.set('file:///cache/take.m4a', 'audio-bytes');
  const frozen = [
    {
      key: 'n:0',
      question_id: 'q',
      notification_id: 'n',
      producer_stream_id: 'hostb:asker',
      surface_stream_id: origin.streamId,
      prompt: 'Proceed?',
      segment: { start_s: 0, end_s: 2 },
    },
  ];
  await f.store.adoptFinalized(t.recordingId, {
    uri: 'file:///cache/take.m4a',
    mime: 'audio/mp4',
    capturedAudioMs: 2000,
    frozenAnswers: frozen,
  });
  const restored = new VoiceTakeStore(f.io);
  await restored.setScope(scope);
  expect(restored.get(t.recordingId)).toMatchObject({
    sendRequestedAt: null,
    frozenAnswers: frozen,
  });
  await restored.requestSend(t.recordingId);
  expect(restored.get(t.recordingId)?.sendRequestedAt).toBe(1000);
});
test('U1 discard stops a pending manifest checkpoint before its rename', async () => {
  const f = fixture();
  const t = await f.create();
  await f.finish(t.recordingId);
  const write = f.io.write;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = false;
  f.io.write = async (uri, text) => {
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return write(uri, text);
  };
  const saving = f.store.setDelivery(t.recordingId, { phase: 'uploading' });
  await Promise.resolve();
  await Promise.resolve();
  const cancelled = f.store.discard(t.recordingId);
  release();
  await expect(saving).rejects.toThrow('voice_cancelled');
  await cancelled;
  expect(f.store.snapshot().takes).toHaveLength(0);
  expect([...f.files.keys()].some((p) => p.endsWith('manifest.json'))).toBe(false);
});
test('U1 retry after native move and failed final manifest uses retained owned bytes', async () => {
  const f = fixture();
  const t = await f.create();
  f.files.set('file:///cache/take.m4a', 'audio-bytes');
  const write = f.io.write;
  f.io.write = async (uri, text) => {
    if (JSON.parse(text).storage === 'finalized') throw Error('final write failed');
    return write(uri, text);
  };
  await expect(
    f.store.adoptFinalized(t.recordingId, {
      uri: 'file:///cache/take.m4a',
      mime: 'audio/mp4',
      capturedAudioMs: 1000,
    }),
  ).rejects.toThrow('final write failed');
  expect(f.files.has('file:///cache/take.m4a')).toBe(false);
  f.io.write = write;
  await f.store.adoptFinalized(t.recordingId, {
    uri: 'file:///cache/take.m4a',
    mime: 'audio/mp4',
    capturedAudioMs: 1000,
  });
  expect(f.store.get(t.recordingId)?.storage).toBe('finalized');
});
test.each(['corrupt', 'terminal'])(
  'U1 owned quota includes %s retained assets when manifests cannot count them',
  async (kind) => {
    const f = fixture();
    const t = await f.create();
    await f.finish(t.recordingId);
    const manifest = [...f.files.keys()].find((p) => p.endsWith('manifest.json'))!;
    const originalStat = f.io.stat;
    f.io.stat = async (uri) =>
      uri.endsWith('audio.m4a') ? { exists: true, size: 120 * 1024 * 1024 } : originalStat(uri);
    if (kind === 'corrupt') f.files.set(manifest, '{');
    else {
      const value = JSON.parse(f.files.get(manifest)!);
      value.storage = 'landed';
      f.files.set(manifest, JSON.stringify(value));
      f.io.remove = async () => {
        throw Error('cleanup interrupted');
      };
    }
    const restored = new VoiceTakeStore(f.io);
    await restored.setScope(scope);
    await expect(restored.create({ scope, origin })).rejects.toMatchObject({
      code: 'storage_full',
    });
  },
);

test('U1 voice lifecycle uses the exact channel envelope and only bounded safe fields', () => {
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const events: Array<import('pentacle-chat-core').TelemetryPayload> = [];
  telemetry.setTelemetrySink((event) => events.push(event));
  const { voiceLifecycle } =
    require('../src/services/voiceTakeStore') as typeof import('../src/services/voiceTakeStore');
  voiceLifecycle('123e4567-e89b-42d3-a456-426614174000', 'receipt', 'stalled', {
    error: 'voice_failed',
    retry_state: 2,
    byte_count: 65536,
    total_bytes: 100000,
  });
  expect(events).toEqual([
    {
      subsystem: 'voice_delivery',
      message: 'voice_delivery:lifecycle',
      bug_ref: 'continuous_voice',
      data: {
        subsystem: 'voice_delivery',
        bug_ref: 'continuous_voice',
        recording_id: '123e4567-e89b-42d3-a456-426614174000',
        operation_id: '123e4567-e89b-42d3-a456-426614174000',
        stage: 'receipt',
        state: 'stalled',
        error: 'voice_failed',
        retry_state: 2,
        byte_count: 65536,
        total_bytes: 100000,
      },
    },
  ]);
  telemetry.setTelemetrySink(null);
});

test('U1 lifecycle rejects unsafe identifiers/states and strips non-enum or injected payload fields', () => {
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const events: Array<import('pentacle-chat-core').TelemetryPayload> = [];
  telemetry.setTelemetrySink((event) => events.push(event));
  const { voiceLifecycle } =
    require('../src/services/voiceTakeStore') as typeof import('../src/services/voiceTakeStore');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  voiceLifecycle('private-label', 'capture', 'started');
  voiceLifecycle(id, 'private-stage', 'started');
  voiceLifecycle(id, 'capture', 'private-state');
  voiceLifecycle(id, 'capture', 'failed', {
    error: 'transcript-shaped message',
    byte_count: -1,
    total_bytes: NaN,
    transcript: 'private text',
    token: 'private token',
  } as any);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    subsystem: 'voice_delivery',
    bug_ref: 'continuous_voice',
    data: {
      recording_id: id,
      stage: 'capture',
      state: 'failed',
      error: 'voice_failed',
    },
  });
  expect(Object.keys(events[0].data!).sort()).toEqual([
    'bug_ref',
    'error',
    'operation_id',
    'recording_id',
    'stage',
    'state',
    'subsystem',
  ]);
  telemetry.setTelemetrySink(null);
});
