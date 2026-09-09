// eventContentVersionByStream survives snapshot/inventory and is removed on
// stream close/removal.
import {
  applyPentacleEvent,
  applyPentacleSessionInventory,
  applyPentacleSnapshotMessage,
  initialPentacleStreamState,
  removePentacleStream,
} from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const STREAM_ID = 'hostc:claude:counter';

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'counter',
    last_event_at: '2026-05-16T10:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'counter',
    stream_id: STREAM_ID,
    timestamp: '2026-05-16T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'one',
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return { ...initialPentacleStreamState, ...overrides };
}

function counter(state: PentacleStreamState) {
  return state.eventContentVersionByStream?.[STREAM_ID] ?? 0;
}

test('counter survives a snapshot replacement that re-delivers the same content', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 11, text: 'one' }));
  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 12, text: 'two' }));
  expect(counter(stateTwo)).toBe(2);

  const stateThree = applyPentacleSnapshotMessage(stateTwo, {
    events: stateTwo.events.slice(),
    sessions: [session()],
  });
  // Same content set as before → counter preserved (not reset to 0).
  expect(counter(stateThree)).toBe(2);
});

test('counter advances on a snapshot whose content set differs from current', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 21, text: 'one' }));
  expect(counter(stateOne)).toBe(1);

  const stateTwo = applyPentacleSnapshotMessage(stateOne, {
    events: [
      event({ daemon_seq: 21, text: 'one' }),
      event({ daemon_seq: 22, text: 'two from snapshot' }),
    ],
    sessions: [session()],
  });
  // Content set differs (event count grew) → counter advanced.
  expect(counter(stateTwo)).toBeGreaterThan(counter(stateOne));
});

test('counter is removed when the stream is removed via removePentacleStream', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 31, text: 'one' }));
  expect(counter(stateOne)).toBe(1);

  const stateTwo = removePentacleStream(stateOne, STREAM_ID);
  expect(stateTwo.eventContentVersionByStream).toBeDefined();
  expect(stateTwo.eventContentVersionByStream![STREAM_ID]).toBeUndefined();
});

test('counter is removed when the stream drops out of a session inventory', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 41, text: 'one' }));
  expect(counter(stateOne)).toBe(1);

  const stateTwo = applyPentacleSessionInventory(stateOne, []);
  expect(stateTwo.eventContentVersionByStream![STREAM_ID]).toBeUndefined();
});

test('counter is removed when a snapshot drops the stream from sessions', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 51, text: 'one' }));
  expect(counter(stateOne)).toBe(1);

  const stateTwo = applyPentacleSnapshotMessage(stateOne, {
    events: [],
    sessions: [],
  });
  expect(stateTwo.eventContentVersionByStream![STREAM_ID]).toBeUndefined();
});
