// selectSessionDetail returns a NEW object reference whenever
// the per-stream content version advances, even when the events array identity
// would not have caught the change. This is the cache-invalidation half of the
// The cache-invalidation case complements the in-place-mutation merge case.
//
// Spec: docs/public-test-spec.md
import {
  applyPentacleEvent,
  applyPentacleSessionSummary,
  initialPentacleStreamState,
} from 'pentacle-chat-core';
import {
  invalidateSessionDetailCache,
  selectSessionDetail,
} from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const STREAM_ID = 'hostc:claude:identity';

function session(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'identity',
    last_event_at: '2026-05-16T10:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'identity',
    stream_id: STREAM_ID,
    timestamp: '2026-05-16T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'first',
    ...overrides,
  };
}

function buildState(): PentacleStreamState {
  return applyPentacleSessionSummary(
    { ...initialPentacleStreamState },
    session(),
  );
}

beforeEach(() => {
  invalidateSessionDetailCache(STREAM_ID);
});

test('selector returns the same object identity when called twice on the same state (hot-path stable)', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 1, text: 'first' }));
  const detailA = selectSessionDetail(stateOne, STREAM_ID);
  const detailB = selectSessionDetail(stateOne, STREAM_ID);
  expect(detailA).not.toBeNull();
  expect(detailB).toBe(detailA);
});

test('selector returns a NEW object identity after an event append (transcript grew)', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 1, text: 'first' }));
  const detailOne = selectSessionDetail(stateOne, STREAM_ID);
  expect(detailOne).not.toBeNull();

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 2, text: 'second' }));
  const detailTwo = selectSessionDetail(stateTwo, STREAM_ID);

  expect(detailTwo).not.toBeNull();
  expect(detailTwo).not.toBe(detailOne);
  expect(detailTwo!.transcriptItems.length).toBe(detailOne!.transcriptItems.length + 1);
});

test('selector returns a NEW object identity after a progressive-update replace (count unchanged, last row text changed)', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 7, text: 'hel' }));
  const detailOne = selectSessionDetail(stateOne, STREAM_ID);
  expect(detailOne).not.toBeNull();
  const lengthBefore = detailOne!.transcriptItems.length;
  const lastBefore = detailOne!.transcriptItems[detailOne!.transcriptItems.length - 1];

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 7, text: 'hello' }));
  const detailTwo = selectSessionDetail(stateTwo, STREAM_ID);

  expect(detailTwo).not.toBeNull();
  expect(detailTwo).not.toBe(detailOne);
  expect(detailTwo!.transcriptItems.length).toBe(lengthBefore);
  const lastAfter = detailTwo!.transcriptItems[detailTwo!.transcriptItems.length - 1];
  expect(lastAfter).not.toBe(lastBefore);
  expect(lastAfter.text).toContain('hello');
});
