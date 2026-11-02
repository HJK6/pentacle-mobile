import { OutboxStore, OUTBOX_MAX_BYTES, type OutboxEntry } from '../src/services/outboxStore';
import type { VoiceTakeIO } from '../src/services/voiceTakeStore';
const scope = {
  serverIdentity: 'wss://synthetic.invalid/ws',
  credentialId: 'operator-a',
};
export function disk() {
  let n = 0;
  const files = new Map<string, string>(),
    dirs = new Set<string>();
  const io: VoiceTakeIO = {
    root: 'file:///documents/outbox-v1/',
    cacheRoot: 'file:///cache/',
    now: () => 1000,
    uuid: () => `123e4567-e89b-42d3-a456-${String(++n).padStart(12, '0')}`,
    stat: async (p) => ({
      exists: files.has(p) || dirs.has(p) || dirs.has(p + '/'),
      size: files.get(p)?.length ?? 0,
      directory: dirs.has(p) || dirs.has(p + '/'),
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
    write: async (p, s) => {
      files.set(p, s);
    },
    move: async (a, b) => {
      if (!files.has(a)) throw Error('ENOENT');
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    copy: async (a, b) => {
      if (!files.has(a)) throw Error('ENOENT');
      files.set(b, files.get(a)!);
    },
    remove: async (p) => {
      for (const k of [...files.keys()])
        if (k === p || k.startsWith(p.endsWith('/') ? p : p + '/')) files.delete(k);
      dirs.delete(p);
    },
    free: async () => OUTBOX_MAX_BYTES * 2,
    inspect: async (p) => ({
      bytes: files.get(p)!.length,
      sha256: 'a'.repeat(64),
    }),
  };
  return { io, files, dirs };
}
const text = {
  kind: 'text' as const,
  id: 'send-1',
  createdAt: 1000,
  streamId: 'hosta:chat',
  frame: {
    type: 'send',
    request_id: 'send-1',
    optimistic_id: 'opt-1',
    host: 'hosta',
    session_name: 'chat',
    text: 'Synthetic message',
  },
};
test('U9 atomic outbox write restores exact identities and drafts after process death', async () => {
  const f = disk(),
    s = new OutboxStore(f.io);
  await s.setScope(scope);
  await s.put(text);
  await s.setDraft('hosta:chat', 'Synthetic draft');
  const fresh = new OutboxStore(f.io);
  await fresh.setScope(scope);
  expect(fresh.snapshot().entries).toEqual([expect.objectContaining(text)]);
  expect(fresh.snapshot().drafts['hosta:chat']).toBe('Synthetic draft');
  await fresh.remove(text.id);
  const again = new OutboxStore(f.io);
  await again.setScope(scope);
  expect(again.snapshot().entries).toEqual([]);
});
test('U9 authority switches hide and retain entries and drafts; discard held deletes only the selected scope', async () => {
  const f = disk(),
    s = new OutboxStore(f.io);
  await s.setScope(scope);
  await s.put(text);
  await s.setDraft('hosta:chat', 'draft');
  await s.setScope({ ...scope, credentialId: 'operator-b' });
  expect(s.snapshot()).toMatchObject({ entries: [], drafts: {}, heldCount: 2 });
  await s.setScope({ ...scope, serverIdentity: 'wss://other.invalid/ws' });
  expect(s.snapshot().entries).toEqual([]);
  await s.setScope(scope);
  expect(s.snapshot().entries).toHaveLength(1);
  await s.setScope(null);
  await s.discardHeld();
  await s.setScope(scope);
  expect(s.snapshot().entries).toEqual([]);
});
test('U12 photo copies are owned and removed only after a durable tombstone', async () => {
  const f = disk(),
    s = new OutboxStore(f.io);
  await s.setScope(scope);
  f.files.set('file:///picker/image.jpg', 'bytes');
  const p = await s.putPhoto(
    {
      ...text,
      kind: 'photo',
      id: 'photo-1',
      operationId: '123e4567-e89b-42d3-a456-000000000001',
      originGeneration: 'generation-1',
      committed: false,
      uploaded: [],
      attachments: [],
    },
    [
      {
        uri: 'file:///picker/image.jpg',
        bytes: 5,
        mimeType: 'image/jpeg',
        fileName: 'image.jpg',
        width: 2,
        height: 2,
      },
    ],
  );
  expect(f.files.get(p.attachments[0].staged_path)).toBe('bytes');
  f.files.delete('file:///picker/image.jpg');
  const fresh = new OutboxStore(f.io);
  await fresh.setScope(scope);
  expect(fresh.get(p.id)).toEqual(p);
  await fresh.remove(p.id);
  expect(f.files.has(p.attachments[0].staged_path)).toBe(false);
});
test('U9 cap refusal preserves draft, source assets and all unlanded entries before any wire attempt', async () => {
  const f = disk(),
    s = new OutboxStore(f.io);
  await s.setScope(scope);
  await s.setDraft('hosta:chat', 'keep');
  f.files.set('file:///picker/image.jpg', 'bytes');
  const stat = f.io.stat;
  f.io.stat = async (p) =>
    p.endsWith('image.jpg')
      ? { exists: true, size: 4 * 1024 * 1024 }
      : p.endsWith('.asset')
        ? { exists: true, size: 60 * 1024 * 1024 }
        : stat(p);
  // Count retained orphan bytes too: interrupted staging cannot bypass the cap.
  await f.io.mkdir(f.io.root + 'orphan/');
  f.files.set(f.io.root + 'orphan/image.asset', 'retained');
  await expect(
    s.putPhoto(
      {
        ...text,
        kind: 'photo',
        id: 'photo-1',
        operationId: 'op',
        originGeneration: 'g',
        committed: false,
        uploaded: [],
        attachments: [],
      },
      Array.from({ length: 5 }, () => ({
        uri: 'file:///picker/image.jpg',
        bytes: 4 * 1024 * 1024,
        mimeType: 'image/jpeg',
        fileName: 'image.jpg',
        width: 2,
        height: 2,
      })),
    ),
  ).rejects.toMatchObject({ code: 'storage_full' });
  expect(s.snapshot().drafts['hosta:chat']).toBe('keep');
  expect(f.files.get('file:///picker/image.jpg')).toBe('bytes');
});

test('U9 a fully typed draft survives kill 500ms later without draining obsolete keystroke writes', async () => {
  jest.useFakeTimers();
  const f = disk(), store = new OutboxStore(f.io);
  await store.setScope(scope);
  const write = f.io.write;
  let killed = false;
  f.io.write = async (path, value) => {
    // Only the filesystem boundary is delayed. Every keystroke reaches the real store.
    await new Promise(resolve => setTimeout(resolve, 12));
    if (killed) throw new Error('process killed');
    await write(path, value);
  };
  const complete = 'TEST P2 T2 retained draft ACKdrop';
  const pending: Promise<unknown>[] = [];
  try {
    for (let end = 1; end <= complete.length; end++) {
      pending.push(store.setDraft('hosta:chat', complete.slice(0, end)).catch(() => undefined));
    }
    // Same bounded post-typing interval as the configured RED. No flush/await of saves.
    await jest.advanceTimersByTimeAsync(500);
    killed = true;
    const persisted = new Map(f.files), directories = new Set(f.dirs);
    await jest.runAllTimersAsync();
    await Promise.all(pending);
    const relaunched = disk();
    persisted.forEach((value, path) => relaunched.files.set(path, value));
    directories.forEach(path => relaunched.dirs.add(path));
    const recovered = new OutboxStore(relaunched.io);
    await recovered.setScope(scope);
    expect(recovered.snapshot().drafts['hosta:chat']).toBe(complete);
  } finally {
    jest.useRealTimers();
  }
});

test.each(['The latest edit', ''])('U9 an edit during an in-flight save retains the latest value %j', async latest => {
  const f = disk(), store = new OutboxStore(f.io);
  await store.setScope(scope);
  const write = f.io.write;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.io.write = async (path, value) => {
    if (first) { first = false; entered(); await gate; }
    await write(path, value);
  };
  const saving = store.setDraft('hosta:chat', 'Obsolete prefix');
  await held;
  const editing = store.setDraft('hosta:chat', latest);
  release();
  await Promise.all([saving, editing]);
  const recovered = new OutboxStore(f.io);
  await recovered.setScope(scope);
  expect(recovered.snapshot().drafts['hosta:chat']).toBe(latest);
});

test('U9 pending edits never cross the credential scope while an older save completes', async () => {
  const f = disk(), store = new OutboxStore(f.io);
  await store.setScope(scope);
  const write = f.io.write;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.io.write = async (path, value) => {
    if (first) { first = false; entered(); await gate; }
    await write(path, value);
  };
  const saving = store.setDraft('hosta:chat', 'Old account');
  await held;
  const editing = store.setDraft('hosta:chat', 'Old account tail').catch(() => undefined);
  const other = { ...scope, credentialId: 'operator-b' };
  await store.setScope(other);
  await store.setDraft('hosta:chat', 'Other account');
  release();
  await Promise.all([saving, editing]);
  const recovered = new OutboxStore(f.io);
  await recovered.setScope(other);
  expect(recovered.snapshot().drafts['hosta:chat']).toBe('Other account');
  await recovered.setScope(scope);
  expect(recovered.snapshot().drafts['hosta:chat']).toBe('Old account');
});
