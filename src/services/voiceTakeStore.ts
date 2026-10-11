import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { uuid } from 'expo-modules-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { logTelemetry, type ChatAttachment } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from './mobileTelemetryEvents';
import { getAppIdentity } from '../config/appIdentity';
import type { ProcessedAsset } from './imageCapture';
import {
  validVoiceAnswersItems,
  validVoiceQuestionSnapshot,
  type VoiceAnswersItem,
  type VoiceQuestionSessionSnapshot,
} from '../components/questions/voice/voiceAnswersBinding';
import {
  validateVoiceDispatchIntent,
  type VoiceDispatchIntent,
  type TranscribeBlobResult,
} from './pentacleStream';
import { inspectVoiceAudio } from './voiceUpload';

export const VOICE_TAKE_VERSION = 1;
export const VOICE_MAX_TAKES = 10;
export const VOICE_MAX_OWNED_BYTES = 128 * 1024 * 1024;
export const VOICE_MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const VOICE_MAX_CAPTURED_MS = 300000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const LEAF = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type VoiceScope = { serverIdentity: string; credentialId: string };
export type VoiceOperation = {
  version: 1;
  operation_id: string;
  origin_stream_id: string;
  origin_generation: string;
  operation_kind: 'voice_chat' | 'voice_answer';
  client_build: string;
};
export type VoiceStorageState =
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'finalized'
  | 'interrupted'
  | 'failed'
  | 'landed'
  | 'discarded';
export type VoiceDeliveryPhase =
  | 'unsent'
  | 'queued'
  | 'uploading'
  | 'transcribing'
  | 'checking'
  | 'failed'
  | 'auth_needed'
  | 'origin_unavailable'
  | 'not_landed';
export type VoiceAudio = {
  path: string;
  mime: 'audio/mp4' | 'audio/wav';
  bytes: number;
  sha256: string;
  uploadId: string;
};
export type VoiceUploadProgress = {
  nextOffset: number;
  complete: boolean;
  blobSha?: string;
};
export type VoiceTakeManifest = {
  version: 1;
  scopeHash: string;
  recordingId: string;
  createdAt: number;
  sendRequestedAt: number | null;
  epoch: number;
  storage: VoiceStorageState;
  origin: { streamId: string; generation: string; label: string };
  draft: {
    textPrefix: string;
    images: Array<Omit<ProcessedAsset, 'uri'> & { path: string }>;
  };
  operation: VoiceOperation;
  nativeUri?: string;
  capturedAudioMs: number;
  levels: number[];
  audio?: VoiceAudio;
  upload?: VoiceUploadProgress;
  frozenAnswers?: VoiceAnswersItem[];
  questionBinding?: VoiceQuestionSessionSnapshot;
  delivery: {
    phase: VoiceDeliveryPhase;
    retryCount: number;
    retryAt: number | null;
    error?: string;
  };
  transcription?: {
    blobSha: string;
    requestId: string;
    result: TranscribeBlobResult;
  };
  attachments?: ChatAttachment[];
  sequence: number;
  dispatchIntent?: VoiceDispatchIntent;
};
export type VoiceRecoveryFailure = {
  id: string;
  scopeHash: string;
  error: 'recovery_failed';
};
export type VoiceTakeSnapshot = {
  takes: readonly VoiceTakeManifest[];
  heldCount: number;
  recoveryFailures: readonly VoiceRecoveryFailure[];
  ready: boolean;
};
export type VoiceTakeIO = {
  root: string;
  cacheRoot: string;
  now(): number;
  uuid(): string;
  stat(uri: string): Promise<{ exists: boolean; size: number; directory?: boolean }>;
  list(uri: string): Promise<string[]>;
  mkdir(uri: string): Promise<void>;
  read(uri: string): Promise<string>;
  write(uri: string, text: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(uri: string): Promise<void>;
  free(): Promise<number>;
  inspect(uri: string): Promise<{ bytes: number; sha256: string }>;
};
export class VoiceStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'VoiceStorageError';
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
export function voiceScopeHash(scope: VoiceScope): string {
  if (!scope.serverIdentity || !scope.credentialId) throw new VoiceStorageError('auth_needed');
  return bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([scope.serverIdentity, scope.credentialId]))),
  );
}
function leaf(value: string): string {
  if (!LEAF.test(value) || value === '.' || value === '..')
    throw new VoiceStorageError('invalid_owned_path');
  return value;
}
function terminal(take: VoiceTakeManifest): boolean {
  return take.storage === 'landed' || take.storage === 'discarded';
}
function validManifest(
  value: unknown,
  scopeHash: string,
  recordingId: string,
): value is VoiceTakeManifest {
  if (!value || typeof value !== 'object') return false;
  const t = value as VoiceTakeManifest;
  try {
    if (
      t.version !== 1 ||
      t.scopeHash !== scopeHash ||
      t.recordingId !== recordingId ||
      !UUID.test(t.recordingId) ||
      !HASH.test(t.scopeHash)
    )
      return false;
    if (
      !integer(t.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(t.epoch, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(t.sequence, 1, 1000) ||
      !integer(t.capturedAudioMs, 0, VOICE_MAX_CAPTURED_MS)
    )
      return false;
    if (t.sendRequestedAt !== null && !integer(t.sendRequestedAt, 0, Number.MAX_SAFE_INTEGER))
      return false;
    if (
      ![
        'recording',
        'paused',
        'finalizing',
        'finalized',
        'interrupted',
        'failed',
        'landed',
        'discarded',
      ].includes(t.storage)
    )
      return false;
    if (
      !t.origin ||
      typeof t.origin.streamId !== 'string' ||
      !t.origin.streamId ||
      [...t.origin.streamId].length > 160 ||
      typeof t.origin.generation !== 'string' ||
      !t.origin.generation ||
      [...t.origin.generation].length > 128 ||
      typeof t.origin.label !== 'string'
    )
      return false;
    if (
      !t.draft ||
      typeof t.draft.textPrefix !== 'string' ||
      !Array.isArray(t.draft.images) ||
      !Array.isArray(t.levels) ||
      !t.levels.every((n) => typeof n === 'number' && Number.isFinite(n))
    )
      return false;
    for (const i of t.draft.images)
      if (
        !i ||
        leaf(i.path) !== i.path ||
        !integer(i.bytes, 0, VOICE_MAX_OWNED_BYTES) ||
        typeof i.mimeType !== 'string'
      )
        return false;
    if (
      !t.operation ||
      Object.keys(t.operation).sort().join(',') !==
        'client_build,operation_id,operation_kind,origin_generation,origin_stream_id,version' ||
      t.operation.version !== 1 ||
      t.operation.operation_id !== t.recordingId ||
      t.operation.origin_stream_id !== t.origin.streamId ||
      t.operation.origin_generation !== t.origin.generation ||
      !['voice_chat', 'voice_answer'].includes(t.operation.operation_kind) ||
      typeof t.operation.client_build !== 'string' ||
      !t.operation.client_build
    )
      return false;
    if (
      !t.delivery ||
      ![
        'unsent',
        'queued',
        'uploading',
        'transcribing',
        'checking',
        'failed',
        'auth_needed',
        'origin_unavailable',
        'not_landed',
      ].includes(t.delivery.phase) ||
      !integer(t.delivery.retryCount, 0, Number.MAX_SAFE_INTEGER) ||
      (t.delivery.retryAt !== null && !integer(t.delivery.retryAt, 0, Number.MAX_SAFE_INTEGER))
    )
      return false;
    if (
      t.audio &&
      (leaf(t.audio.path) !== t.audio.path ||
        !['audio/mp4', 'audio/wav'].includes(t.audio.mime) ||
        !integer(t.audio.bytes, 1, VOICE_MAX_AUDIO_BYTES) ||
        !HASH.test(t.audio.sha256) ||
        !UUID.test(t.audio.uploadId))
    )
      return false;
    if (t.storage === 'finalized' && !t.audio) return false;
    if (
      t.upload &&
      (!t.audio ||
        !integer(t.upload.nextOffset, 0, t.audio.bytes) ||
        typeof t.upload.complete !== 'boolean' ||
        (t.upload.complete &&
          (t.upload.nextOffset !== t.audio.bytes || t.upload.blobSha !== t.audio.sha256)) ||
        (!t.upload.complete && t.upload.blobSha !== undefined))
    )
      return false;
    if (
      t.transcription &&
      (!t.audio ||
        t.transcription.blobSha !== t.audio.sha256 ||
        t.transcription.requestId !== `transcribe-${recordingId}` ||
        typeof t.transcription.result?.text !== 'string')
    )
      return false;
    if (
      t.dispatchIntent &&
      (!validateVoiceDispatchIntent(t.dispatchIntent) ||
        voiceScopeHash({
          serverIdentity: t.dispatchIntent.serverIdentity,
          credentialId: t.dispatchIntent.credentialId,
        }) !== t.scopeHash ||
        t.dispatchIntent.recordingId !== recordingId ||
        t.dispatchIntent.streamId !== t.origin.streamId ||
        t.dispatchIntent.originGeneration !== t.origin.generation ||
        t.dispatchIntent.sequence !== t.sequence ||
        t.sendRequestedAt === null)
    )
      return false;
    if (t.frozenAnswers && !validVoiceAnswersItems(t.frozenAnswers, t.capturedAudioMs))
      return false;
    if (t.questionBinding && !validVoiceQuestionSnapshot(t.questionBinding)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Single disk writer. An atomic manifest commit always precedes publication. */
export class VoiceTakeStore {
  private records = new Map<string, VoiceTakeManifest>();
  private failures = new Map<string, VoiceRecoveryFailure>();
  private epochs = new Map<string, number>();
  private writes = new Map<string, Promise<unknown>>();
  private createTail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private currentScope: string | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private state: VoiceTakeSnapshot = {
    takes: [],
    heldCount: 0,
    recoveryFailures: [],
    ready: false,
  };
  constructor(private readonly io: VoiceTakeIO = expoIO) {}
  snapshot = (): VoiceTakeSnapshot => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  get(id: string): VoiceTakeManifest | undefined {
    const t = this.records.get(id);
    return t?.scopeHash === this.currentScope && !terminal(t) ? t : undefined;
  }
  scopeHash = () => this.currentScope;
  invalidate(id: string): void {
    if (this.records.has(id)) this.epochs.set(id, this.epoch(id) + 1);
  }
  epoch(id: string): number {
    return this.epochs.get(id) ?? this.records.get(id)?.epoch ?? 0;
  }
  isCurrent(id: string, epoch: number): boolean {
    return this.epoch(id) === epoch && !!this.get(id);
  }
  async setScope(scope: VoiceScope | null): Promise<void> {
    this.currentScope = scope ? voiceScopeHash(scope) : null;
    this.publish();
    await this.restore();
  }
  private nativeUri(uri: string): string {
    if (
      !this.io.cacheRoot ||
      !uri.startsWith(this.io.cacheRoot) ||
      uri.includes('..') ||
      /%2e|%2f|%5c/i.test(uri) ||
      uri.includes('\\')
    )
      throw new VoiceStorageError('invalid_native_path');
    return uri;
  }
  private directory(t: Pick<VoiceTakeManifest, 'scopeHash' | 'recordingId'>): string {
    if (!HASH.test(t.scopeHash) || !UUID.test(t.recordingId))
      throw new VoiceStorageError('invalid_owned_path');
    return `${this.io.root}${t.scopeHash}/${t.recordingId}/`;
  }
  ownedUri(t: VoiceTakeManifest, path: string): string {
    return this.directory(t) + leaf(path);
  }
  audioUri(t: VoiceTakeManifest): string {
    if (!t.audio) throw new VoiceStorageError('audio_unavailable');
    return this.ownedUri(t, t.audio.path);
  }
  images(t: VoiceTakeManifest): ProcessedAsset[] {
    return t.draft.images.map(({ path, ...i }) => ({
      ...i,
      uri: this.ownedUri(t, path),
    }));
  }
  private publish() {
    const records = [...this.records.values()].filter((t) => !terminal(t));
    this.state = freeze({
      takes: records
        .filter((t) => t.scopeHash === this.currentScope)
        .sort((a, b) => a.createdAt - b.createdAt),
      heldCount:
        records.filter((t) => t.scopeHash !== this.currentScope).length +
        [...this.failures.values()].filter((f) => f.scopeHash !== this.currentScope).length,
      recoveryFailures: [...this.failures.values()].filter(
        (f) => f.scopeHash === this.currentScope,
      ),
      ready: this.loaded,
    });
    for (const fn of this.listeners) fn();
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(fn);
    this.writes.set(id, next);
    void next
      .finally(() => {
        if (this.writes.get(id) === next) this.writes.delete(id);
      })
      .catch(() => undefined);
    return next;
  }
  private async commit(next: VoiceTakeManifest): Promise<VoiceTakeManifest> {
    if (!validManifest(next, next.scopeHash, next.recordingId))
      throw new VoiceStorageError('invalid_manifest');
    const dir = this.directory(next);
    const guard = () => {
      if (this.epoch(next.recordingId) > next.epoch) throw new VoiceStorageError('voice_cancelled');
    };
    guard();
    await this.io.mkdir(dir);
    guard();
    const json = JSON.stringify(next);
    await this.io.write(`${dir}manifest.tmp.json`, json);
    guard();
    if (Platform.OS === 'ios') {
      // Locked legacy iOS text writes use Foundation atomically:true. Its moveAsync
      // unlinks the destination first, so it is NOT an atomic manifest replacement.
      await this.io.write(`${dir}manifest.json`, json);
      guard();
      await this.io.remove(`${dir}manifest.tmp.json`).catch(() => undefined);
    } else {
      // Locked Android file:// moveAsync uses same-directory File.renameTo.
      await this.io.move(`${dir}manifest.tmp.json`, `${dir}manifest.json`);
    }
    guard();
    const committed = freeze(clone(next));
    this.records.set(next.recordingId, committed);
    this.epochs.set(next.recordingId, Math.max(this.epoch(next.recordingId), next.epoch));
    this.publish();
    return committed;
  }
  restore(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.recover().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
  private async recover(): Promise<void> {
    if (!this.io.root.startsWith('file://') || !this.io.root.endsWith('/voice-takes-v1/'))
      throw new VoiceStorageError('storage_unavailable');
    await this.io.mkdir(this.io.root);
    const scopes = await this.io.list(this.io.root);
    for (const scopeHash of scopes.filter((s) => HASH.test(s))) {
      const ids = await this.io.list(`${this.io.root}${scopeHash}/`);
      for (const id of ids.filter((s) => UUID.test(s))) {
        const dir = this.directory({ scopeHash, recordingId: id });
        let t: VoiceTakeManifest;
        try {
          const raw = JSON.parse(await this.io.read(`${dir}manifest.json`));
          if (!validManifest(raw, scopeHash, id)) throw new VoiceStorageError('recovery_failed');
          t = freeze(raw);
          this.records.set(id, t);
          this.epochs.set(id, t.epoch);
          if (terminal(t)) {
            await this.cleanup(t).catch(() => undefined);
            continue;
          }
          if (
            t.storage === 'finalizing' &&
            t.audio &&
            !(await this.io.stat(this.audioUri(t))).exists &&
            t.nativeUri
          ) {
            const info = await this.io.inspect(this.nativeUri(t.nativeUri));
            if (info.bytes !== t.audio.bytes || info.sha256 !== t.audio.sha256)
              throw new VoiceStorageError('recovery_failed');
            await this.io.move(this.nativeUri(t.nativeUri), this.audioUri(t));
          }
          if (t.audio) {
            const info = await this.io.inspect(this.audioUri(t));
            if (info.bytes !== t.audio.bytes || info.sha256 !== t.audio.sha256)
              throw new VoiceStorageError('recovery_failed');
          }
          for (const i of t.draft.images) {
            const s = await this.io.stat(this.ownedUri(t, i.path));
            if (!s.exists || s.size !== i.bytes) throw new VoiceStorageError('recovery_failed');
          }
          if (['recording', 'paused', 'finalizing'].includes(t.storage)) {
            // Active M4A is only best-effort. Never resume native capture or enqueue it.
            if (t.audio)
              t = await this.commit({
                ...t,
                storage: 'interrupted',
                nativeUri: undefined,
                sendRequestedAt: null,
                delivery: { phase: 'unsent', retryCount: 0, retryAt: null },
              });
            else if (t.nativeUri) {
              try {
                t = await this.adoptRecovered(t);
              } catch {
                t = await this.commit({
                  ...t,
                  storage: 'failed',
                  sendRequestedAt: null,
                  delivery: {
                    phase: 'failed',
                    retryCount: 0,
                    retryAt: null,
                    error: 'interrupted_recording',
                  },
                });
              }
            } else
              t = await this.commit({
                ...t,
                storage: 'failed',
                sendRequestedAt: null,
                delivery: {
                  phase: 'failed',
                  retryCount: 0,
                  retryAt: null,
                  error: 'interrupted_recording',
                },
              });
          } else if (t.origin.generation === 'assistant-composite-v1') {
            await this.commit({
              ...t,
              delivery: {
                ...t.delivery,
                phase: 'origin_unavailable',
                retryAt: null,
                error: 'origin_unverifiable',
              },
            });
          } else if (t.dispatchIntent && t.delivery.phase !== 'not_landed') {
            await this.commit({
              ...t,
              delivery: { ...t.delivery, phase: 'checking', retryAt: null },
            });
          } else if (
            t.sendRequestedAt !== null &&
            !['failed', 'auth_needed', 'origin_unavailable', 'not_landed'].includes(
              t.delivery.phase,
            )
          ) {
            await this.commit({
              ...t,
              delivery: { ...t.delivery, phase: 'queued', retryAt: null },
            });
          }
          voiceLifecycle(id, 'storage', 'recovered');
        } catch {
          voiceLifecycle(id, 'storage', 'failed', { error: 'recovery_failed' });
          this.records.delete(id);
          this.failures.set(id, { id, scopeHash, error: 'recovery_failed' });
        }
      }
    }
    this.loaded = true;
    this.publish();
  }
  private async adoptRecovered(t: VoiceTakeManifest): Promise<VoiceTakeManifest> {
    const native = this.nativeUri(t.nativeUri!);
    const info = await this.io.inspect(native);
    if (info.bytes < 1 || info.bytes > VOICE_MAX_AUDIO_BYTES)
      throw new VoiceStorageError('interrupted_recording');
    const mime = native.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mp4';
    const audio: VoiceAudio = {
      path: mime === 'audio/wav' ? 'audio.wav' : 'audio.m4a',
      mime,
      ...info,
      uploadId: this.io.uuid(),
    };
    await this.commit({ ...t, storage: 'finalizing', audio });
    await this.io.move(native, this.ownedUri(t, audio.path));
    return this.commit({
      ...t,
      nativeUri: undefined,
      audio,
      storage: 'interrupted',
      sendRequestedAt: null,
      delivery: { phase: 'unsent', retryCount: 0, retryAt: null },
    });
  }
  private async ownedAssetBytes(directory = this.io.root, depth = 0): Promise<number> {
    if (depth > 8) throw new VoiceStorageError('storage_full');
    let bytes = 0;
    for (const name of await this.io.list(directory)) {
      leaf(name);
      if (name === 'manifest.json' || name === 'manifest.tmp.json') continue;
      const path = directory + name;
      const info = await this.io.stat(path);
      // Expo directories are returned without a slash; synthetic adapters may retain it.
      const directoryInfo = info.exists ? info : await this.io.stat(path + '/');
      if (directoryInfo.directory) bytes += await this.ownedAssetBytes(path + '/', depth + 1);
      else if (directoryInfo.exists) bytes += directoryInfo.size;
      if (!Number.isFinite(bytes) || bytes > VOICE_MAX_OWNED_BYTES)
        return VOICE_MAX_OWNED_BYTES + 1;
    }
    return bytes;
  }
  create(input: {
    scope: VoiceScope;
    origin: VoiceTakeManifest['origin'];
    draft?: { textPrefix: string; images: ProcessedAsset[] };
    operationKind?: VoiceOperation['operation_kind'];
    questionBinding?: VoiceQuestionSessionSnapshot;
  }): Promise<VoiceTakeManifest> {
    input = clone(input);
    const work = this.createTail
      .catch(() => undefined)
      .then(async () => {
        await this.restore();
        const scopeHash = voiceScopeHash(input.scope);
        if (scopeHash !== this.currentScope) throw new VoiceStorageError('auth_needed');
        const live = [...this.records.values()].filter((t) => !terminal(t));
        if (live.length + this.failures.size >= VOICE_MAX_TAKES)
          throw new VoiceStorageError('take_limit');
        const origin = clone(input.origin);
        if (
          !origin.streamId ||
          [...origin.streamId].length > 160 ||
          !origin.generation ||
          origin.generation === 'assistant-composite-v1' ||
          [...origin.generation].length > 128
        )
          throw new VoiceStorageError('origin_unverifiable');
        const images = await Promise.all(
          (input.draft?.images ?? []).map(async (image) => {
            const s = await this.io.stat(image.uri);
            if (!s.exists || s.directory || !integer(s.size, 1, VOICE_MAX_OWNED_BYTES))
              throw new VoiceStorageError('image_unavailable');
            return { ...image, bytes: s.size };
          }),
        );
        const reserve = VOICE_MAX_AUDIO_BYTES + images.reduce((n, i) => n + i.bytes, 0);
        let used = await this.ownedAssetBytes();
        for (const retained of live)
          if (!retained.audio || ['recording', 'paused', 'finalizing'].includes(retained.storage)) {
            const actual = retained.audio
              ? await this.io.stat(this.audioUri(retained))
              : { exists: false, size: 0 };
            used += Math.max(0, VOICE_MAX_AUDIO_BYTES - (actual.exists ? actual.size : 0));
          }
        if (used + reserve > VOICE_MAX_OWNED_BYTES || (await this.io.free()) < reserve)
          throw new VoiceStorageError('storage_full');
        if (scopeHash !== this.currentScope) throw new VoiceStorageError('auth_needed');
        const id = this.io.uuid();
        if (!UUID.test(id) || this.records.has(id))
          throw new VoiceStorageError('invalid_recording_id');
        const identity = getAppIdentity();
        const take: VoiceTakeManifest = {
          version: 1,
          scopeHash,
          recordingId: id,
          createdAt: this.io.now(),
          sendRequestedAt: null,
          epoch: 0,
          storage: 'recording',
          origin,
          draft: { textPrefix: input.draft?.textPrefix ?? '', images: [] },
          operation: {
            version: 1,
            operation_id: id,
            origin_stream_id: origin.streamId,
            origin_generation: origin.generation,
            operation_kind: input.operationKind ?? 'voice_chat',
            client_build: `${identity.version} (${identity.buildNumber})`,
          },
          capturedAudioMs: 0,
          levels: [],
          ...(input.questionBinding ? { questionBinding: clone(input.questionBinding) } : {}),
          delivery: { phase: 'unsent', retryCount: 0, retryAt: null },
          sequence: 1,
        };
        await this.io.mkdir(this.directory(take));
        try {
          for (let index = 0; index < images.length; index++) {
            const image = images[index];
            const path = `image-${index}.asset`;
            await this.io.copy(image.uri, this.ownedUri(take, path));
            const copied = await this.io.stat(this.ownedUri(take, path));
            if (!copied.exists || copied.size !== image.bytes)
              throw new VoiceStorageError('storage_write_failed');
            const { uri: _, ...rest } = image;
            take.draft.images.push({ ...rest, path });
            if (scopeHash !== this.currentScope) throw new VoiceStorageError('auth_needed');
          }
          const committed = await this.commit(take);
          voiceLifecycle(id, 'storage', 'owned');
          return committed;
        } catch (error) {
          // The draft has not transferred. Only our newly allocated owned directory is removed.
          await this.io.remove(this.directory(take)).catch(() => undefined);
          throw error;
        }
      });
    this.createTail = work;
    return work;
  }
  private mutate(
    id: string,
    change: (take: VoiceTakeManifest) => VoiceTakeManifest,
  ): Promise<VoiceTakeManifest> {
    const epoch = this.epoch(id);
    return this.serial(id, async () => {
      const t = this.get(id);
      if (!t || this.epoch(id) !== epoch) throw new VoiceStorageError('voice_cancelled');
      return this.commit(change(clone(t)));
    });
  }
  noteCapture(
    id: string,
    values: {
      nativeUri?: string;
      capturedAudioMs: number;
      phase: 'recording' | 'paused';
      levels?: number[];
      questionBinding?: VoiceQuestionSessionSnapshot;
    },
  ): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => ({
      ...t,
      storage: values.phase,
      nativeUri: values.nativeUri ? this.nativeUri(values.nativeUri) : t.nativeUri,
      capturedAudioMs: Math.min(
        VOICE_MAX_CAPTURED_MS,
        Math.max(0, Math.floor(values.capturedAudioMs)),
      ),
      levels: values.levels?.slice() ?? t.levels,
      ...(values.questionBinding ? { questionBinding: clone(values.questionBinding) } : {}),
    }));
  }
  adoptFinalized(
    id: string,
    values: {
      uri: string;
      mime: string;
      capturedAudioMs: number;
      levels?: number[];
      frozenAnswers?: VoiceAnswersItem[];
      questionBinding?: VoiceQuestionSessionSnapshot;
    },
  ): Promise<VoiceTakeManifest> {
    const epoch = this.epoch(id);
    return this.serial(id, async () => {
      let t = this.get(id);
      const guard = () => {
        if (!t || !this.isCurrent(id, epoch)) throw new VoiceStorageError('voice_cancelled');
      };
      guard();
      if (t!.storage === 'finalized' || t!.storage === 'interrupted') return t!;
      if (t!.storage === 'finalizing' && t!.audio) {
        const ownedPath = this.audioUri(t!);
        const existing = await this.io.stat(ownedPath);
        guard();
        if (existing.exists) {
          const verified = await this.io.inspect(ownedPath);
          guard();
          if (verified.bytes !== t!.audio!.bytes || verified.sha256 !== t!.audio!.sha256)
            throw new VoiceStorageError('audio_changed');
          return this.commit({
            ...t!,
            storage: 'finalized',
            nativeUri: undefined,
          });
        }
      }
      if (values.mime !== 'audio/mp4' && values.mime !== 'audio/wav')
        throw new VoiceStorageError('mime_unsupported');
      const source =
        values.uri === (t!.audio && this.audioUri(t!)) ? values.uri : this.nativeUri(values.uri);
      const info = await this.io.inspect(source);
      guard();
      if (info.bytes < 1 || info.bytes > VOICE_MAX_AUDIO_BYTES)
        throw new VoiceStorageError('audio_size');
      const audio: VoiceAudio = {
        path: values.mime === 'audio/wav' ? 'audio.wav' : 'audio.m4a',
        mime: values.mime,
        ...info,
        uploadId: t!.audio?.uploadId ?? this.io.uuid(),
      };
      t = await this.commit({
        ...t!,
        storage: 'finalizing',
        nativeUri: values.uri,
        audio,
        capturedAudioMs: Math.min(
          VOICE_MAX_CAPTURED_MS,
          Math.max(0, Math.floor(values.capturedAudioMs)),
        ),
        levels: values.levels?.slice() ?? t!.levels,
        ...(values.frozenAnswers ? { frozenAnswers: clone(values.frozenAnswers) } : {}),
        ...(values.questionBinding ? { questionBinding: clone(values.questionBinding) } : {}),
      });
      guard();
      const target = this.ownedUri(t, audio.path);
      if (values.uri !== target) {
        await this.io.move(values.uri, target);
        guard();
      }
      const owned = await this.io.inspect(target);
      guard();
      if (owned.bytes !== audio.bytes || owned.sha256 !== audio.sha256)
        throw new VoiceStorageError('audio_changed');
      return this.commit({ ...t, storage: 'finalized', nativeUri: undefined });
    });
  }
  requestSend(
    id: string,
    options: { frozenAnswers?: VoiceAnswersItem[] } = {},
  ): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => {
      if (!t.audio || !['finalized', 'interrupted'].includes(t.storage))
        throw new VoiceStorageError('audio_unavailable');
      if (
        t.operation.operation_kind === 'voice_answer' &&
        !(options.frozenAnswers ?? t.frozenAnswers)?.length
      )
        throw new VoiceStorageError('no_answers');
      if (t.sendRequestedAt !== null) return t;
      return {
        ...t,
        storage: 'finalized',
        sendRequestedAt: this.io.now(),
        ...(options.frozenAnswers ? { frozenAnswers: clone(options.frozenAnswers) } : {}),
        delivery: { phase: 'queued', retryCount: 0, retryAt: null },
      };
    });
  }
  setDelivery(
    id: string,
    delivery: Partial<VoiceTakeManifest['delivery']>,
  ): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => ({
      ...t,
      delivery: { ...t.delivery, ...delivery },
    }));
  }
  checkpointUpload(id: string, progress: VoiceUploadProgress): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => ({ ...t, upload: clone(progress) }));
  }
  saveTranscription(
    id: string,
    value: NonNullable<VoiceTakeManifest['transcription']>,
  ): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => ({ ...t, transcription: clone(value) }));
  }
  saveAttachments(id: string, attachments: ChatAttachment[]): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => ({ ...t, attachments: clone(attachments) }));
  }
  saveDispatchIntent(id: string, intent: VoiceDispatchIntent): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => {
      if (t.dispatchIntent && JSON.stringify(t.dispatchIntent) !== JSON.stringify(intent))
        throw new VoiceStorageError('immutable_dispatch_intent');
      return {
        ...t,
        dispatchIntent: clone(intent),
        delivery: { ...t.delivery, phase: 'checking', retryAt: null },
      };
    });
  }
  replaceRetryIntent(id: string, intent: VoiceDispatchIntent): Promise<VoiceTakeManifest> {
    return this.mutate(id, (t) => {
      if (
        t.delivery.phase !== 'not_landed' ||
        !t.dispatchIntent ||
        t.sequence >= 1000 ||
        intent.sequence !== t.sequence + 1 ||
        intent.optimisticId !== t.dispatchIntent.optimisticId ||
        intent.msgId !== t.dispatchIntent.msgId
      )
        throw new VoiceStorageError('invalid_retry');
      return {
        ...t,
        sequence: intent.sequence,
        dispatchIntent: clone(intent),
        delivery: {
          ...t.delivery,
          phase: 'checking',
          retryAt: null,
          error: undefined,
        },
      };
    });
  }
  async landed(id: string): Promise<void> {
    await this.terminate(id, 'landed');
  }
  async discard(id: string, options: { nativeUri?: string } = {}): Promise<void> {
    await this.terminate(id, 'discarded', options);
  }
  private terminate(
    id: string,
    storage: 'landed' | 'discarded',
    options: { nativeUri?: string } = {},
    onTerminalized?: (recordingId: string) => void,
  ): Promise<void> {
    const t = this.records.get(id);
    if (!t) return Promise.resolve();
    const nativeUri = options.nativeUri ? this.nativeUri(options.nativeUri) : undefined;
    if (nativeUri && t.nativeUri && nativeUri !== t.nativeUri)
      throw new VoiceStorageError('invalid_native_path');
    const epoch = this.epoch(id) + 1;
    this.epochs.set(id, epoch);
    return this.serial(id, async () => {
      const current = this.records.get(id);
      if (!current) return;
      const tombstone = await this.commit({
        ...current,
        ...(nativeUri ? { nativeUri } : {}),
        epoch,
        storage,
      });
      onTerminalized?.(id);
      await this.cleanup(tombstone);
    });
  }
  private async cleanup(t: VoiceTakeManifest): Promise<void> {
    const dir = this.directory(t);
    // This recursively removes only the UUID take directory, after a durable tombstone.
    if (t.nativeUri) await this.io.remove(this.nativeUri(t.nativeUri));
    const names = await this.io.list(dir);
    for (const name of names) if (name !== 'manifest.json') await this.io.remove(dir + leaf(name));
    const remaining = await this.io.list(dir);
    if (remaining.some((name) => name !== 'manifest.json'))
      throw new VoiceStorageError('cleanup_failed');
    await this.io.remove(`${dir}manifest.json`);
    await this.io.remove(dir);
    this.records.delete(t.recordingId);
    this.publish();
  }
  async discardHeld(onTerminalized?: (recordingId: string) => void): Promise<void> {
    // The user's action selects held data now, not whatever becomes held while
    // a disk await is pending. Snapshot both sets before the first await.
    const scope = this.currentScope;
    const recordingIds = [...this.records.values()]
      .filter((take) => take.scopeHash !== scope)
      .map((take) => take.recordingId);
    const failureIds = [...this.failures.values()]
      .filter((failure) => failure.scopeHash !== scope)
      .map((failure) => failure.id);
    for (const id of recordingIds) {
      // Notify at durable terminalization, before any potentially blocked cleanup.
      await this.terminate(id, 'discarded', {}, onTerminalized);
    }
    for (const id of failureIds) await this.removeRecoveryFailure(id);
  }
  async removeRecoveryFailure(id: string): Promise<void> {
    const f = this.failures.get(id);
    if (!f) return;
    await this.io.remove(this.directory({ scopeHash: f.scopeHash, recordingId: id }));
    this.failures.delete(id);
    this.publish();
  }
}
const expoIO: VoiceTakeIO = {
  root: `${FileSystem.documentDirectory ?? ''}voice-takes-v1/`,
  cacheRoot: FileSystem.cacheDirectory ?? '',
  now: () => Date.now(),
  uuid: () => uuid.v4(),
  stat: async (uri) => {
    const s = await FileSystem.getInfoAsync(uri);
    return {
      exists: s.exists,
      size: s.exists ? s.size : 0,
      directory: s.exists ? s.isDirectory : false,
    };
  },
  list: (uri) => FileSystem.readDirectoryAsync(uri),
  mkdir: (uri) => FileSystem.makeDirectoryAsync(uri, { intermediates: true }),
  read: (uri) => FileSystem.readAsStringAsync(uri),
  write: (uri, text) => FileSystem.writeAsStringAsync(uri, text),
  move: (from, to) => FileSystem.moveAsync({ from, to }),
  copy: (from, to) => FileSystem.copyAsync({ from, to }),
  remove: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
  free: () => FileSystem.getFreeDiskStorageAsync(),
  inspect: (uri) => inspectVoiceAudio(uri),
};
export const voiceTakeStore = new VoiceTakeStore();
const LIFECYCLE_STAGES = new Set([
  'capture',
  'storage',
  'upload',
  'transcribe',
  'delivery',
  'receipt',
]);
const LIFECYCLE_STATES = new Set([
  'owned',
  'started',
  'paused',
  'resumed',
  'finalized',
  'queued',
  'retried',
  'cancelled',
  'recovered',
  'stalled',
  'failed',
  'landed',
  'not_landed',
]);
const LIFECYCLE_ERRORS = new Set([
  'invalid_request',
  'upload_forbidden',
  'upload_conflict',
  'offset_mismatch',
  'digest_mismatch',
  'upload_expired',
  'upload_quota',
  'upload_blob_disk_full',
  'server_update_required',
  'invalid_upload_ack',
  'audio_changed',
  'audio_unavailable',
  'upload_failed',
  'backend_unavailable',
  'too_long',
  'mime_unsupported',
  'blob_unknown',
  'transcribe_failed',
  'transcribe_timeout',
  'auth_needed',
  'origin_unavailable',
  'origin_unverifiable',
  'attempt_limit',
  'storage_full',
  'storage_write_failed',
  'interrupted_recording',
  'no_answers',
  'no_speech',
  'image_upload_unavailable',
  'voice_failed',
  'recovery_failed',
  'capture_failed',
]);
/** A bounded public event envelope, never a container for native/transport exception text. */
export function voiceLifecycle(
  recordingId: string,
  stage: string,
  state: string,
  extra: {
    error?: string;
    retry_state?: number;
    byte_count?: number;
    total_bytes?: number;
  } = {},
) {
  if (!UUID.test(recordingId) || !LIFECYCLE_STAGES.has(stage) || !LIFECYCLE_STATES.has(state))
    return;
  const counters: Record<string, number | string> = {};
  if (extra.error !== undefined)
    counters.error = LIFECYCLE_ERRORS.has(extra.error) ? extra.error : 'voice_failed';
  for (const key of ['retry_state', 'byte_count', 'total_bytes'] as const)
    if (integer(extra[key], 0, Number.MAX_SAFE_INTEGER)) counters[key] = extra[key]!;
  logTelemetry(
    MOBILE_TELEMETRY_EVENTS.VOICE_DELIVERY_LIFECYCLE as Parameters<typeof logTelemetry>[0],
    {
      subsystem: 'voice_delivery',
      bug_ref: 'continuous_voice',
      recording_id: recordingId,
      operation_id: recordingId,
      stage,
      state,
      ...counters,
    },
  );
}
