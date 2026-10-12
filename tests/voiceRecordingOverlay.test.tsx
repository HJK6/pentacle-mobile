import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { VoiceDelivery, type VoiceDeliveryIO } from '../src/services/voiceDelivery';
import { VoiceTakeStore, type VoiceTakeIO, type VoiceTakeManifest } from '../src/services/voiceTakeStore';
import type { VoiceDispatchIntent, VoiceSendEvidence } from '../src/services/pentacleStream';
import VoiceRecordingOverlay from '../src/components/voice/VoiceRecordingOverlay';
import { resetVoicePresentationForTests } from '../src/services/voicePresentation';
let mockDelivery: VoiceDelivery;
let mockStore: VoiceTakeStore;
const mockLifecycle = { foreground: true, unlocked: true };
jest.mock('../src/services/voiceDelivery', () => {
  const actual = jest.requireActual('../src/services/voiceDelivery'); const ReactActual = require('react');
  return { ...actual, voiceDelivery: new Proxy({}, { get: (_target, key) => { const value = (mockDelivery as any)[key]; return typeof value === 'function' ? value.bind(mockDelivery) : value; } }),
    useVoiceDelivery: () => ReactActual.useSyncExternalStore(mockDelivery.subscribe, mockDelivery.snapshot, mockDelivery.snapshot) };
});
jest.mock('../src/services/voiceRecordingEngine', () => ({
  voiceRecorder: { isOwnedByCurrentScope: () => true, snapshot: () => null, subscribe: () => () => undefined },
  voiceLifecycleSnapshot: () => mockLifecycle, subscribeVoiceLifecycle: () => () => undefined,
  sendVoiceTake: (id: string) => mockDelivery.enqueue(id), discardVoiceTake: (id: string) => mockDelivery.discard(id),
}));
jest.mock('../src/services/pentacleStream', () => ({ ...jest.requireActual('../src/services/pentacleStream'), voiceTransportSnapshot: () => ({ serverIdentity: SCOPE.serverIdentity, credentialId: SCOPE.credentialId, authNeeded: false }), subscribeVoiceTransport: () => () => {}, subscribeVoiceSendEvidence: () => () => {} }));
jest.mock('expo-router', () => ({ usePathname: () => '/settings', useRouter: () => ({ push: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const hash = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));
const SCOPE = {
  serverIdentity: 'wss://synthetic.invalid/ws',
  credentialId: '123e4567-e89b-12d3-a456-426614174000',
};
const ORIGIN = { streamId: 'hosta:origin', generation: 'generation-1', label: 'Synthetic origin' };
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
    now = Date.now(),
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
      hash(JSON.stringify([args.recordingId, args.streamId, args.originGeneration, args.sequence])).slice(
        0,
        40,
      );
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
      return { blobSha: args.take.audio.sha256, transcript: { text: 'Synthetic answer' } };
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
  const take = async (options: { images?: boolean; question?: boolean; origin?: typeof ORIGIN } = {}) => {
    files.set('file:///picker/image.jpg', 'image');
    const created = await store.create({
      scope: { serverIdentity: transport.serverIdentity, credentialId: transport.credentialId },
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
    return store.adoptFinalized(created.recordingId, { uri, mime: 'audio/mp4', capturedAudioMs: 3000 });
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



function install() { const h = harness(); mockDelivery = h.delivery; mockStore = h.store; return h; }
beforeEach(() => { jest.useFakeTimers(); resetVoicePresentationForTests(); });
afterEach(() => { resetVoicePresentationForTests(); jest.useRealTimers(); });
test('authoritative landed completion shows a transient receipt without retaining audio or Return', async () => {
  const h = install(); await h.ready(); const take = await h.take(); const result = deferred<VoiceSendEvidence>();
  (h.io.dispatch as jest.Mock).mockImplementation(intent => result.promise);
  const view = render(<VoiceRecordingOverlay />); let pending!: Promise<void>;
  await act(async () => { pending = h.delivery.send(take.recordingId); await flush(); });
  const intent = h.store.get(take.recordingId)!.dispatchIntent!;
  await act(async () => { result.resolve(h.proofs(intent)); await pending; });
  expect(view.getByText('SENT TO SYNTHETIC ORIGIN')).toBeTruthy();
  expect(view.queryByLabelText('Return to original chat')).toBeNull();
  expect(view.queryByLabelText('View sent recording')).toBeNull();
  expect(h.store.get(take.recordingId)).toBeUndefined();
  act(() => jest.advanceTimersByTime(2800));
  expect(view.queryByTestId('voice-recording-overlay')).toBeNull(); h.delivery.dispose();
});
test('R4 paired ambiguous send failure remains visible and actionable away from origin', async () => {
  const h = install(); await h.ready(); const take = await h.take();
  (h.io.dispatch as jest.Mock).mockRejectedValue(new Error('synthetic send failure'));
  const view = render(<VoiceRecordingOverlay />);
  await act(async () => { await h.delivery.send(take.recordingId); });
  expect(view.getByTestId('voice-recording-overlay')).toBeTruthy(); expect(view.getByLabelText('Check recording delivery again')).toBeTruthy();
  expect(view.queryByLabelText('Send recording')).toBeNull(); h.delivery.dispose();
});
test('retained takes expose an accessible list and discard removes only the chosen take', async () => {
  const h = install(); await h.ready(); const first = await h.take(); const second = await h.take();
  const view = render(<VoiceRecordingOverlay />);
  fireEvent.press(view.getByLabelText('Show retained recordings'));
  expect(view.getByTestId('voice-take-list')).toBeTruthy(); expect(view.getAllByLabelText('Discard recording')).toHaveLength(2);
  await act(async () => { fireEvent.press(view.getAllByLabelText('Discard recording')[1]); await flush(); });
  expect(h.store.get(first.recordingId)).toBeDefined(); expect(h.store.get(second.recordingId)).toBeUndefined(); h.delivery.dispose();
});
