// Event immutability is enforced via Object.freeze in development/test
// (NODE_ENV !== 'production').
//
// Two assertions:
//   - mutating an event in state.events after a reducer step throws TypeError
//     under the sample (jest sets NODE_ENV='test').
//   - for every reducer transition exercised, prior event references that
//     survive into the next state are referentially equal AND content
//     byte-equal — no in-place mutation of the canonical history occurred.
import {
  applyPentacleEvent,
  applyPentacleSnapshotMessage,
  initialPentacleStreamState,
} from 'pentacle-chat-core';
import type { PentacleEvent, PentacleStreamState } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

beforeAll(() => {
  expect(process.env.NODE_ENV).not.toBe('production');
});

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'claude',
    session_id: 'hostc:claude:one',
    session_name: 'one',
    stream_id: 'hostc:claude:one',
    timestamp: '2026-05-16T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return { ...initialPentacleStreamState, ...overrides };
}

function snapshotContent(events: readonly PentacleEvent[]) {
  return events.map((item) => JSON.parse(JSON.stringify(item)));
}

// jest-expo transpiles tests to CommonJS where the function body is not in
// strict mode by default, so writes to a frozen object would silently no-op.
// Force a strict-mode evaluation context so the TypeError assertion fires.
const mutateText = new Function(
  'target',
  '"use strict"; target.text = "mutated";',
) as (target: unknown) => void;

test('events appended via applyPentacleEvent are frozen in dev/test', () => {
  const next = applyPentacleEvent(buildState(), event({ daemon_seq: 11, text: 'frozen one' }));
  const inserted = next.events[0];
  expect(Object.isFrozen(inserted)).toBe(true);
  expect(() => mutateText(inserted)).toThrow(TypeError);
});

test('events delivered via applyPentacleSnapshotMessage are frozen in dev/test', () => {
  const next = applyPentacleSnapshotMessage(buildState({ connecting: true }), {
    events: [event({ daemon_seq: 21, text: 'snap one' })],
    sessions: [
      {
        stream_id: 'hostc:claude:one',
        host: 'hostc',
        provider: 'claude',
        session_name: 'one',
        last_event_at: '2026-05-16T10:00:00.000Z',
        last_text: '',
        last_kind: '',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });
  const snapshotted = next.events.find((item) => item.daemon_seq === 21);
  expect(snapshotted).toBeDefined();
  expect(Object.isFrozen(snapshotted!)).toBe(true);
  expect(() => mutateText(snapshotted)).toThrow(TypeError);
});

test('survivors of an unrelated reducer transition are referentially AND content byte-equal', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 31, text: 'one' }));
  const beforeRefs = stateOne.events.slice();
  const beforeContent = snapshotContent(stateOne.events);

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 32, text: 'two' }));

  for (const prior of beforeRefs) {
    const survivor = stateTwo.events.find((item) => item.daemon_seq === prior.daemon_seq);
    expect(survivor).toBe(prior);
  }
  expect(snapshotContent(beforeRefs)).toEqual(beforeContent);
});

test('progressive prefix-merge replaces prior with NEW reference but never mutates the prior', () => {
  const stateOne = applyPentacleEvent(buildState(), event({ daemon_seq: 41, text: 'hel' }));
  const prior = stateOne.events[0];
  const priorContent = JSON.parse(JSON.stringify(prior));

  const stateTwo = applyPentacleEvent(stateOne, event({ daemon_seq: 41, text: 'hello' }));

  const replaced = stateTwo.events.find((item) => item.daemon_seq === 41);
  expect(replaced).toBeDefined();
  expect(replaced).not.toBe(prior);
  expect(replaced?.text).toBe('hello');
  // Prior reference is intact (no in-place mutation occurred).
  expect(JSON.parse(JSON.stringify(prior))).toEqual(priorContent);
  expect(prior.text).toBe('hel');
  expect(Object.isFrozen(replaced!)).toBe(true);
});
