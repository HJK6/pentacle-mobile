import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyFetchedStreamEvents,
  applyPentacleEvent,
  initialPentacleStreamState,
  interpretPentacleEvent,
  invalidateSessionDetailCache,
  selectSessionDetail,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from '../src/index.ts';

const STREAM = 'hosta:v2-status-proof';
const NOTICE_ID = 'nudge:status-card:91db0ea927334f4cb2413b2392e0cdf1';
const STATUS_TEXT = 'Please update your status card: agent-orch status --update "<one-line progress note>" [--step-done <N>]. Set --goal/--plan if unset; revise them if they have changed.';
const BODY = '[pentacle-notice:' + NOTICE_ID + ']\n' + STATUS_TEXT;
const answerWire = JSON.parse(readFileSync(
  new URL('./fixtures/trusted_notification_answer_wire.json', import.meta.url),
  'utf8',
));

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 47,
    host: 'hosta',
    provider: 'codex',
    session_id: 'generation-1',
    session_name: 'v2-status-proof',
    stream_id: STREAM,
    timestamp: '2026-09-16T02:00:00Z',
    kind: 'USER',
    text: BODY,
    raw: {
      source: 'structured',
      daemon_notice: {
        schema_version: 1,
        kind: 'status_card',
        notice_id: NOTICE_ID,
        stream_id: STREAM,
        session_generation: 'generation-1',
        event_id: 47,
        body_sha256: digest(BODY),
      },
    },
    ...overrides,
  };
}

const session: PentacleSessionSummary = {
  stream_id: STREAM,
  host: 'hosta',
  provider: 'codex',
  session_name: 'v2-status-proof',
  last_event_at: '2026-09-16T02:00:00Z',
  last_text: BODY,
  last_kind: 'USER',
  draft: '',
  pending: false,
  working: false,
  online: true,
};

function visibleRows(state: PentacleStreamState, streamId = STREAM) {
  invalidateSessionDetailCache(streamId);
  return selectSessionDetail(state, streamId, { visibleCount: 'all' })?.transcriptItems ?? [];
}

test('trusted status projection is hidden only after the equal-text raw correction', () => {
  const seed: PentacleStreamState = {
    ...initialPentacleStreamState,
    connected: true,
    sessions: [session],
  };
  const unproven = event({ raw: { source: 'structured' } });
  const before = applyPentacleEvent(seed, unproven);
  assert.equal(visibleRows(before).length, 1);
  assert.equal(interpretPentacleEvent(unproven).hidden, false);

  const after = applyPentacleEvent(before, event());
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0]?.text, BODY);
  assert.equal(visibleRows(after).length, 0);
  assert.equal(interpretPentacleEvent(after.events[0]!).hidden, true);

  const staleReplay = applyFetchedStreamEvents(after, [unproven], { requestedStreamId: STREAM });
  assert.equal(staleReplay.events.length, 1);
  assert.equal(visibleRows(staleReplay).length, 0);
});

test('trusted status validation fails open for identity and user-precedence mismatches', () => {
  const base = event();
  const projection = base.raw?.daemon_notice as Record<string, unknown>;
  const cases: PentacleEvent[] = [
    event({ daemon_seq: 48 }),
    event({ stream_id: 'hosta:copy' }),
    event({ text: BODY + ' copied' }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, schema_version: 2 } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, kind: 'status' } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, notice_id: 'wrong' } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, stream_id: 'hosta:wrong' } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, session_generation: '' } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, event_id: 46 } } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, body_sha256: '0'.repeat(64) } } }),
    event({ raw: { source: 'structured', daemon_notice: projection, request_id: 'user-request' } }),
    event({ client_origin: true }),
    event({ optimistic_id: 'optimistic-user' }),
    event({ request_id: 'user-request' }),
    event({ receipt_id: 'user-receipt' }),
    event({ raw: { source: 'structured' } }),
    event({ raw: { ...base.raw, daemon_notice: { ...projection, kind: 'title' } } }),
  ];
  for (const candidate of cases) {
    assert.equal(interpretPentacleEvent(candidate).hidden, false);
  }
});

test('combined status proof is trusted while title-only and historical bare status stay visible', () => {
  const base = event();
  const projection = base.raw?.daemon_notice as Record<string, unknown>;
  assert.equal(interpretPentacleEvent(event({
    raw: {
      source: 'structured',
      daemon_notice: { ...projection, kind: 'status_card_combined' },
    },
  })).hidden, true);
  assert.equal(interpretPentacleEvent(event({
    text: STATUS_TEXT,
    raw: { source: 'structured' },
  })).hidden, false);
  assert.equal(interpretPentacleEvent(event({
    text: '[pentacle-notice:old-direct-provider]\n' + STATUS_TEXT,
    raw: { source: 'structured' },
  })).hidden, false);
});

test('conflicting later proof fails open instead of transferring prior trust', () => {
  const seed: PentacleStreamState = {
    ...initialPentacleStreamState,
    connected: true,
    sessions: [session],
  };
  const proven = applyPentacleEvent(seed, event());
  const projection = event().raw?.daemon_notice as Record<string, unknown>;
  const conflict = event({
    raw: {
      source: 'structured',
      daemon_notice: { ...projection, notice_id: 'nudge:status-card:other' },
    },
  });
  const conflicted = applyPentacleEvent(proven, conflict);
  assert.equal(visibleRows(conflicted).length, 1);
});

test('trusted notification answer correction hides only the exact protocol row', () => {
  const unproven = answerWire.before_proof.event as PentacleEvent;
  const proven = answerWire.correction.event as PentacleEvent;
  const answerStream = String(proven.stream_id);
  const answerSession = {
    ...session,
    stream_id: answerStream,
    host: proven.host,
    provider: proven.provider,
    session_name: proven.session_name,
    last_text: proven.text,
  };
  const seed: PentacleStreamState = {
    ...initialPentacleStreamState,
    connected: true,
    sessions: [answerSession],
  };

  const before = applyPentacleEvent(seed, unproven);
  assert.equal(visibleRows(before, answerStream).length, 1);
  const after = applyPentacleEvent(before, proven);
  assert.equal(after.events.length, 1);
  assert.equal(visibleRows(after, answerStream).length, 0);

  const staleReplay = applyFetchedStreamEvents(after, [unproven], {
    requestedStreamId: answerStream,
  });
  assert.equal(visibleRows(staleReplay, answerStream).length, 0);

  for (const explicitUser of [
    answerWire.explicit_user_copy.event,
    { client_origin: true },
    { optimistic_id: 'operator-copy' },
    { request_id: 'operator-copy' },
    { receipt_id: 'operator-copy' },
    { raw: { ...proven.raw, request_id: 'operator-copy' } },
  ]) {
    assert.equal(interpretPentacleEvent(event({ ...proven, ...explicitUser })).hidden, false);
  }
  assert.equal(interpretPentacleEvent(answerWire.receiptless_identical_user.event).hidden, false);
  assert.equal(interpretPentacleEvent(event({
    text: 'Operator quoted:\n' + proven.text,
    raw: { source: 'structured' },
  })).hidden, false);
});
