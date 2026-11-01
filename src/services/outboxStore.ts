import { logTelemetry } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from './mobileTelemetryEvents';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readVoiceRange, VOICE_UPLOAD_CHUNK_BYTES } from './voiceUpload';
import { Platform } from 'react-native';
import {
  voiceScopeHash,
  VoiceStorageError,
  voiceTakeIO,
  type VoiceScope,
  type VoiceTakeIO,
} from './voiceTakeStore';
import type { ProcessedAsset } from './imageCapture';

export const OUTBOX_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
type Base = {
  id: string;
  scopeHash: string;
  createdAt: number;
  error?: string;
  removed?: boolean;
};
export type OutboxText = Base & {
  kind: 'text';
  streamId: string;
  originGeneration?: string | null;
  frame: Record<string, unknown>;
};
export type OutboxPhoto = Omit<OutboxText, 'kind'> & {
  kind: 'photo';
  operationId: string;
  committed: boolean;
  uploaded: string[];
  mandateFailed?: boolean;
  attachments: Array<{
    sha256: string;
    mime: string;
    width?: number;
    height?: number;
    bytes: number;
    staged_path: string;
  }>;
};
export type OutboxEntry =
  | OutboxText
  | OutboxPhoto
  | (Base & {
      kind: 'prompt_answer';
      frame: Record<string, unknown>;
      notificationId?: string;
    })
  | (Base & {
      kind: 'notification_resolve';
      frame: Record<string, unknown>;
      survivor: Record<string, unknown>;
    })
  | (Base & {
      kind: 'legacy_answer';
      dismiss: { host: string; session_name: string; question_key: string };
      send: Omit<OutboxText, 'scopeHash'>;
      legs: { dismissed: boolean };
    })
  | (Base & { kind: 'draft'; streamId: string; text: string });
type Input<T> = T extends OutboxEntry ? Omit<T, 'scopeHash'> : never;
export type OutboxSnapshot = {
  entries: readonly Exclude<OutboxEntry, { kind: 'draft' }>[];
  drafts: Readonly<Record<string, string>>;
  heldCount: number;
  ready: boolean;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const immutable = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(immutable);
  }
  return value;
};
const hashPattern = /^[a-f0-9]{64}$/;
const leaf = (v: string) => {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(v)) throw new VoiceStorageError('invalid_owned_path');
  return v;
};
/** One owner for manifests, copied assets and the serial replay of non-generic units. */
export class OutboxStore {
  private scope: string | null = null;
  private records = new Map<string, OutboxEntry>();
  private listeners = new Set<() => void>();
  private writes = new Map<string, Promise<unknown>>();
  private admission: Promise<unknown> = Promise.resolve();
  private loading?: Promise<void>;
  private loaded = false;
  private state: OutboxSnapshot = {
    entries: [],
    drafts: {},
    heldCount: 0,
    ready: false,
  };
  constructor(private readonly injectedIO?: VoiceTakeIO) {}
  private get io(): VoiceTakeIO {
    return (
      this.injectedIO ?? {
        ...voiceTakeIO,
        root: voiceTakeIO.root.replace(/voice-takes-v1\/$/, 'outbox-v1/'),
        inspect: async (uri) => {
          const info = await voiceTakeIO.stat(uri),
            digest = sha256.create();
          for (let offset = 0; offset < info.size; offset += VOICE_UPLOAD_CHUNK_BYTES)
            digest.update(
              await readVoiceRange(
                uri,
                offset,
                Math.min(VOICE_UPLOAD_CHUNK_BYTES, info.size - offset),
              ),
            );
          return { bytes: info.size, sha256: bytesToHex(digest.digest()) };
        },
      }
    );
  }
  snapshot = () => this.state;
  scopeHash = () => this.scope;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private key(scopeHash: string, id: string) {
    return `${scopeHash}/${leaf(id)}`;
  }
  private directory(e: Pick<OutboxEntry, 'scopeHash' | 'id'>) {
    if (!hashPattern.test(e.scopeHash)) throw new VoiceStorageError('invalid_owned_path');
    return this.io.root + this.key(e.scopeHash, e.id) + '/';
  }
  private publish() {
    const visible = [...this.records.values()].filter(
      (e) => !e.removed && e.scopeHash === this.scope,
    );
    this.state = {
      entries: visible
        .filter((e): e is Exclude<OutboxEntry, { kind: 'draft' }> => e.kind !== 'draft')
        .sort((a, b) => a.createdAt - b.createdAt),
      drafts: Object.fromEntries(
        visible.filter((e) => e.kind === 'draft').map((e) => [e.streamId, e.text]),
      ),
      heldCount: [...this.records.values()].filter((e) => !e.removed && e.scopeHash !== this.scope)
        .length,
      ready: this.loaded,
    };
    for (const fn of this.listeners) fn();
  }
  async setScope(scope: VoiceScope | null) {
    this.scope = scope ? voiceScopeHash(scope) : null;
    this.publish();
    await this.restore();
  }
  get(id: string) {
    const e = this.scope && this.records.get(this.key(this.scope, id));
    return e && !e.removed ? e : undefined;
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.writes.set(key, next);
    void next
      .finally(() => {
        if (this.writes.get(key) === next) this.writes.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
  private async commit(e: OutboxEntry) {
    const dir = this.directory(e),
      value = clone(e);
    await this.io.mkdir(dir);
    const json = JSON.stringify(value);
    await this.io.write(dir + 'manifest.tmp.json', json);
    if (Platform.OS === 'ios') {
      await this.io.write(dir + 'manifest.json', json);
      await this.io.remove(dir + 'manifest.tmp.json').catch(() => undefined);
    } else await this.io.move(dir + 'manifest.tmp.json', dir + 'manifest.json');
    this.records.set(this.key(e.scopeHash, e.id), immutable(value));
    this.publish();
    if (e.kind !== 'draft')
      logTelemetry(
        MOBILE_TELEMETRY_EVENTS.OUTBOX_DELIVERY_LIFECYCLE as Parameters<typeof logTelemetry>[0],
        {
          subsystem: 'outbox',
          bug_ref: 'voice_server_side_send_after_upload',
          kind: e.kind,
          state: e.removed ? 'removed' : e.error ? 'failed' : 'saved',
        },
      );
    return value;
  }
  restore(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    return (this.loading ??= this.recover().finally(() => {
      this.loading = undefined;
    }));
  }
  private async recover() {
    if (!this.io.root.startsWith('file://') || !this.io.root.endsWith('/outbox-v1/'))
      throw new VoiceStorageError('storage_unavailable');
    await this.io.mkdir(this.io.root);
    for (const scopeHash of (await this.io.list(this.io.root)).filter((s) => hashPattern.test(s))) {
      for (const id of await this.io.list(this.io.root + scopeHash + '/')) {
        try {
          const dir = this.directory({ scopeHash, id });
          const e = JSON.parse(await this.io.read(dir + 'manifest.json')) as OutboxEntry;
          if (
            e.id !== id ||
            e.scopeHash !== scopeHash ||
            !Number.isSafeInteger(e.createdAt) ||
            ![
              'text',
              'photo',
              'draft',
              'prompt_answer',
              'legacy_answer',
              'notification_resolve',
            ].includes(e.kind)
          )
            continue;
          if (
            e.kind === 'photo' &&
            e.attachments.some(
              (a) =>
                !a.staged_path.startsWith(dir) ||
                a.staged_path.slice(dir.length).includes('/') ||
                a.staged_path.includes('..'),
            )
          )
            continue;
          this.records.set(this.key(scopeHash, id), immutable(e));
          if (e.removed) await this.cleanup(e);
        } catch {
          /* Partial staging is retained and counted; it has never transferred ownership. */
        }
      }
    }
    this.loaded = true;
    this.publish();
  }
  async put<T extends OutboxEntry>(input: Input<T>): Promise<T> {
    const scopeHash = this.scope;
    if (!scopeHash) throw new VoiceStorageError('auth_needed');
    const value = clone({ ...input, scopeHash }) as unknown as T;
    await this.restore();
    return this.serial(this.key(scopeHash, value.id), async () => {
      if (scopeHash !== this.scope) throw new VoiceStorageError('auth_needed');
      return (await this.commit(value)) as T;
    });
  }
  update(id: string, change: (e: OutboxEntry) => OutboxEntry): Promise<OutboxEntry> {
    const scopeHash = this.scope;
    if (!scopeHash) return Promise.reject(new VoiceStorageError('auth_needed'));
    return this.serial(this.key(scopeHash, id), async () => {
      const e = this.get(id);
      if (!e || this.scope !== scopeHash) throw new VoiceStorageError('auth_needed');
      return this.commit(change(clone(e)));
    });
  }
  private async retainedBytes(dir = this.io.root, depth = 0): Promise<number> {
    if (depth > 8) throw Object.assign(new VoiceStorageError('storage_full'), {message:'Could not save the message. Free storage and retry.'});
    let total = 0;
    for (const name of await this.io.list(dir)) {
      if (name.includes('/') || name === '..') throw new VoiceStorageError('invalid_owned_path');
      const s = await this.io.stat(dir + name);
      if (s.directory) total += await this.retainedBytes(dir + name + '/', depth + 1);
      else if (!name.startsWith('manifest.')) total += s.size;
    }
    return total;
  }
  putPhoto(input: Omit<OutboxPhoto, 'scopeHash'>, assets: ProcessedAsset[]): Promise<OutboxPhoto> {
    const scopeHash = this.scope,
      frozen = clone(input),
      sources = clone(assets);
    const work = this.admission
      .catch(() => undefined)
      .then(async () => {
        await this.restore();
        if (!scopeHash || scopeHash !== this.scope) throw new VoiceStorageError('auth_needed');
        const existing = this.get(input.id);
        if (existing?.kind === 'photo') return existing;
        const infos = await Promise.all(sources.map((a) => this.io.stat(a.uri)));
        const bytes = infos.reduce((n, s) => n + s.size, 0);
        if (
          sources.length > 5 ||
          infos.some((s) => !s.exists || s.directory || s.size < 1 || s.size > 4 * 1024 * 1024) ||
          bytes > OUTBOX_MAX_ENTRY_BYTES ||
          (await this.retainedBytes()) + bytes > OUTBOX_MAX_BYTES ||
          (await this.io.free()) < bytes
        )
          throw Object.assign(new VoiceStorageError('storage_full'), {message:'Could not save the message. Free storage and retry.'});
        const entry: OutboxPhoto = { ...frozen, scopeHash, attachments: [] };
        const dir = this.directory(entry);
        await this.io.mkdir(dir);
        try {
          for (const [index, asset] of sources.entries()) {
            const staged_path = dir + `image-${index}.asset`;
            await this.io.copy(asset.uri, staged_path);
            // Image digests use the generic inspector; audio container validation is not applicable.
            const { bytes: copiedBytes, sha256 } = await this.io.inspect(staged_path);
            if (copiedBytes !== infos[index].size || scopeHash !== this.scope)
              throw new VoiceStorageError('storage_write_failed');
            entry.attachments.push({
              staged_path,
              sha256,
              bytes: copiedBytes,
              mime: asset.mimeType,
              ...(asset.width ? { width: asset.width } : {}),
              ...(asset.height ? { height: asset.height } : {}),
            });
          }
          return await this.put<OutboxPhoto>(entry);
        } catch (error) {
          await this.io.remove(dir).catch(() => undefined);
          throw error;
        }
      });
    this.admission = work;
    return work;
  }
  async setDraft(streamId: string, text: string) {
    const id = 'draft-' + voiceScopeHash({ serverIdentity: streamId, credentialId: 'draft' });
    await this.put({
      kind: 'draft',
      id,
      createdAt: this.io.now(),
      streamId,
      text,
    });
  }
  async remove(id: string) {
    const e = this.get(id);
    if (!e) return;
    await this.serial(this.key(e.scopeHash, id), async () => {
      const current = this.records.get(this.key(e.scopeHash, id));
      if (!current) return;
      await this.cleanup(await this.commit({ ...current, removed: true }));
    });
  }
  private async cleanup(e: OutboxEntry) {
    await this.io.remove(this.directory(e));
    this.records.delete(this.key(e.scopeHash, e.id));
    this.publish();
  }
  async discardHeld() {
    const selected = [...this.records.values()].filter((e) => e.scopeHash !== this.scope);
    for (const e of selected)
      await this.serial(this.key(e.scopeHash, e.id), async () =>
        this.cleanup(await this.commit({ ...e, removed: true })),
      );
  }
}
export const outboxStore = new OutboxStore();
