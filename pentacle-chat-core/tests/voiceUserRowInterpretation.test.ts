import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretPentacleEvent, type PentacleEvent } from '../src/index.ts';

// A voice message the server sends has no text until the daemon echoes it. Its row is the
// operator's own message and must stay visible with its send state, not read as empty furniture.
function user(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: Number.NaN, host: 'host_a', provider: 'codex', session_id: 'host_a:codex:voice',
    session_name: 'voice', stream_id: 'host_a:codex:voice', timestamp: '2026-11-16T22:00:00.000Z',
    kind: 'USER', text: '', client_origin: true, optimistic_id: 'optimistic_1', ...overrides,
  };
}

test('a textless USER row that carries voice meta is a user bubble', () => {
  const row = interpretPentacleEvent(user({ meta: { voice: { duration_s: 3 } } }), 'host_a');
  assert.equal(row.displayRule, 'bubble:user');
});

test('a textless USER row without voice meta or attachments stays hidden', () => {
  const row = interpretPentacleEvent(user({}), 'host_a');
  assert.equal(row.displayRule, 'hidden:noise');
});
