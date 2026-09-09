import {
  coalesceInterpretedEvents,
  interpretPentacleEvent,
} from 'pentacle-chat-core';
import type { PentacleEvent } from 'pentacle-chat-core';

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'codex',
    session_id: 'hostc:codex:one',
    session_name: 'one',
    stream_id: 'hostc:codex:one',
    timestamp: '2026-05-16T12:00:00.000Z',
    kind: 'SYSTEM',
    text: 'Worked for 1s',
    ...overrides,
  };
}

test('coalesceInterpretedEvents does not revive hidden terminal furniture', () => {
  const result = coalesceInterpretedEvents([
    interpretPentacleEvent(event({ daemon_seq: 10, text: 'Worked for 1s' })),
    interpretPentacleEvent(event({
      daemon_seq: 11,
      provider: 'claude',
      text: '',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
    })),
    interpretPentacleEvent(event({ daemon_seq: 12, text: 'Worked for 2s' })),
    interpretPentacleEvent(event({ daemon_seq: 13, text: 'Worked for 3s' })),
  ]);

  expect(result.map((item) => item.displayRule)).toEqual([
    'hidden:noise',
    'activity:turn-summary',
    'hidden:noise',
    'hidden:noise',
  ]);
});

test('coalesceInterpretedEvents preserves a semantic summary between hidden furniture rows', () => {
  const result = coalesceInterpretedEvents([
    interpretPentacleEvent(event({ daemon_seq: 20, text: 'Worked for 1s' })),
    interpretPentacleEvent(event({
      daemon_seq: 21,
      provider: 'claude',
      text: 'ok',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
    })),
    interpretPentacleEvent(event({ daemon_seq: 22, text: 'Worked for 2s' })),
  ]);

  expect(result.map((item) => item.event.daemon_seq)).toEqual([20, 21, 22]);
  expect(result.map((item) => item.displayRule)).toEqual([
    'hidden:noise',
    'activity:turn-summary',
    'hidden:noise',
  ]);
});
