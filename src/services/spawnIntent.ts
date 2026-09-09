// Client-side spawn intent identity for
// public_behavior_spec.
//
// One operator intent to start a chat gets one id. The id travels with the spawn command as
// `idempotency_key`; the public transport serving the app — the transport adapter
// spawnctl.py` — folds the check and the claim into one atomic `atomic_claim_or_replay`, so N
// concurrent same-key fires admit exactly one session and the losers replay the winner's `spawn.ok`
// instead of launching a second. That is what makes the fix hold for the paths a UI guard cannot
// see — a retry after a timeout, a resend after a reconnect, a screen remount — not just rapid taps.

export type SpawnIntentSelection = {
  host: string;
  provider: string;
  model: string;
  effort: string;
  catalogVersion: string;
};

// How the previous attempt on an intent ended, which decides whether its id may be replayed.
//   'succeeded' — the chat exists; the intent is over.
//   'rejected'  — the daemon answered with an error, so it stored that error under the key. v2
//                 replays a terminal FAILED outcome as that same stored failure, so replaying the
//                 key would replay the error forever; an explicit retry is a new intent.
//   'ambiguous' — transport/timeout/indeterminate. The daemon may already have created the chat,
//                 so the retry MUST reuse the key to collapse onto the original session.
export type SpawnIntentOutcome = 'succeeded' | 'rejected' | 'ambiguous';

// v1 rejects a key longer than 128 chars outright; v2 sets no limit of its own. Stay inside the
// stricter bound so the key is valid against either daemon.
const MAX_KEY_LENGTH = 128;

export function spawnIntentSignature(selection: SpawnIntentSelection): string {
  return [
    selection.host,
    selection.provider,
    selection.model,
    selection.effort,
    selection.catalogVersion,
  ].join('|');
}

export function mintSpawnIntentKey(): string {
  return `mob-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.slice(0, MAX_KEY_LENGTH);
}

export type SpawnIntentKeeper = {
  /** The id for this selection: the id already held for it, or a fresh one. */
  claim(selection: SpawnIntentSelection): string;
  /** Record how the attempt ended; only an ambiguous outcome keeps the id replayable. */
  settle(outcome: SpawnIntentOutcome): void;
  /** Drop any held id (the sheet closed, so the next submit is a new intent). */
  reset(): void;
};

export function createSpawnIntentKeeper(
  mint: () => string = mintSpawnIntentKey,
): SpawnIntentKeeper {
  let held: { signature: string; key: string } | null = null;
  return {
    claim(selection) {
      const signature = spawnIntentSignature(selection);
      // A changed tuple is a different intent, and reusing the key across it would hash
      // differently and earn an `idempotency_conflict` from the daemon.
      if (!held || held.signature !== signature) held = { signature, key: mint() };
      return held.key;
    },
    settle(outcome) {
      if (outcome === 'ambiguous') return;
      held = null;
    },
    reset() {
      held = null;
    },
  };
}

// A spawn failure is only safe to retry under a fresh id when the daemon actually answered.
// Anything else — no answer, an ambiguous answer — may have left a session behind.
export function classifySpawnFailure(error: unknown): SpawnIntentOutcome {
  const errorCode = String((error as { errorCode?: string } | null)?.errorCode || '');
  if (!errorCode) return 'ambiguous';
  // v2 signals an in-flight duplicate with a `spawn.indeterminate` frame, which the stream layer
  // settles as `spawn_indeterminate`; `idempotency_in_flight_timeout` is v1's name for the same
  // thing. Both mean the action is committed and only its confirmation is pending — keeping the key
  // is what lets the retry converge onto the winner rather than mint a second chat.
  if (errorCode === 'spawn_indeterminate' || errorCode === 'idempotency_in_flight_timeout') return 'ambiguous';
  return 'rejected';
}

export async function executeSpawnIntent<T>(
  keeper: SpawnIntentKeeper,
  selection: SpawnIntentSelection,
  spawn: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
  const idempotencyKey = keeper.claim(selection);
  try {
    const result = await spawn(idempotencyKey);
    keeper.settle('succeeded');
    return result;
  } catch (error) {
    keeper.settle(classifySpawnFailure(error));
    throw error;
  }
}
