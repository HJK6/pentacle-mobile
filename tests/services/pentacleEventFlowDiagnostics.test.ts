import {
  classifyDrop,
  recordDrop,
  recordInbound,
  recordPersistedDelta,
  reset,
  snapshotCounts,
} from 'pentacle-chat-core';
import { applyPentacleEvent, initialPentacleStreamState } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleStreamState } from 'pentacle-chat-core';

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:chat-1',
    session_name: 'chat-1',
    stream_id: 'alpha:chat-1',
    timestamp: '2026-05-10T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

function eventCount(state: PentacleStreamState) {
  return state.events.length;
}

beforeEach(() => {
  reset();
});

test('event-flow counters are isolated by stream', () => {
  recordInbound(event({ stream_id: 'alpha:one', raw: { source: 'claude-jsonl' } }));
  recordInbound(event({ stream_id: 'alpha:one', raw: { source: 'codex-pane' } }));
  recordPersistedDelta('alpha:one', 1);
  recordDrop('alpha:one', 'noise_filter');
  recordInbound(event({ stream_id: 'beta:two' }));

  const snapshot = snapshotCounts();
  expect(snapshot.get('alpha:one')).toEqual({
    inbound_count: 2,
    persisted_count: 1,
    dropped_count_by_reason: { noise_filter: 1 },
    source_tag_counts: { 'claude-jsonl': 1, 'codex-pane': 1 },
  });
  expect(snapshot.get('beta:two')).toEqual({
    inbound_count: 1,
    persisted_count: 0,
    dropped_count_by_reason: {},
    source_tag_counts: { '(none)': 1 },
  });
});

test('drop classifier matches reducer drops for curated reducer predicates', () => {
  const noise = event({
    daemon_seq: 2,
    kind: 'ASSIST',
    text: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
  });
  const helper = event({ daemon_seq: 3, kind: 'USER', text: 'summarize recent commits' });
  const draft = event({ daemon_seq: 4, kind: 'DRAFT', text: 'partial draft' });
  const working = event({ daemon_seq: 5, kind: 'WORKING', text: 'Working (1s • esc to interrupt)' });
  const duplicate = event({ daemon_seq: 6, kind: 'ASSIST', text: 'same seq' });

  const base = applyPentacleEvent(initialPentacleStreamState, duplicate);
  const cases: Array<[PentacleEvent, string, PentacleStreamState, { duplicate?: boolean } | undefined]> = [
    [noise, 'noise_filter', initialPentacleStreamState, undefined],
    [helper, 'helper_suggestion', initialPentacleStreamState, undefined],
    [draft, 'working_or_draft', initialPentacleStreamState, undefined],
    [working, 'working_or_draft', initialPentacleStreamState, undefined],
    [duplicate, 'dedupe', base, { duplicate: true }],
  ];

  for (const [candidate, reason, state, options] of cases) {
    const before = eventCount(state);
    const after = applyPentacleEvent(state, candidate);
    expect(eventCount(after)).toBe(before);
    expect(classifyDrop(candidate, options)).toBe(reason);
  }
});
