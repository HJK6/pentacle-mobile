// Reducer-integration tests — duplicate daemon_seq events go through
// mergeProgressiveUpdate.
//
// Asserts:
//   - prefix-extension at the same seq REPLACES the prior event in state.events
//     (count unchanged) AND increments eventContentVersionByStream[streamId].
//   - non-prefix text at the same seq is dropped; counter does NOT change.
//   - different seq is appended normally; counter increments.
import {
  applyPentacleEvent,
  initialPentacleStreamState,
} from 'pentacle-chat-core';
import type { PentacleEvent, PentacleStreamState } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const STREAM_ID = 'hostc:claude:one';

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'one',
    stream_id: STREAM_ID,
    timestamp: '2026-05-16T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return { ...initialPentacleStreamState, ...overrides };
}

function streamEvents(state: PentacleStreamState) {
  return state.events.filter((item) => item.stream_id === STREAM_ID);
}

function counter(state: PentacleStreamState) {
  return state.eventContentVersionByStream?.[STREAM_ID] ?? 0;
}

test('prefix-extension at same seq REPLACES the prior row and bumps the content-version counter', () => {
  const stateZero = buildState();
  expect(counter(stateZero)).toBe(0);

  const stateOne = applyPentacleEvent(stateZero, event({ daemon_seq: 100, text: 'hello' }));
  expect(streamEvents(stateOne)).toHaveLength(1);
  expect(streamEvents(stateOne)[0].text).toBe('hello');
  expect(counter(stateOne)).toBe(1);

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 100, text: 'hello, world' }));
  // Same seq → replace, not append.
  expect(streamEvents(stateTwo)).toHaveLength(1);
  expect(streamEvents(stateTwo)[0].text).toBe('hello, world');
  // Counter incremented twice total: once for the append, once for the merge.
  expect(counter(stateTwo)).toBe(2);
  // Events array identity changed (selector cache must be invalidated).
  expect(stateTwo.events).not.toBe(stateOne.events);
});

test('non-prefix text at same seq is DROPPED and counter does NOT change', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 200, text: 'hello' }));
  const counterAfterAppend = counter(stateOne);

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 200, text: 'completely different' }));

  // Reducer returns the same state object (drop short-circuit).
  expect(stateTwo).toBe(stateOne);
  expect(streamEvents(stateTwo)).toHaveLength(1);
  expect(streamEvents(stateTwo)[0].text).toBe('hello');
  expect(counter(stateTwo)).toBe(counterAfterAppend);
});

test('different seq APPENDS normally and bumps counter', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 300, text: 'hello' }));
  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 301, text: 'world' }));

  expect(streamEvents(stateTwo)).toHaveLength(2);
  expect(streamEvents(stateTwo).map((item) => item.text)).toEqual(['hello', 'world']);
  expect(counter(stateTwo)).toBe(2);
});
