// new_chat_spawn_contract — intent identity rules.
import {
  classifySpawnFailure,
  createSpawnIntentKeeper,
  executeSpawnIntent,
  mintSpawnIntentKey,
  spawnIntentSignature,
} from '../src/services/spawnIntent';

const selection = {
  host: 'hostc',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  catalogVersion: 'spawn-catalog-v1',
};

test('one intent keeps one key across repeated claims', () => {
  const keeper = createSpawnIntentKeeper();
  expect(keeper.claim(selection)).toBe(keeper.claim(selection));
});

test('an ambiguous outcome keeps the key so the retry replays it', () => {
  const keeper = createSpawnIntentKeeper();
  const first = keeper.claim(selection);
  keeper.settle('ambiguous');
  expect(keeper.claim(selection)).toBe(first);
});

test('success and daemon-answered rejection both end the intent', () => {
  for (const outcome of ['succeeded', 'rejected'] as const) {
    const keeper = createSpawnIntentKeeper();
    const first = keeper.claim(selection);
    keeper.settle(outcome);
    expect(keeper.claim(selection)).not.toBe(first);
  }
});

test('a changed tuple is a new intent, so the daemon never sees a key with two payload hashes', () => {
  const keeper = createSpawnIntentKeeper();
  const first = keeper.claim(selection);
  expect(keeper.claim({ ...selection, effort: 'xhigh' })).not.toBe(first);
});

test('reset drops the held key', () => {
  const keeper = createSpawnIntentKeeper();
  const first = keeper.claim(selection);
  keeper.reset();
  expect(keeper.claim(selection)).not.toBe(first);
});

test('signatures separate every tuple field', () => {
  const base = spawnIntentSignature(selection);
  for (const field of ['host', 'provider', 'model', 'effort', 'catalogVersion'] as const) {
    expect(spawnIntentSignature({ ...selection, [field]: 'changed' })).not.toBe(base);
  }
});

test('minted keys are unique and inside the daemon 128-char limit', () => {
  const keys = new Set(Array.from({ length: 200 }, () => mintSpawnIntentKey()));
  expect(keys.size).toBe(200);
  for (const key of keys) expect(key.length).toBeLessThanOrEqual(128);
});

test('only a daemon-answered error code is safe to retry under a fresh key', () => {
  expect(classifySpawnFailure(new Error('Pentacle stream is not connected'))).toBe('ambiguous');
  expect(classifySpawnFailure(undefined)).toBe('ambiguous');
  expect(classifySpawnFailure({ errorCode: 'spawn_indeterminate' })).toBe('ambiguous');
  expect(classifySpawnFailure({ errorCode: 'idempotency_in_flight_timeout' })).toBe('ambiguous');
  expect(classifySpawnFailure({ errorCode: 'spawn_catalog_version_conflict' })).toBe('rejected');
});

test('executeSpawnIntent owns claim and successful settlement without changing the caller result', async () => {
  const keeper = createSpawnIntentKeeper(() => 'intent-success');
  const spawn = jest.fn(async (idempotencyKey: string) => ({ session: { stream_id: 'S1' }, idempotencyKey }));

  await expect(executeSpawnIntent(keeper, selection, spawn)).resolves.toEqual({
    session: { stream_id: 'S1' },
    idempotencyKey: 'intent-success',
  });
  expect(spawn).toHaveBeenCalledWith('intent-success');
});

test('executeSpawnIntent retains an indeterminate key but rotates after a known rejection', async () => {
  const keys = ['intent-1', 'intent-2'];
  const keeper = createSpawnIntentKeeper(() => keys.shift() || 'unexpected');
  const seen: string[] = [];
  const attempt = (error?: unknown) => executeSpawnIntent(keeper, selection, async (key) => {
    seen.push(key);
    if (error) throw error;
    return true;
  });

  await expect(attempt(new Error('transport lost'))).rejects.toThrow('transport lost');
  await expect(attempt({ errorCode: 'spawn_catalog_version_conflict' })).rejects.toEqual({
    errorCode: 'spawn_catalog_version_conflict',
  });
  await expect(attempt()).resolves.toBe(true);
  expect(seen).toEqual(['intent-1', 'intent-1', 'intent-2']);
});

