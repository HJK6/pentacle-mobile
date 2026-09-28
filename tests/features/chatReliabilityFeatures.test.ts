/**
 * Public chat-reliability test coverage ledger.
 *
 * Operator framing (2026-06-20): this lane tracks an *enumeration of features
 * that have tests*, not ad-hoc "regressions". Every reproduced bug becomes a
 * FEATURE here with a stable id and a guarding test that runs in the normal
 * gate. The "no drift" meta-test below FAILS if any enumerated feature points at
 * a missing test file (or a missing in-file marker), so the ledger can never
 * silently fall out of sync with the suite.
 *
 * Adding a feature:
 *   1. Reproduce the bug as a deterministic test; put the FEAT id in its name so
 *      it is greppable (e.g. `FEAT-LOAD-RECOVERY: ...`).
 *   2. Add a row to FEATURES with `coveredBy` pointing at it.
 *
 * `coveredBy` ref forms (relative to the pentacle-mobile repo root):
 *   - "<test file path>"            → the file must exist.
 *   - "<test file path>::<marker>"  → the file must exist AND contain <marker>
 *                                     (use the FEAT id or a unique test-name
 *                                      substring as the marker).
 * App tests run under `npx jest`; chat-core tests under
 * `cd pentacle-chat-core && npm test`. Both are referenced from this one ledger
 * by relative path so the whole lane is enumerable from a single place.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

type FeatureArea = 'loading' | 'send' | 'attribution' | 'scroll' | 'liveness';

type Feature = {
  id: string;
  area: FeatureArea;
  title: string;
  origin: string; // the operator-reported symptom / bug this feature came from
  status: 'shipped' | 'in_progress';
  coveredBy: string[];
};

const FEATURES: Feature[] = [
  // ── Loading ────────────────────────────────────────────────────────────────
  {
    id: 'FEAT-LOAD-NO-WIPE',
    area: 'loading',
    title:
      'an empty summary-mode snapshot does not wipe the in-memory transcript (only a non-empty events array replaces)',
    origin: '"only my messages" / "recent message + blank above" on reconnect',
    status: 'shipped',
    coveredBy: ['pentacle-chat-core/tests/snapshotPreservesTranscript.test.ts'],
  },
  {
    id: 'FEAT-LOAD-DELIVERED-TERMINAL',
    area: 'loading',
    title:
      'a delivered live terminal/tmux USER event renders even when history has not loaded and the agent is working',
    origin:
      'terminal message "not showing while loading" — proved the loading gate does NOT hide delivered events',
    status: 'shipped',
    coveredBy: [
      'tests/services/pentacleStream.test.ts::FEAT-LOAD-DELIVERED-TERMINAL',
    ],
  },
  {
    id: 'FEAT-LOAD-RECOVERY',
    area: 'loading',
    title:
      'when the session summary advances past our newest stored event, the client refetches to recover a live frame dropped on the lossy link',
    origin:
      'terminal message lost after the initial load; once-per-connection fetch never recovers it while the socket stays up',
    status: 'in_progress',
    coveredBy: ['tests/sessionScreenMount.test.tsx::history-recovery case: a summary'],
  },
  {
    id: 'FEAT-LOAD-FLAG',
    area: 'loading',
    title:
      'one honest per-chat "have we loaded this chat\'s daemon state yet?" flag drives loading vs empty: not loaded (incl. offline/disconnected) shows loading, never a premature "No messages yet."; loaded + zero rows is a genuine empty state; events we already hold are always rendered',
    origin: 'premature empty state when opening a never-loaded chat offline / between fetch retries',
    status: 'in_progress',
    coveredBy: ['tests/sessionScreenMount.test.tsx::load-state case: a never-loaded chat'],
  },
  {
    id: 'FEAT-LOAD-RECONNECTING-HINT',
    area: 'loading',
    title:
      'a long or disconnected load surfaces a "Reconnecting…" affordance instead of a bare spinner (the fetch keeps retrying underneath; never blanks out)',
    origin: 'model: loading covers offline, with a reconnecting hint on long loads',
    status: 'in_progress',
    coveredBy: ['tests/sessionScreenMount.test.tsx::reconnecting case: a disconnected load'],
  },
  {
    id: 'FEAT-LIVENESS-SILENT-HALF-OPEN',
    area: 'liveness',
    title:
      'a silent half-open socket is recovered without waiting for native onclose; stale onclose from the old socket is ignored after reconnect',
    origin:
      'foreground chat stopped updating while still appearing connected; remount was the only reliable recovery',
    status: 'in_progress',
    coveredBy: [
      'tests/services/pentacleStream.test.ts::watchdog reconnects without native onclose',
    ],
  },

  // ── Send ───────────────────────────────────────────────────────────────────
  {
    id: 'FEAT-SEND-SELFHEAL',
    area: 'send',
    title:
      'a daemon-stamped (exact optimistic_id) echo reconciles even a FAILED optimistic row — a false failure self-heals',
    origin: '"says failed but actually sent" never clearing until app restart',
    status: 'shipped',
    coveredBy: ['tests/services/pentacleStream.test.ts::self-heals a false failure'],
  },
  {
    id: 'FEAT-SEND-CONSERVATIVE',
    area: 'send',
    title:
      'a text-only echo (no optimistic_id) does NOT clear a failed row — no false self-heal',
    origin: 'guard against over-eager reconciliation introduced by FEAT-SEND-SELFHEAL',
    status: 'shipped',
    coveredBy: ['tests/services/pentacleStream.test.ts::no false self-heal'],
  },
  {
    id: 'FEAT-SEND-NO-FALSE-FAILED',
    area: 'send',
    title:
      'confirmation lag alone never auto-fails a transmitted send; losing its connection generation makes the ambiguity visibly retryable without automatic retransmission, and a later stamped echo still reconciles it',
    origin: '"says sending forever" after an ambiguous generation loss, while avoiding unsafe automatic replay',
    status: 'in_progress',
    coveredBy: [
      'tests/services/pentacleStream.test.ts::FEAT-SEND-NO-FALSE-FAILED',
      'tests/optimisticSendReconnect.test.ts::FEAT-SEND-NO-FALSE-FAILED',
      'tests/sendWhileWorkingQueue.test.ts::FEAT-SEND-NO-FALSE-FAILED',
      'tests/optimisticUserMessage.test.ts::FEAT-SEND-NO-FALSE-FAILED',
      'tests/sessionScreenDisconnectSurvive.test.tsx::a composer send whose RPC timeout closes the silent transport',
    ],
  },
  {
    id: 'FEAT-SEND-RETRY',
    area: 'send',
    title:
      'a "failed sending" row shows a Retry control that re-arms it to "sending" and re-transmits by optimistic_id',
    origin: 'model: "failed sending" renders + Retry (back to sending)',
    status: 'in_progress',
    coveredBy: [
      'tests/services/pentacleStream.test.ts::FEAT-SEND-RETRY',
      'tests/sessionScreenMount.test.tsx::send-retry case: a failed send',
    ],
  },
  {
    id: 'FEAT-OVERLAY-ISOLATION',
    area: 'send',
    title:
      'a "failed sending" overlay is pure local state — never auto-deleted when new daemon messages arrive (removed only by Retry, dismiss, or a matching daemon echo)',
    origin: 'model: overlays isolated from daemon state; never lose the user\'s text + Retry',
    status: 'in_progress',
    coveredBy: ['tests/services/pentacleStream.test.ts::FEAT-OVERLAY-ISOLATION'],
  },

  // -- Attribution -----------------------------------------------------------
  {
    id: 'FEAT-ATTR-HIDDEN',
    area: 'attribution',
    title:
      'inter-agent / agent-orch / subagent messages are hidden from the transcript but kept in the store (never the operator\'s own bubble)',
    origin: 'peer/agent-orch messages rendering as the operator\'s own message',
    status: 'shipped',
    coveredBy: ['pentacle-chat-core/tests/peerAgentMessages.test.ts'],
  },

  // -- Scroll ------------------------------------------------------------------
  {
    id: 'FEAT-SCROLL-PILL',
    area: 'scroll',
    title:
      'a scroll-to-bottom control shows whenever scrolled up; incoming messages do not yank the view while reading; unread count shows when new messages arrive while scrolled up',
    origin: 'missing scroll-to-bottom affordance + forced-scroll on every incoming message',
    status: 'shipped',
    coveredBy: ['tests/sessionScreenScroll.test.ts'],
  },
];

const REPO_ROOT = process.cwd();

describe('chat reliability feature enumeration', () => {
  test('enumeration is non-empty with unique ids', () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    const ids = FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no drift: every enumerated feature is guarded by a real test', () => {
    const problems: string[] = [];
    for (const feature of FEATURES) {
      if (feature.coveredBy.length === 0) {
        problems.push(`${feature.id}: no coveredBy refs`);
        continue;
      }
      for (const ref of feature.coveredBy) {
        const [relPath, marker] = ref.split('::');
        const abs = join(REPO_ROOT, relPath);
        if (!existsSync(abs)) {
          problems.push(`${feature.id}: missing test file ${relPath}`);
          continue;
        }
        if (marker && !readFileSync(abs, 'utf8').includes(marker)) {
          problems.push(`${feature.id}: ${relPath} is missing marker "${marker}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
