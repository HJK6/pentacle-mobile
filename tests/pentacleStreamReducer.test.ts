import { readFileSync } from 'node:fs';
import {
  applyPentacleEvent,
  applyFetchedStreamEvents,
  applyPentacleHostStatus,
  applyPentacleHostsStats,
  applyPentacleSessionInventory,
  applyPentacleSessionSummary,
  applyPentacleSnapshotMessage,
  applyPentacleWorkingState,
  beginPentacleTurn,
  clearPentacleStreamDraft,
  initialPentacleStreamState,
  isSystemEndOfTurnEvent,
  removePentacleStream,
  sendOptimisticMessage,
  OPTIMISTIC_INVENTORY_GRACE_MS,
} from 'pentacle-chat-core';
import { selectSessionDetail } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function expectPresent<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeTruthy();
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    ...overrides,
  };
}

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:chat-1',
    session_name: 'chat-1',
    stream_id: 'alpha:chat-1',
    timestamp: '2026-04-24T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'alpha:chat-1',
    host: 'alpha',
    provider: 'codex',
    session_name: 'chat-1',
    last_event_at: '2026-04-24T10:00:00.000Z',
    last_text: 'hello',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function claudeFixture(name: string): PentacleEvent {
  const fixtures = JSON.parse(readFileSync('test/fixtures/pentacle_mobile_chat_cases.json', 'utf8'));
  const item = fixtures.cases.find((candidate: { name: string }) => candidate.name === name);
  expectPresent(item);
  return item.event;
}

function claudeScenario(name: string): { events: PentacleEvent[]; session: PentacleSessionSummary } {
  const fixtures = JSON.parse(readFileSync('test/fixtures/pentacle_mobile_chat_cases.json', 'utf8'));
  const item = fixtures.scenarios.find((candidate: { name: string }) => candidate.name === name);
  expectPresent(item);
  return item;
}

test('applyPentacleSnapshotMessage dedupes events and sorts sessions without rendering', () => {
  const next = applyPentacleSnapshotMessage(buildState({ connecting: true }), {
    events: [
      event({ daemon_seq: 1, text: 'old copy' }),
      event({ daemon_seq: 2, text: 'newer' }),
      event({ daemon_seq: 1, text: 'latest copy' }),
    ],
    sessions: [
      session({ stream_id: 'alpha:old', session_name: 'old', last_event_at: '2026-04-24T09:00:00.000Z' }),
      session({ stream_id: 'alpha:new', session_name: 'new', last_event_at: '2026-04-24T11:00:00.000Z' }),
    ],
  });

  expect(next.connected).toBe(true);
  expect(next.connecting).toBe(false);
  expect(next.hasHydrated).toBe(true);
  expect(next.events.map((item) => [item.daemon_seq, item.text])).toEqual([
    [2, 'newer'],
    [1, 'latest copy'],
  ]);
  expect(next.sessions.map((item) => item.stream_id)).toEqual(['alpha:new', 'alpha:old']);
  expect(next.hosts.alpha?.online).toBe(true);
  expect(next.hosts.alpha?.session_count).toBe(2);
});

test('applyPentacleSessionSummary preserves newer visible tail when an older echo summary arrives', () => {
  const state = buildState({
    sessions: [
      session({
        last_event_at: '2026-07-09T14:15:00.000Z',
        last_text: 'optimistic send',
        last_kind: 'USER',
        working: true,
      }),
    ],
  });

  const next = applyPentacleSessionSummary(state, session({
    last_event_at: '2026-07-09T14:00:06.000Z',
    last_text: 'older daemon echo',
    last_kind: 'USER',
    working: false,
  }));

  expect(next.sessions[0]).toMatchObject({
    last_event_at: '2026-07-09T14:15:00.000Z',
    last_text: 'optimistic send',
    last_kind: 'USER',
    working: false,
  });
});

test('applyFetchedStreamEvents merges a non-overlapping tail without duplicate rows or rendered mis-ordering', () => {
  const withHeldWindow = applyPentacleEvent(
    applyPentacleEvent(
      buildState({ sessions: [session()] }),
      event({ daemon_seq: 1, timestamp: '2026-04-24T10:00:01.000Z', text: 'held one' }),
    ),
    event({ daemon_seq: 2, timestamp: '2026-04-24T10:00:02.000Z', text: 'held two' }),
  );

  const withTail = applyFetchedStreamEvents(withHeldWindow, [
    event({ daemon_seq: 50, timestamp: '2026-04-24T10:00:50.000Z', text: 'tail fifty' }),
    event({ daemon_seq: 51, timestamp: '2026-04-24T10:00:51.000Z', text: 'tail fifty one' }),
  ]);
  const afterDuplicateTail = applyFetchedStreamEvents(withTail, [
    event({ daemon_seq: 50, timestamp: '2026-04-24T10:00:50.000Z', text: 'tail fifty duplicate' }),
    event({ daemon_seq: 52, timestamp: '2026-04-24T10:00:52.000Z', text: 'tail fifty two' }),
  ]);

  expect(afterDuplicateTail.events.filter((item) => item.daemon_seq === 50)).toHaveLength(1);
  expect(selectSessionDetail(afterDuplicateTail, 'alpha:chat-1', { visibleCount: 'all' })?.transcriptItems.map((item) => item.text)).toEqual([
    'held one',
    'held two',
    'tail fifty duplicate',
    'tail fifty one',
    'tail fifty two',
  ]);
});

test('applyFetchedStreamEvents preserves a newer visible tail against a delayed older focused response', () => {
  const streamId = 'alpha:stale-focused-tail';
  const afterLive = applyPentacleEvent(
    applyPentacleEvent(buildState(), event({
      stream_id: streamId,
      daemon_seq: 100,
      correlatedDaemonSeq: 100,
      timestamp: '2026-08-01T21:10:00.000Z',
      text: 'newer live start',
    })),
    event({
      stream_id: streamId,
      daemon_seq: 101,
      correlatedDaemonSeq: 101,
      timestamp: '2026-08-01T21:10:01.000Z',
      text: 'newer live tail',
    }),
  );

  const afterDelayedFocusedResponse = applyFetchedStreamEvents(afterLive, [
    event({
      stream_id: streamId,
      daemon_seq: 98,
      correlatedDaemonSeq: 98,
      timestamp: '2026-08-01T21:09:58.000Z',
      text: 'older focused response start',
    }),
    event({
      stream_id: streamId,
      daemon_seq: 99,
      correlatedDaemonSeq: 99,
      timestamp: '2026-08-01T21:09:59.000Z',
      text: 'older focused response tail',
    }),
  ], {
    limit: 2,
    requestedStreamId: streamId,
    mode: 'current-tail',
    ingressSource: 'request_stream_events:freshness-guard',
  });

  expect(afterDelayedFocusedResponse.events
    .filter((item) => item.stream_id === streamId)
    .map((item) => item.correlatedDaemonSeq ?? item.daemon_seq)).toEqual([100, 101]);
});

test('applyPentacleSnapshotMessage and working.state frames store per-stream working state', () => {
  const workingState = {
    stream_id: 'alpha:chat-1',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 1900,
    tokens_cache_read: 2,
    tokens_cache_creation: 3,
    tokens_phase: 'down' as const,
    shell_count_started: 1,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 5000,
  };

  const fromSnapshot = applyPentacleSnapshotMessage(buildState(), {
    working_states: { 'alpha:chat-1': workingState },
  });
  expect(fromSnapshot.workingStates?.['alpha:chat-1']?.tokens_output).toBe(1900);

  const fromFrame = applyPentacleWorkingState(fromSnapshot, {
    ...workingState,
    tokens_output: 2400,
    tokens_phase: 'up',
  });
  expect(fromFrame.workingStates?.['alpha:chat-1']?.tokens_output).toBe(2400);
  expect(fromFrame.workingStates?.['alpha:chat-1']?.tokens_phase).toBe('up');
});

test('selectSessionDetail hides tool batch summary by default and shows it in verbose mode', () => {
  const events = [
    event({
      daemon_seq: 1,
      kind: 'TOOL_USE',
      provider: 'claude',
      raw: { source: 'claude-jsonl', tool_use_id: 'toolu_1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
      text: 'Read a.ts',
    }),
    event({
      daemon_seq: 2,
      kind: 'TOOL_RESULT',
      provider: 'claude',
      raw: { source: 'claude-jsonl', tool_use_id: 'toolu_1', tool_name: 'Read' },
      text: 'file contents',
    }),
    event({
      daemon_seq: 3,
      kind: 'TOOL_BATCH_SUMMARY',
      provider: 'claude',
      raw: { source: 'claude-jsonl', subtype: 'tool-batch-summary', span_size: 1, tool_use_ids: ['toolu_1'] },
      text: 'Read 1 file',
    }),
    event({
      daemon_seq: 4,
      kind: 'ASSIST_TEXT',
      provider: 'claude',
      raw: { source: 'claude-jsonl' },
      text: 'Done.',
    }),
  ];
  const state = buildState({
    sessions: [session({ provider: 'claude', last_kind: 'ASSIST_TEXT', last_text: 'Done.' })],
    events,
  });

  const detail = selectSessionDetail(state, 'alpha:chat-1', { visibleCount: 'all' });
  const verboseDetail = selectSessionDetail(state, 'alpha:chat-1', { visibleCount: 'all', showToolActions: true });

  expect(detail?.transcriptItems.map((item) => item.kind)).toEqual(['ASSIST_TEXT']);
  expect(detail?.transcriptItems.map((item) => item.displayRule)).toEqual(['bubble:assistant']);
  expect(verboseDetail?.transcriptItems.map((item) => item.kind)).toEqual(['TOOL_BATCH_SUMMARY', 'ASSIST_TEXT']);
  expect(verboseDetail?.transcriptItems.map((item) => item.displayRule)).toEqual(['activity:tool-batch', 'bubble:assistant']);
});

test('selectSessionDetail hides uncovered structured tool rows by default and shows them in verbose mode', () => {
  const events = [
    event({
      daemon_seq: 1,
      kind: 'TOOL_USE',
      provider: 'claude',
      raw: { source: 'claude-jsonl', tool_use_id: 'toolu_1', tool_name: 'Read', tool_input: { file_path: 'a.ts' } },
      text: 'Read a.ts',
    }),
    event({
      daemon_seq: 2,
      kind: 'TOOL_BATCH_SUMMARY',
      provider: 'claude',
      raw: { source: 'claude-jsonl', subtype: 'tool-batch-summary', span_size: 1, tool_use_ids: ['toolu_other'] },
      text: 'Read 1 file',
    }),
  ];
  const state = buildState({
    sessions: [session({ provider: 'claude', last_kind: 'TOOL_BATCH_SUMMARY', last_text: 'Read 1 file' })],
    events,
  });

  const detail = selectSessionDetail(state, 'alpha:chat-1', { visibleCount: 'all' });
  const verboseDetail = selectSessionDetail(state, 'alpha:chat-1', { visibleCount: 'all', showToolActions: true });

  expect(detail?.transcriptItems).toEqual([]);
  expect(verboseDetail?.transcriptItems.map((item) => item.kind)).toEqual(['TOOL_USE', 'TOOL_BATCH_SUMMARY']);
  expect(verboseDetail?.transcriptItems.map((item) => item.displayRule)).toEqual(['activity:explored', 'activity:tool-batch']);
});

test('live tool-batch tail and reopened projection both hide shell summaries by default', () => {
  const summary = event({
    daemon_seq: 3,
    kind: 'TOOL_BATCH_SUMMARY',
    provider: 'claude',
    raw: {
      source: 'claude-jsonl',
      subtype: 'tool-batch-summary',
      span_size: 2,
      tool_breakdown: { Bash: 2 },
      tool_use_ids: ['toolu_1', 'toolu_2'],
    },
    text: 'Ran 2 shell commands',
  });
  const live = buildState({
    sessions: [session({ provider: 'claude', last_kind: summary.kind, last_text: summary.text })],
    events: [summary],
  });
  const projected = buildState({
    sessions: [session({ provider: 'claude', last_kind: 'ASSIST_TEXT', last_text: 'Visible control' })],
    events: [
      event({ daemon_seq: 1, kind: 'TOOL_USE', provider: 'claude', raw: { source: 'claude-jsonl', tool_use_id: 'toolu_1', tool_name: 'Bash' } }),
      event({ daemon_seq: 2, kind: 'TOOL_USE', provider: 'claude', raw: { source: 'claude-jsonl', tool_use_id: 'toolu_2', tool_name: 'Bash' } }),
      summary,
      event({ daemon_seq: 4, kind: 'ASSIST_TEXT', provider: 'claude', raw: { source: 'claude-jsonl' }, text: 'Visible control' }),
    ],
  });

  expect(selectSessionDetail(live, 'alpha:chat-1', { visibleCount: 'all' })?.transcriptItems).toEqual([]);
  expect(selectSessionDetail(projected, 'alpha:chat-1', { visibleCount: 'all' })?.transcriptItems.map((item) => item.text)).toEqual(['Visible control']);
});

test('applyPentacleWorkingState ignores malformed frames and remove clears state', () => {
  const base = buildState();
  const unchanged = applyPentacleWorkingState(base, undefined);
  expect(unchanged).toBe(base);

  const withState = applyPentacleWorkingState(buildState({ sessions: [session()] }), {
    stream_id: 'alpha:chat-1',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 0,
    tokens_output: 1,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down',
    shell_count_started: 0,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 0,
  });
  const removed = removePentacleStream(withState, 'alpha:chat-1');

  expect(removed.workingStates?.['alpha:chat-1']).toBe(undefined);
});

test('applyPentacleSnapshotMessage keeps long histories per stream instead of globally evicting quiet chats', () => {
  const events = [
    ...Array.from({ length: 8 }, (_, index) => event({
      daemon_seq: index + 1,
      stream_id: 'alpha:pull-memory',
      session_name: 'pull-memory',
      text: `alpha event ${index + 1}`,
    })),
    ...Array.from({ length: 8 }, (_, index) => event({
      daemon_seq: index + 101,
      stream_id: 'beta:active',
      host: 'beta',
      session_name: 'active',
      text: `beta event ${index + 1}`,
    })),
  ];

  const next = applyPentacleSnapshotMessage(buildState(), { events }, 5);

  expect(next.events.filter((item) => item.stream_id === 'alpha:pull-memory').length).toBe(5);
  expect(next.events.filter((item) => item.stream_id === 'beta:active').length).toBe(5);
  expect(next.events.find((item) => item.stream_id === 'alpha:pull-memory')?.text).toBe('alpha event 4');
});

test('applyPentacleSnapshotMessage filters Codex starter helper user prompts', () => {
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: [
      event({ daemon_seq: 45, kind: 'USER', text: 'run /review on my current changes' }),
      event({ daemon_seq: 46, kind: 'ASSIST', text: 'durable answer' }),
    ],
    sessions: [
      session({
        last_event_at: '2026-04-24T10:00:08.000Z',
        last_text: 'run /review on my current changes',
        last_kind: 'USER',
      }),
    ],
  });

  expect(next.events.map((item) => item.text)).toEqual(['durable answer']);
  expect(next.sessions[0]?.last_text).toBe('');
  expect(next.sessions[0]?.last_kind).toBe('');
});

test('applyPentacleSnapshotMessage filters multi-line USER events that begin with a starter prompt', () => {
  const accumulated = [
    'run /review on my current changes',
    'summarize recent commits',
    'use /skills to list available skills',
  ].join('\n');
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: [
      event({ daemon_seq: 47, kind: 'USER', text: accumulated }),
      event({ daemon_seq: 48, kind: 'ASSIST', text: 'durable answer' }),
    ],
    sessions: [
      session({
        last_event_at: '2026-04-24T10:00:08.000Z',
        last_text: accumulated,
        last_kind: 'USER',
      }),
    ],
  });

  expect(next.events.map((item) => item.text)).toEqual(['durable answer']);
  expect(next.sessions[0]?.last_text).toBe('');
  expect(next.sessions[0]?.last_kind).toBe('');
});

test('applyPentacleSessionInventory marks the stream hydrated for empty chat lists', () => {
  const next = applyPentacleSessionInventory(buildState({ connecting: true }), []);

  expect(next.hasHydrated).toBe(true);
  expect(next.sessions).toEqual([]);
});

function hostStat(host: string, over: Record<string, unknown> = {}) {
  return {
    host,
    cpu_load_1m: 0.42,
    memory_used_bytes: 100,
    memory_total_bytes: 200,
    disk_used_bytes: 300,
    disk_total_bytes: 400,
    uptime_seconds: 86400,
    sampled_at: '2026-09-04T23:00:00Z',
    ...over,
  };
}

test('applyPentacleHostsStats replaces the whole host map and removes absent hosts', () => {
  const first = applyPentacleHostsStats(buildState(), {
    hosta: hostStat('hosta'),
    hostc: hostStat('hostc', { cpu_load_1m: 1.1 }),
  });
  expect(Object.keys(first.machineStats).sort()).toEqual(['hosta', 'hostc']);

  // A later frame is a complete replacement: hostc is absent, so it is removed.
  const second = applyPentacleHostsStats(first, {
    hosta: hostStat('hosta', { cpu_load_1m: 2.0 }),
  });
  expect(second.machineStats.hostc).toBeUndefined();
  expect(second.machineStats.hosta?.cpu_load_1m).toBe(2.0);
});

test('applyPentacleHostsStats: hello replay then a newer broadcast converge to one map', () => {
  const helloFrame = { hosta: hostStat('hosta'), hostc: hostStat('hostc') };
  const broadcast = {
    hosta: hostStat('hosta', { cpu_load_1m: 3.3 }),
    hostb: hostStat('hostb'),
  };
  const afterHello = applyPentacleHostsStats(buildState(), helloFrame);
  const afterBroadcast = applyPentacleHostsStats(afterHello, broadcast);
  expect(Object.keys(afterBroadcast.machineStats).sort()).toEqual(['hosta', 'hostb']);
  expect(afterBroadcast.machineStats.hosta?.cpu_load_1m).toBe(3.3);

  // Replaying the same frame is idempotent — it converges to the same map.
  const replay = applyPentacleHostsStats(afterBroadcast, broadcast);
  expect(replay.machineStats).toEqual(afterBroadcast.machineStats);
});

test('applyPentacleHostsStats rejects malformed hosts and keeps only valid ones', () => {
  const next = applyPentacleHostsStats(buildState(), {
    hosta: hostStat('hosta'),
    nonfinite: hostStat('nonfinite', { memory_used_bytes: Number.NaN }),
    negative: hostStat('negative', { cpu_load_1m: -1 }),
    zerototal: hostStat('zerototal', { memory_total_bytes: 0 }),
    overused: hostStat('overused', { disk_used_bytes: 999, disk_total_bytes: 400 }),
    mismatch: hostStat('somewhere-else'),
    nostamp: hostStat('nostamp', { sampled_at: '' }),
  });
  expect(Object.keys(next.machineStats)).toEqual(['hosta']);
  expect(next.machineStats.hosta?.host).toBe('hosta');
});

test.each([
  ['string', '100'],
  ['null', null],
  ['boolean', true],
])('applyPentacleHostsStats rejects %s numeric values', (_label, value) => {
  const next = applyPentacleHostsStats(buildState(), {
    hosta: hostStat('hosta', { memory_used_bytes: value }),
  });

  expect(next.machineStats).toEqual({});
});

test.each([
  ['date-only', '2026-09-04'],
  ['timezone-less', '2026-09-04T23:00:00'],
  ['offset', '2026-09-04T23:00:00+02:00'],
  ['non-string', 2026],
])('applyPentacleHostsStats rejects %s sampled_at values', (_label, sampledAt) => {
  const next = applyPentacleHostsStats(buildState(), {
    hosta: hostStat('hosta', { sampled_at: sampledAt }),
  });

  expect(next.machineStats).toEqual({});
});

test('applyPentacleEvent ignores duplicate daemon sequence events', () => {
  const existingEvent = event({ daemon_seq: 42, text: 'first' });
  const state = buildState({ events: [existingEvent], sessions: [session()] });
  const next = applyPentacleEvent(state, event({ daemon_seq: 42, text: 'duplicate' }));

  expect(next).toBe(state);
  expect(next.events.length).toBe(1);
  expect(next.events[0]).toBe(existingEvent);
});

test('applyPentacleEvent allows client-origin optimistic events with non-finite daemon sequences', () => {
  const state = buildState({ sessions: [session()] });
  const first = applyPentacleEvent(state, event({
    daemon_seq: Number.NaN,
    kind: 'USER',
    text: 'first optimistic',
    client_origin: true,
    optimistic_id: 'optimistic_alpha_chat_1_1',
    pending: true,
  }));
  const second = applyPentacleEvent(first, event({
    daemon_seq: Number.NaN,
    kind: 'USER',
    text: 'second optimistic',
    client_origin: true,
    optimistic_id: 'optimistic_alpha_chat_1_2',
    pending: true,
  }));

  expect(second.events.map((item) => item.optimistic_id)).toEqual([
    'optimistic_alpha_chat_1_1',
    'optimistic_alpha_chat_1_2',
  ]);
});

test('applyPentacleEvent ignores transient assistant status ticks', () => {
  const state = buildState({ sessions: [session()] });
  const next = applyPentacleEvent(
    state,
    event({
      daemon_seq: 43,
      kind: 'ASSIST',
      text: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
      timestamp: '2026-04-24T10:00:07.000Z',
    }),
  );

  expect(next).toBe(state);
  expect(next.events.length).toBe(0);
  expect(next.sessions[0]?.last_text).toBe('hello');
});

test('applyPentacleEvent ignores Codex starter helper user prompts', () => {
  const state = buildState({ sessions: [session()] });
  const next = applyPentacleEvent(
    state,
    event({
      daemon_seq: 44,
      kind: 'USER',
      text: 'run /review on my current changes',
      timestamp: '2026-04-24T10:00:08.000Z',
    }),
  );

  expect(next).toBe(state);
  expect(next.events.length).toBe(0);
  expect(next.sessions[0]?.last_text).toBe('hello');
});

test('applyPentacleEvent stores drafts separately and updates session draft state', () => {
  const draft = event({
    daemon_seq: 3,
    kind: 'DRAFT',
    text: 'partial assistant output',
    raw: { working: true, working_label: 'editing files', pending: true },
  });
  // Session already known from inventory; the draft event updates its row.
  const next = applyPentacleEvent(buildState({ sessions: [session()] }), draft);

  expect(next.events.length).toBe(0);
  expect(next.drafts['alpha:chat-1']).toBe(draft);
  expect(next.sessions[0]?.draft).toBe('partial assistant output');
  expect(next.sessions[0]?.working).toBe(true);
  expect(next.sessions[0]?.working_label).toBe('editing files');
});

test('applyPentacleEvent does not let draft ticks evict committed transcript history', () => {
  let state = buildState({ sessions: [session()] });
  state = applyPentacleEvent(state, event({ daemon_seq: 1, kind: 'ASSIST', text: 'committed one' }), 3);
  state = applyPentacleEvent(state, event({ daemon_seq: 2, kind: 'DRAFT', text: 'draft one' }), 3);
  state = applyPentacleEvent(state, event({ daemon_seq: 3, kind: 'DRAFT', text: 'draft two' }), 3);
  state = applyPentacleEvent(state, event({ daemon_seq: 4, kind: 'DRAFT', text: 'draft three' }), 3);
  state = applyPentacleEvent(state, event({ daemon_seq: 5, kind: 'ASSIST', text: 'committed two' }), 3);

  expect(state.events.map((item) => [item.kind, item.text])).toEqual([
    ['ASSIST', 'committed one'],
    ['ASSIST', 'committed two'],
  ]);
  expect(state.drafts['alpha:chat-1']).toBe(undefined);
  expect(state.sessions[0]?.last_text).toBe('committed two');
});

test('applyPentacleEvent clears draft when committed transcript event arrives', () => {
  const draft = event({ daemon_seq: 3, kind: 'DRAFT', text: 'partial' });
  const withDraft = applyPentacleEvent(buildState({ sessions: [session()] }), draft);
  const committed = event({
    daemon_seq: 4,
    kind: 'ASSIST',
    text: 'final',
    timestamp: '2026-04-24T10:00:05.000Z',
  });
  const next = applyPentacleEvent(withDraft, committed);

  expect(next.drafts['alpha:chat-1']).toBe(undefined);
  expect(next.sessions[0]?.draft).toBe('');
  expect(next.sessions[0]?.last_text).toBe('final');
  expect(next.sessions[0]?.last_kind).toBe('ASSIST');
});

test('applyPentacleSnapshotMessage filters draft events out of committed history', () => {
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: [
      event({ daemon_seq: 1, kind: 'ASSIST', text: 'committed' }),
      event({ daemon_seq: 2, kind: 'DRAFT', text: 'working tick' }),
    ],
    drafts: {
      'alpha:chat-1': event({ daemon_seq: 2, kind: 'DRAFT', text: 'working tick' }),
    },
    sessions: [session()],
  });

  expect(next.events.map((item) => item.kind)).toEqual(['ASSIST']);
  expect(next.drafts['alpha:chat-1']?.text).toBe('working tick');
});

test('applyPentacleSnapshotMessage filters transient status events and summaries', () => {
  const next = applyPentacleSnapshotMessage(
    buildState({
      sessions: [
        session({
          last_event_at: '2026-04-24T10:00:00.000Z',
          last_text: 'stable committed answer',
          last_kind: 'ASSIST',
        }),
      ],
    }),
    {
      events: [
        event({ daemon_seq: 1, kind: 'ASSIST', text: 'stable committed answer' }),
        event({ daemon_seq: 2, kind: 'ASSIST', text: 'Booting MCP server: codex_apps (7s • esc to interrupt)' }),
      ],
      sessions: [
        session({
          last_event_at: '2026-04-24T10:00:07.000Z',
          last_text: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
          last_kind: 'ASSIST',
        }),
      ],
    },
  );

  expect(next.events.map((item) => item.text)).toEqual(['stable committed answer']);
  expect(next.sessions[0]?.last_text).toBe('stable committed answer');
  expect(next.sessions[0]?.last_event_at).toBe('2026-04-24T10:00:00.000Z');
});

test('clearPentacleStreamDraft clears both draft map and session summary draft', () => {
  const draft = event({ daemon_seq: 3, kind: 'DRAFT', text: 'partial' });
  const withDraft = applyPentacleEvent(buildState({ sessions: [session()] }), draft);
  const next = clearPentacleStreamDraft(withDraft, 'alpha:chat-1');

  expect(next.drafts['alpha:chat-1']).toBe(undefined);
  expect(next.sessions[0]?.draft).toBe('');
});

test('removePentacleStream removes session-owned events and drafts', () => {
  const state = buildState({
    events: [
      event({ daemon_seq: 1, stream_id: 'alpha:chat-1' }),
      event({ daemon_seq: 2, stream_id: 'beta:chat-2', host: 'beta', session_id: 'beta:chat-2' }),
    ],
    drafts: {
      'alpha:chat-1': event({ daemon_seq: 3, kind: 'DRAFT', text: 'partial' }),
    },
    hosts: {
      alpha: { host: 'alpha', online: true, checked_at: '2026-04-24T10:00:00.000Z', session_count: 1 },
      beta: { host: 'beta', online: true, checked_at: '2026-04-24T10:00:00.000Z', session_count: 1 },
    },
    sessions: [
      session({ stream_id: 'alpha:chat-1' }),
      session({ stream_id: 'beta:chat-2', host: 'beta', session_name: 'chat-2' }),
    ],
  });
  const next = removePentacleStream(state, 'alpha:chat-1');

  expect(next.events.map((item) => item.stream_id)).toEqual(['beta:chat-2']);
  expect(next.drafts['alpha:chat-1']).toBe(undefined);
  expect(next.sessions.map((item) => item.stream_id)).toEqual(['beta:chat-2']);
});

test('applyPentacleHostStatus keeps a host online when live sessions still exist', () => {
  const next = applyPentacleHostStatus(
    buildState({ sessions: [session({ host: 'beta', stream_id: 'beta:chat-1' })] }),
    {
      host: 'beta',
      online: false,
      checked_at: '2026-04-24T10:00:00.000Z',
      session_count: 0,
      error: 'probe failed',
    },
  );

  expect(next.hosts.beta?.online).toBe(true);
  expect(next.hosts.beta?.session_count).toBe(1);
  expect(next.hosts.beta?.error).toBe(undefined);
});

test('applyPentacleHostStatus preserves offline host status fields when live sessions still exist', () => {
  const next = applyPentacleHostStatus(
    buildState({ sessions: [session({ host: 'beta', stream_id: 'beta:chat-1' })] }),
    {
      host: 'beta',
      online: false,
      checked_at: '2026-07-06T14:00:00.000Z',
      session_count: 0,
      error: 'probe failed',
      host_status_reason: 'unreachable',
      host_status_since: '2026-07-06T13:30:00.000Z',
    },
  );

  expect(next.hosts.beta?.online).toBe(true);
  expect(next.hosts.beta?.host_status_reason).toBe('unreachable');
  expect(next.hosts.beta?.host_status_since).toBe('2026-07-06T13:30:00.000Z');
});

test('applyPentacleSnapshotMessage preserves unknown host ids without legacy aliasing', () => {
  const next = applyPentacleSnapshotMessage(buildState(), {
    hosts: {
      legacy: { host: 'legacy', online: true, checked_at: '2026-04-24T10:00:00.000Z', session_count: 1 },
    },
    sessions: [
      session({ host: 'legacy', stream_id: 'legacy:codex-legacy-1', session_name: 'codex-legacy-1' }),
    ],
  });

  expect(next.hosts.legacy?.online).toBe(true);
  expect(next.hosts.legacy?.session_count).toBe(1);
  expect(next.sessions[0]?.host).toBe('legacy');
});

test('websocket snapshot draft working state reaches session display model', () => {
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: [
      event({ daemon_seq: 10, kind: 'ASSIST', text: 'Committed answer before current work' }),
    ],
    drafts: {
      'alpha:chat-1': event({
        daemon_seq: 11,
        kind: 'DRAFT',
        text: '',
        raw: {
          source: 'tmux-pane',
          working: true,
          working_label: 'Waiting for background terminal 1m 12s',
          pending: false,
        },
      }),
    },
    sessions: [
      session({
        working: false,
        working_label: '',
        last_text: 'Committed answer before current work',
        last_kind: 'ASSIST',
      }),
    ],
  });

  const detail = selectSessionDetail(next, 'alpha:chat-1', { includeDraft: false });

  expectPresent(detail);
  expect(detail.status).toBe('working');
  expect(detail.workingLabel).toBe('Waiting for background terminal 1m 12s');
  expect(detail.draftText).toBe('');
  expect(detail.transcriptItems.map((item) => item.text)).toEqual(['Committed answer before current work']);
});

test('websocket Claude pane snapshot translates into clean transcript and loading state', () => {
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: [
      event({
        daemon_seq: 20,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'USER',
        text: 'Run a shell command sleep 8, then reply with exactly done.',
      }),
      event({
        daemon_seq: 21,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'ASSIST',
        text: '⏺ Bash(sleep 8)',
      }),
      event({
        daemon_seq: 22,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'ASSIST',
        text: '  ⎿  origin     https://example.com/project-mobile.git (fetch)\n     origin     https://example.com/project-mobile.git (push)\n     ---\n     … +3 lines (ctrl+o to expand)\n  ⎿  Shell cwd was reset to /tmp/synthetic/workspace',
      }),
      event({
        daemon_seq: 23,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'ASSIST',
        text: "⏺ Pushed. Three new commits on example/project main:\n\n  - 1111111 — Synthetic baseline\n  - 2222222 — Synthetic composer styling\n  - 3333333 — Synthetic multiline description (continued on the\n  next line)",
      }),
      event({
        daemon_seq: 24,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'ASSIST',
        text: '✻ Wibbling… (4s · ↓ 141 tokens)',
      }),
    ],
    drafts: {
      'alpha:claude-1': event({
        daemon_seq: 25,
        provider: 'claude',
        session_id: 'alpha:claude-1',
        session_name: 'claude-1',
        stream_id: 'alpha:claude-1',
        kind: 'DRAFT',
        text: '✻ Wibbling… (4s · ↓ 141 tokens)',
        raw: {
          working: true,
          working_label: '✻ Wibbling… (4s · ↓ 141 tokens)',
          pending: false,
        },
      }),
    },
    sessions: [
      session({
        provider: 'claude',
        stream_id: 'alpha:claude-1',
        session_name: 'claude-1',
        last_text: '✻ Wibbling… (4s · ↓ 141 tokens)',
        last_kind: 'ASSIST',
        working: false,
      }),
    ],
  });

  const detail = selectSessionDetail(next, 'alpha:claude-1', { includeDraft: false });

  expectPresent(detail);
  expect(next.events.some((item) => item.text.includes('Wibbling'))).toBe(false);
  expect(next.sessions[0]?.last_text).toBe('');
  expect(detail.status).toBe('working');
  expect(detail.workingLabel).toBe('Wibbling 4s');
  expect(detail.transcriptItems.map((item) => [item.displayRule, item.text])).toEqual([
    ['bubble:user', 'Run a shell command sleep 8, then reply with exactly done.'],
    ['bubble:assistant', "Pushed. Three new commits on example/project main:\n\n- 1111111 — Synthetic baseline\n- 2222222 — Synthetic composer styling\n- 3333333 — Synthetic multiline description (continued on the\nnext line)"],
  ]);

  const verboseDetail = selectSessionDetail(next, 'alpha:claude-1', {
    includeDraft: false,
    showToolActions: true,
  });
  expect(verboseDetail?.transcriptItems.map((item) => [item.displayRule, item.text])).toEqual([
    ['bubble:user', 'Run a shell command sleep 8, then reply with exactly done.'],
    ['activity:command', 'Bash(sleep 8)'],
    ['activity:tool-output', 'origin     https://example.com/project-mobile.git (fetch)\norigin     https://example.com/project-mobile.git (push)\n---\n… +3 lines'],
    ['bubble:assistant', "Pushed. Three new commits on example/project main:\n\n- 1111111 — Synthetic baseline\n- 2222222 — Synthetic composer styling\n- 3333333 — Synthetic multiline description (continued on the\nnext line)"],
  ]);
});

test('applyPentacleEvent accepts Claude JSONL transcript kinds without pane noise filtering', () => {
  let state = buildState();
  for (const name of [
    'claude-jsonl-user-message',
    'claude-jsonl-assistant-text',
    'claude-jsonl-thinking',
    'claude-jsonl-tool-use-bash',
    'claude-jsonl-tool-result-read',
    'claude-jsonl-codeblock-text',
  ]) {
    state = applyPentacleEvent(state, claudeFixture(name));
  }

  expect(state.events.map((item) => item.kind)).toEqual([
    'USER',
    'ASSIST_TEXT',
    'THINKING',
    'TOOL_USE',
    'TOOL_RESULT',
    'ASSIST_TEXT',
  ]);
  expect(state.events.every((item) => item.raw?.source === 'claude-jsonl')).toBe(true);
});

test('applyPentacleEvent uses Claude JSONL WORKING events as session state only', () => {
  // Session already known from inventory; transcript events update its row.
  const seeded = buildState({ sessions: [session({
    stream_id: 'beta:claude-jsonl-fixture', host: 'beta', provider: 'claude', session_name: 'claude-jsonl-fixture',
  })] });
  const base = applyPentacleEvent(seeded, claudeFixture('claude-jsonl-assistant-text'));
  const inflight = applyPentacleEvent(base, claudeFixture('claude-jsonl-working-inflight'));
  const resolved = applyPentacleEvent(inflight, claudeFixture('claude-jsonl-working-resolved'));

  expect(inflight.events.length).toBe(1);
  expect(inflight.sessions[0]?.working).toBe(true);
  expect(inflight.sessions[0]?.working_label).toBe('Bash');
  expect(resolved.events.length).toBe(1);
  expect(resolved.sessions[0]?.working).toBe(false);
  expect(resolved.sessions[0]?.working_label).toBe('');
});

test('applyPentacleSnapshotMessage keeps Claude JSONL fixtures and filters no draft echoes', () => {
  const noDraft = claudeScenario('claude-jsonl-no-draft-echo');
  const next = applyPentacleSnapshotMessage(buildState(), {
    events: noDraft.events,
    sessions: [noDraft.session],
  });

  expect(next.events.length).toBe(0);
  expect(next.drafts).toEqual({});
  expect(next.sessions[0]?.draft).toBe('');
});

// === Stage 3: reducer-owned turn phase (workingByStream tri-state) ===
//
// Spec: work/active/pentacle-mobile__chat_screen_simplification_2026_05_16/spec.md
// Inbox: msg_12 — implements Target State pseudocode for workingByStream.

const STREAM_ID = 'alpha:chat-1';

describe('isSystemEndOfTurnEvent — centralized predicate', () => {
  test('matches Claude jsonl turn-summary shape (claude_jsonl.py:200-204)', () => {
    expect(isSystemEndOfTurnEvent(event({
      kind: 'SYSTEM',
      text: 'Worked for 1m 14s',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary', duration_ms: 74000 },
    }))).toBe(true);
  });

  test('matches Codex pane parser terminal-divider shape (chat_streamd.py:808-815)', () => {
    expect(isSystemEndOfTurnEvent(event({
      kind: 'SYSTEM',
      text: '─ Worked for 1m 14s ─────────────────────────────────────────────────────────────────────────────',
    }))).toBe(true);
    expect(isSystemEndOfTurnEvent(event({
      kind: 'SYSTEM',
      text: '────────────────────────────────────────────────────────────────────────────────────────────────',
    }))).toBe(true);
  });

  test('matches subtype/displayRule raw markers', () => {
    expect(isSystemEndOfTurnEvent(event({ kind: 'SYSTEM', text: 'x', raw: { subtype: 'terminal-divider' } }))).toBe(true);
    expect(isSystemEndOfTurnEvent(event({ kind: 'SYSTEM', text: 'x', raw: { displayRule: 'terminal:divider' } }))).toBe(true);
    expect(isSystemEndOfTurnEvent(event({ kind: 'SYSTEM', text: 'x', raw: { display_rule: 'activity:turn-summary' } }))).toBe(true);
  });

  test('rejects non-SYSTEM events and non-divider SYSTEM text', () => {
    expect(isSystemEndOfTurnEvent(event({ kind: 'ASSIST', text: '─ Worked for 1m 14s ────────' }))).toBe(false);
    expect(isSystemEndOfTurnEvent(event({ kind: 'SYSTEM', text: 'API Error: rate limit' }))).toBe(false);
    expect(isSystemEndOfTurnEvent(null)).toBe(false);
    expect(isSystemEndOfTurnEvent(undefined)).toBe(false);
  });
});

describe('workingByStream — turn phase transitions', () => {
  test('beginPentacleTurn sets phase: pending with optimisticId + sentAt', () => {
    const next = beginPentacleTurn(buildState(), STREAM_ID, 'opt-1', 1700000000000);
    expect(next.workingByStream?.[STREAM_ID]).toEqual({
      phase: 'pending',
      optimisticId: 'opt-1',
      sentAt: 1700000000000,
    });
  });

  test('client-origin optimistic USER does not advance pending → working', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', 1);
    const next = applyPentacleEvent(pending, event({
      daemon_seq: Number.NaN,
      kind: 'USER',
      text: 'hi',
      client_origin: true,
      optimistic_id: 'opt-1',
      pending: true,
    }));
    expect(next.workingByStream?.[STREAM_ID]?.phase).toBe('pending');
  });

  test('first non-client event after pending → phase: working with firstServerEventAt = client clock', () => {
    const NOW = 1700000005000;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', NOW - 250);
      const next = applyPentacleEvent(pending, event({
        daemon_seq: 10,
        kind: 'ASSIST',
        // Event timestamp is the server clock; firstServerEventAt should use the
        // client clock at observation (Date.now()), not this value.
        timestamp: '2026-04-24T10:00:10.000Z',
        text: 'on it',
      }));
      const turn = next.workingByStream?.[STREAM_ID];
      expect(turn?.phase).toBe('working');
      expect(turn?.firstServerEventAt).toBe(NOW);
      expect(turn?.optimisticId).toBe('opt-1');
      expect(turn?.sentAt).toBe(NOW - 250);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('WORKING raw.working=false → idle/working_false', () => {
    const working = beginPentacleTurn(
      buildState({ sessions: [session({ working: true })] }),
      STREAM_ID,
      'opt-1',
      1,
    );
    const next = applyPentacleEvent(working, event({
      kind: 'WORKING',
      text: '',
      raw: { working: false },
    }));
    const turn = next.workingByStream?.[STREAM_ID];
    expect(turn?.phase).toBe('idle');
    expect(turn?.endReason).toBe('working_false');
    expect(typeof turn?.endedAt).toBe('number');
  });

  test('Claude SYSTEM turn-summary closes the turn with endReason: turn_summary', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session({ provider: 'claude' })] }), STREAM_ID, 'opt-1', 1);
    const working = applyPentacleEvent(pending, event({
      daemon_seq: 10,
      provider: 'claude',
      kind: 'ASSIST',
      text: 'thinking',
    }));
    const ended = applyPentacleEvent(working, event({
      daemon_seq: 11,
      provider: 'claude',
      kind: 'SYSTEM',
      text: 'Worked for 1m 14s',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary', duration_ms: 74000 },
    }));
    expect(ended.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
    expect(ended.workingByStream?.[STREAM_ID]?.endReason).toBe('turn_summary');
  });

  test('Codex SYSTEM "─ Worked for ..." terminal-divider closes the turn (Bug D fix)', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session({ provider: 'codex' })] }), STREAM_ID, 'opt-1', 1);
    const working = applyPentacleEvent(pending, event({
      daemon_seq: 20,
      provider: 'codex',
      kind: 'ASSIST',
      text: 'on it',
    }));
    expect(working.workingByStream?.[STREAM_ID]?.phase).toBe('working');
    const ended = applyPentacleEvent(working, event({
      daemon_seq: 21,
      provider: 'codex',
      kind: 'SYSTEM',
      text: '─ Worked for 1m 14s ─────────────────────────────────────────────────────────────────────────────',
    }));
    expect(ended.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
    expect(ended.workingByStream?.[STREAM_ID]?.endReason).toBe('terminal_divider');
  });

  test('Codex SYSTEM bare divider (────────) also closes the turn', () => {
    const working = applyPentacleEvent(
      beginPentacleTurn(buildState({ sessions: [session({ provider: 'codex' })] }), STREAM_ID, 'opt-1', 1),
      event({ daemon_seq: 20, provider: 'codex', kind: 'ASSIST', text: 'on it' }),
    );
    const ended = applyPentacleEvent(working, event({
      daemon_seq: 21,
      provider: 'codex',
      kind: 'SYSTEM',
      text: '────────────────────────────────────────────────────────────────────────────────────────────────',
    }));
    expect(ended.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
    expect(ended.workingByStream?.[STREAM_ID]?.endReason).toBe('terminal_divider');
  });

  test('applyPentacleSessionSummary falling edge: working true → false closes the turn', () => {
    // Models any session_summary path (spawn.ok, rename.ok, or the inner
    // call from applyPentacleEvent) where the freshly observed summary flips
    // session.working off while a turn is in flight.
    const { applyPentacleSessionSummary } = require('pentacle-chat-core');
    const working = beginPentacleTurn(
      buildState({ sessions: [session({ working: true })] }),
      STREAM_ID,
      'opt-1',
      1,
    );
    const closed = applyPentacleSessionSummary(working, session({ working: false }));
    expect(closed.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
    expect(closed.workingByStream?.[STREAM_ID]?.endReason).toBe('working_false');
  });

  describe('resync reconciles a stuck working turn against the authoritative working flag (chat_detail_stale_working_flag_2026_06_15)', () => {
    // A daemon resync (snapshot / session inventory — e.g. the all-chats
    // pull-to-refresh path) carries workingByStream forward. The detail screen's
    // spinner + composer lock read workingByStream while the list reads
    // session.working, so the resync must close a server-acknowledged ('working')
    // turn whose stream is reported working:false, or the detail stays locked
    // while the list shows idle.
    function workingTurn() {
      // pending → working: a non-client server event advances the optimistic turn.
      const turn = applyPentacleEvent(
        beginPentacleTurn(buildState({ sessions: [session({ working: true })] }), STREAM_ID, 'opt-1', 1),
        event({ daemon_seq: 10, kind: 'ASSIST', text: 'on it' }),
      );
      expect(turn.workingByStream?.[STREAM_ID]?.phase).toBe('working');
      return turn;
    }

    test('applyPentacleSessionInventory working:false closes a stuck working turn (pull-to-refresh repro)', () => {
      const reconciled = applyPentacleSessionInventory(workingTurn(), [session({ working: false })]);
      expect(reconciled.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
      expect(reconciled.workingByStream?.[STREAM_ID]?.endReason).toBe('working_false');
    });

    test('applyPentacleSnapshotMessage working:false closes a stuck working turn', () => {
      const reconciled = applyPentacleSnapshotMessage(workingTurn(), { sessions: [session({ working: false })] });
      expect(reconciled.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
      expect(reconciled.workingByStream?.[STREAM_ID]?.endReason).toBe('working_false');
    });

    test('resync working:true leaves an in-flight working turn working (no false close)', () => {
      const stillWorking = applyPentacleSessionInventory(workingTurn(), [session({ working: true })]);
      expect(stillWorking.workingByStream?.[STREAM_ID]?.phase).toBe('working');
    });

    test('resync working:false leaves an optimistic pending turn pending (optimistic lifecycle owns it)', () => {
      const pending = beginPentacleTurn(buildState({ sessions: [session({ working: true })] }), STREAM_ID, 'opt-1', 42);
      expect(applyPentacleSessionInventory(pending, [session({ working: false })]).workingByStream?.[STREAM_ID]?.phase).toBe('pending');
      expect(applyPentacleSnapshotMessage(pending, { sessions: [session({ working: false })] }).workingByStream?.[STREAM_ID]?.phase).toBe('pending');
    });

    test('applyFetchedStreamEvents (detail-open fetch) does NOT close a working turn — recovery is owned by the resync paths', () => {
      // The fetch does not refresh session.working, so reconciling here could
      // race-close a live turn. Detail-open relies on snapshot/inventory instead.
      const stuck = buildState({
        sessions: [session({ working: false })],
        workingByStream: { [STREAM_ID]: { phase: 'working', optimisticId: 'opt-1', sentAt: 1 } },
      });
      const after = applyFetchedStreamEvents(stuck, [event({ daemon_seq: 99, kind: 'ASSIST', text: 'history line' })]);
      expect(after.workingByStream?.[STREAM_ID]?.phase).toBe('working');
    });
  });

  test('end-of-turn idle persists across subsequent unrelated events (no false re-arm)', () => {
    const ended = applyPentacleEvent(
      applyPentacleEvent(
        beginPentacleTurn(buildState({ sessions: [session({ provider: 'codex' })] }), STREAM_ID, 'opt-1', 1),
        event({ daemon_seq: 1, provider: 'codex', kind: 'ASSIST', text: 'on it' }),
      ),
      event({ daemon_seq: 2, provider: 'codex', kind: 'SYSTEM', text: '─ Worked for 12s ────────────────' }),
    );
    expect(ended.workingByStream?.[STREAM_ID]?.phase).toBe('idle');

    // A late ASSIST after idle MUST NOT flip the phase back to working.
    const later = applyPentacleEvent(ended, event({
      daemon_seq: 3,
      provider: 'codex',
      kind: 'ASSIST',
      text: 'follow-up text',
    }));
    expect(later.workingByStream?.[STREAM_ID]?.phase).toBe('idle');
  });

  test('removePentacleStream cleans up workingByStream', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', 1);
    expect(pending.workingByStream?.[STREAM_ID]).toBeDefined();
    const removed = removePentacleStream(pending, STREAM_ID);
    expect(removed.workingByStream?.[STREAM_ID]).toBeUndefined();
  });

  test('snapshot replacement drops workingByStream entries for streams no longer present', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', 1);
    const snapshot = applyPentacleSnapshotMessage(pending, {
      sessions: [session({ stream_id: 'alpha:other', session_name: 'other' })],
    });
    expect(snapshot.workingByStream?.[STREAM_ID]).toBeUndefined();
  });

  test('snapshot replacement preserves workingByStream entries for surviving streams', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', 42);
    const snapshot = applyPentacleSnapshotMessage(pending, {
      sessions: [session()],
    });
    expect(snapshot.workingByStream?.[STREAM_ID]?.phase).toBe('pending');
    expect(snapshot.workingByStream?.[STREAM_ID]?.sentAt).toBe(42);
  });

  test('session inventory drops workingByStream entries for streams no longer present', () => {
    const pending = beginPentacleTurn(buildState({ sessions: [session()] }), STREAM_ID, 'opt-1', 1);
    const inventory = applyPentacleSessionInventory(pending, [
      session({ stream_id: 'alpha:other', session_name: 'other' }),
    ]);
    expect(inventory.workingByStream?.[STREAM_ID]).toBeUndefined();
  });

  test('session inventory keeps a freshly-added optimistic whose stream is not yet in the inventory (spawn-race grace)', () => {
    // Regression: on spawn-then-send, the daemon may broadcast a
    // session.inventory that was generated BEFORE our newly-spawned
    // stream landed in session_summaries. Without the grace window,
    // applyPentacleSessionInventory drops our optimistic and the
    // subsequent USER chat.event arrives to an empty optimisticSends —
    // reconcile silently misses, send_again_skipped fires with
    // reason='reconcile_timeout'. The grace keeps optimistics younger
    // than OPTIMISTIC_INVENTORY_GRACE_MS alive even when the stream is
    // not in the inventory. Spec:
    // spec_pentacle_mobile_inventory_wipes_recent_optimistic_2026_05_17.
    const now = 1_700_000_000_000;
    const newStream = 'hostc:claude-hostc-fresh';
    const withOptimistic = sendOptimisticMessage(buildState(), {
      streamId: newStream,
      text: 'say your name',
      optimisticId: 'opt-fresh-1',
      requestId: 'send-fresh-1',
      createdAt: now,
    });
    expect(withOptimistic.optimisticSends?.['opt-fresh-1']?.stream_id).toBe(newStream);
    // Inventory broadcast omits the new stream (race with spawn-summary).
    const inventory = applyPentacleSessionInventory(
      withOptimistic,
      [session({ stream_id: 'hostc:claude-existing', session_name: 'existing' })],
      now + 500, // 500ms after optimistic created — well within grace
    );
    expect(inventory.optimisticSends?.['opt-fresh-1']?.stream_id).toBe(newStream);
    // optimisticByRequestId must rebuild to include the surviving optimistic.
    expect(inventory.optimisticByRequestId?.['send-fresh-1']).toBe('opt-fresh-1');
  });

  test('session inventory drops a stale optimistic whose stream is missing AND grace has elapsed', () => {
    // The grace is bounded — an optimistic for a stream that's been
    // missing for longer than OPTIMISTIC_INVENTORY_GRACE_MS gets dropped
    // by the next inventory. Locks in that the grace is not unbounded
    // leakage of stale optimistics.
    const now = 1_700_000_000_000;
    const oldStream = 'hostc:claude-hostc-old';
    const withOptimistic = sendOptimisticMessage(buildState(), {
      streamId: oldStream,
      text: 'old text',
      optimisticId: 'opt-stale-1',
      requestId: 'send-stale-1',
      createdAt: now,
    });
    const past_grace = now + OPTIMISTIC_INVENTORY_GRACE_MS + 1;
    const inventory = applyPentacleSessionInventory(
      withOptimistic,
      [session({ stream_id: 'hostc:claude-other', session_name: 'other' })],
      past_grace,
    );
    expect(inventory.optimisticSends?.['opt-stale-1']).toBeUndefined();
    expect(inventory.optimisticByRequestId?.['send-stale-1']).toBeUndefined();
  });
});

describe('applyPentacleEvent — agent question on session summary', () => {
  const QUESTION = {
    header: 'Pick',
    prompt: 'Pick a number.',
    options: [
      { index: 1, label: '1', description: 'The number one.', meta: false },
      { index: 2, label: '2', description: 'The number two.', meta: false },
      { index: 3, label: 'Type something.', description: '', meta: true },
    ],
  };

  // The session is already known from inventory (rows carry `visibility`); a
  // transcript event no longer materializes a list row for an unseen session
  // (mirror-freshness fail-closed), so seed the row these tests update.
  const seeded = () => buildState({ sessions: [session()] });

  test('WORKING event with raw.question populates session.question', () => {
    const next = applyPentacleEvent(
      seeded(),
      event({ daemon_seq: 1, kind: 'WORKING', text: '', raw: { working: true, question: QUESTION } }),
    );
    expect(next.sessions[0]?.question).toEqual(QUESTION);
  });

  test('DRAFT event with raw.question populates session.question', () => {
    const next = applyPentacleEvent(
      seeded(),
      event({ daemon_seq: 1, kind: 'DRAFT', text: 'partial', raw: { working: true, question: QUESTION } }),
    );
    expect(next.sessions[0]?.question).toEqual(QUESTION);
  });

  test('a subsequent DRAFT event without raw.question preserves the pending question', () => {
    let state = applyPentacleEvent(
      seeded(),
      event({ daemon_seq: 1, kind: 'WORKING', text: '', raw: { working: true, question: QUESTION } }),
    );
    expectPresent(state.sessions[0]?.question);
    state = applyPentacleEvent(
      state,
      event({ daemon_seq: 2, kind: 'DRAFT', text: 'answered', raw: { working: true } }),
    );
    expect(state.sessions[0]?.question).toEqual(QUESTION);
  });

  test('an explicit null raw.question clears the pending question', () => {
    let state = applyPentacleEvent(
      seeded(),
      event({ daemon_seq: 1, kind: 'WORKING', text: '', raw: { working: true, question: QUESTION } }),
    );
    state = applyPentacleEvent(
      state,
      event({ daemon_seq: 2, kind: 'WORKING', text: '', raw: { working: true, question: null } }),
    );
    expect(state.sessions[0]?.question).toBeNull();
  });

  test('question is null by default when no raw.question is present', () => {
    const next = applyPentacleEvent(
      seeded(),
      event({ daemon_seq: 1, kind: 'WORKING', text: '', raw: { working: true } }),
    );
    expect(next.sessions[0]?.question).toBeNull();
  });
});

type DismissQuestionSocketEvent = { data?: string };

class DismissQuestionMockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: DismissQuestionMockWebSocket[] = [];

  readyState = DismissQuestionMockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: DismissQuestionSocketEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    DismissQuestionMockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = DismissQuestionMockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = DismissQuestionMockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function loadPentacleStreamForDismissQuestion() {
  jest.resetModules();
  jest.doMock('../src/config/pentacle', () => ({
    getDefaultPentacleWsUrl: () => 'ws://dismiss-question.example/ws',
  }));
  DismissQuestionMockWebSocket.instances = [];
  Object.assign(DismissQuestionMockWebSocket, {
    CONNECTING: DismissQuestionMockWebSocket.CONNECTING,
    OPEN: DismissQuestionMockWebSocket.OPEN,
    CLOSED: DismissQuestionMockWebSocket.CLOSED,
  });
  global.WebSocket = DismissQuestionMockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

async function expectDismissQuestionPayload(args: {
  host: string;
  sessionName: string;
  questionKey: string;
  text?: string;
}) {
  const stream = loadPentacleStreamForDismissQuestion();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = DismissQuestionMockWebSocket.instances[0];
  socket.open();

  const pending = stream.dismissQuestion(args);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toMatchObject({
    type: 'question.dismiss',
    host: args.host,
    session_name: args.sessionName,
    question_key: args.questionKey,
  });
  if (args.text === undefined) {
    expect(Object.prototype.hasOwnProperty.call(payload, 'text')).toBe(false);
  } else {
    expect(payload.text).toBe(args.text);
  }
  expect(typeof payload.request_id).toBe('string');

  socket.message({
    type: 'question.dismiss.ok',
    request_id: payload.request_id,
    dismissed: true,
    text_submitted: args.text !== undefined,
  });
  await expect(pending).resolves.toEqual({
    dismissed: true,
    textSubmitted: args.text !== undefined,
  });
  unsubscribe();
}

test('composite hello/send keeps wire identity, reply metadata, acceptance, and retry identity', async () => {
  jest.useFakeTimers();
  const stream = loadPentacleStreamForDismissQuestion();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = DismissQuestionMockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: 'hosta:hosta',
      host: 'hosta',
      provider: 'composite',
      session_name: 'hosta',
      session_kind: 'assistant_composite',
      visibility: 'visible',
      capabilities: {
        pane: false,
        terminal: false,
        assistant_composite_v1: true,
        reply_metadata_v1: true,
      },
      last_event_at: '2026-09-19T12:00:00.000Z',
      last_text: '',
      last_kind: '',
      online: true,
    }],
  });

  const hello = socket.sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.type === 'hello');
  expect(hello?.capabilities).toEqual({ assistant_composite_v1: true });

  const optimisticId = stream.sendTurn('hosta:hosta', 'follow up');
  const firstSend = stream.sendPentacleMessage({
    host: 'hosta',
    sessionName: 'hosta',
    text: 'follow up',
    optimisticId,
    replyToMessageId: 'message-1',
    replyToQuestionId: 'question-1',
  });
  const firstPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(firstPayload).toMatchObject({
    type: 'send',
    msg_id: optimisticId,
    stream_id: 'hosta:hosta',
    message: 'follow up',
    reply_to_message_id: 'message-1',
    reply_to_question_id: 'question-1',
  });
  expect(firstPayload.text).toBeUndefined();
  expect(firstPayload.host).toBeUndefined();
  socket.message({
    type: 'send.ok',
    request_id: firstPayload.request_id,
    message_id: 'message-2',
    routing_state: 'queued',
    accepted_sequence: 4,
    queue_sequence: 4,
    action_committed: true,
  });
  await expect(firstSend).resolves.toBe(true);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    optimistic_id: optimisticId,
    message_id: 'message-2',
    routing_state: 'queued',
    accepted_sequence: 4,
    queue_sequence: 4,
    action_committed: true,
    reply_to_message_id: 'message-1',
    reply_to_question_id: 'question-1',
  });

  stream.markOptimisticFailed(optimisticId, 'retryable');
  const retry = stream.retryOptimisticSend(optimisticId);
  const retryPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(retryPayload.msg_id).toBe(optimisticId);
  expect(retryPayload.request_id).not.toBe(firstPayload.request_id);
  expect(retryPayload.reply_to_message_id).toBe('message-1');
  expect(retryPayload.reply_to_question_id).toBe('question-1');
  socket.message({ type: 'send.ok', request_id: retryPayload.request_id });
  await expect(retry).resolves.toBe(true);
  unsubscribe();
  jest.useRealTimers();
});

describe('dismissQuestion — question.dismiss wire payload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test.each([
    ['with text', { host: 'hostc', sessionName: 'claude-one', questionKey: 'q-key', text: 'Answering your question:\n\nQ1 (Pick): 2' }],
    ['cancel-only', { host: 'hostc', sessionName: 'claude-one', questionKey: 'q-key' }],
  ])('%s', async (_label, args) => {
    await expectDismissQuestionPayload(args);
  });

  test('question.dismiss.error preserves daemon error_code on rejection', async () => {
    const stream = loadPentacleStreamForDismissQuestion();
    const unsubscribe = stream.subscribePentacleStream(jest.fn());
    jest.advanceTimersByTime(0);
    const socket = DismissQuestionMockWebSocket.instances[0];
    socket.open();

    const pending = stream.dismissQuestion({
      host: 'hostc',
      sessionName: 'claude-one',
      questionKey: 'q-key',
      text: 'Answering your question:\n\nQ1 (Pick): 2',
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    socket.message({
      type: 'question.dismiss.error',
      request_id: payload.request_id,
      error_code: 'text_send_failed',
      error: 'send failed',
    });

    await expect(pending).rejects.toMatchObject({ errorCode: 'text_send_failed' });
    unsubscribe();
  });
});

describe('optimistic question answer transport and durable reconciliation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function connectedStream() {
    const stream = loadPentacleStreamForDismissQuestion();
    const unsubscribe = stream.subscribePentacleStream(jest.fn());
    jest.advanceTimersByTime(0);
    const socket = DismissQuestionMockWebSocket.instances[0];
    socket.open();
    socket.message({
      type: 'snapshot',
      sessions: [{
        stream_id: 'hostc:codex:question', host: 'hostc', provider: 'codex',
        session_name: 'question', title: 'Question', online: true,
      }],
      events: [],
    });
    return { stream, socket, unsubscribe };
  }

  function notificationAnswerEvent(seq: number) {
    return {
      daemon_seq: seq,
      stream_id: 'hostc:codex:question',
      host: 'hostc',
      provider: 'codex',
      session_id: 'question',
      session_name: 'question',
      timestamp: `2026-07-12T12:00:0${seq}.000Z`,
      kind: 'USER',
      text: JSON.stringify({
        type: 'notification.answer',
        notification_id: 'n-question',
        question_id: 'q-lane',
        answer: { text: 'canonical text intentionally differs' },
      }),
    };
  }

  test('pane dispatch carries the explicitly-created optimistic identity on send', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const optimisticId = stream.beginOptimisticQuestionAnswer({
      streamId: 'hostc:codex:question',
      text: 'formatted pane answer',
    });
    const pending = stream.sendPentacleMessage({
      host: 'hostc',
      sessionName: 'question',
      text: 'formatted pane answer',
      optimisticId,
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    expect(payload).toMatchObject({
      type: 'send',
      text: 'formatted pane answer',
      optimistic_id: optimisticId,
    });
    socket.message({ type: 'send.ok', request_id: payload.request_id });
    await expect(pending).resolves.toBe(true);
    unsubscribe();
  });

  test('resolve ack before echo queues then reconciles by notification and question identity', () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const optimisticId = stream.beginOptimisticQuestionAnswer({
      streamId: 'hostc:codex:question',
      text: 'optimistic text intentionally differs',
      notificationId: 'n-question',
      questionId: 'q-lane',
    });
    stream.queueOptimisticQuestionAnswer(optimisticId);
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('queued');

    socket.message({ type: 'chat.event', event: notificationAnswerEvent(1) });
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
    expect(stream.getPentacleStreamState().events.some((event) => event.correlatedDaemonSeq === 1)).toBe(true);
    unsubscribe();
  });

  test('echo before resolve ack reconciles once and makes the later queue transition a no-op', () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const optimisticId = stream.beginOptimisticQuestionAnswer({
      streamId: 'hostc:codex:question',
      text: 'optimistic answer',
      notificationId: 'n-question',
      questionId: 'q-lane',
    });
    socket.message({ type: 'chat.event', event: notificationAnswerEvent(2) });
    stream.queueOptimisticQuestionAnswer(optimisticId);

    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
    expect(stream.getPentacleStreamState().events.filter((event) => event.correlatedDaemonSeq === 2)).toHaveLength(1);
    unsubscribe();
  });

  test('snapshot canonical history uses the same durable identity reconciliation', () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const optimisticId = stream.beginOptimisticQuestionAnswer({
      streamId: 'hostc:codex:question',
      text: 'optimistic answer',
      notificationId: 'n-question',
      questionId: 'q-lane',
    });
    socket.message({ type: 'snapshot', events: [notificationAnswerEvent(3)] });
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
    unsubscribe();
  });
});

describe('spawn catalog and V2 mobile spawn wire contract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function connectedStream() {
    const stream = loadPentacleStreamForDismissQuestion();
    const unsubscribe = stream.subscribePentacleStream(jest.fn());
    jest.advanceTimersByTime(0);
    const socket = DismissQuestionMockWebSocket.instances[0];
    socket.open();
    return { stream, socket, unsubscribe };
  }

  test('catalog request resolves the canonical CatalogV1 frame', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.getSpawnCatalog();
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    expect(payload).toMatchObject({ type: 'spawn_catalog_get' });
    socket.message({
      type: 'spawn_catalog_get.ok',
      request_id: payload.request_id,
      schema_version: 'CatalogV1',
      catalog_version: 'spawn-catalog-v1',
      profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-5.6-sol', 'high'] } },
      models: {
        claude: { 'claude-opus-4-8': { efforts: ['high'] } },
        codex: { 'gpt-5.6-sol': { efforts: ['high'] } },
      },
    });
    await expect(pending).resolves.toMatchObject({ schema_version: 'CatalogV1', catalog_version: 'spawn-catalog-v1' });
    unsubscribe();
  });

  test('catalog request rejects a profile default absent from the provider model efforts', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.getSpawnCatalog();
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    socket.message({
      type: 'spawn_catalog_get.ok',
      request_id: payload.request_id,
      schema_version: 'CatalogV1',
      catalog_version: 'spawn-catalog-v1',
      profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['missing-model', 'high'] } },
      models: {
        claude: { 'claude-opus-4-8': { efforts: ['high'] } },
        codex: { 'gpt-5.6-sol': { efforts: ['high'] } },
      },
    });
    await expect(pending).rejects.toThrow('spawn catalog response is incomplete');
    unsubscribe();
  });

  test('V2 spawn sends every explicit tuple field and preserves ack read-back', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh',
      spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1', resolutionSource: 'explicit_override',
      objective: 'Reducer spawn test',
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    expect(payload).toMatchObject({
      type: 'spawn', schema: 'SpawnRequestV2', host: 'hostc', provider: 'codex',
      model: 'gpt-5.6-terra', effort: 'xhigh', spawn_profile: 'desktop_manual',
      catalog_version: 'spawn-catalog-v1', resolution_source: 'explicit_override',
    });
    socket.message({
      type: 'spawn.ok', request_id: payload.request_id,
      session: { stream_id: 'hostc:codex:new', host: 'hostc', provider: 'codex', session_name: 'new' },
      resolved: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' },
      actual_launch: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' },
      catalog_version: 'spawn-catalog-v1', resolution_source: 'explicit_override',
    });
    await expect(pending).resolves.toMatchObject({
      session: { stream_id: 'hostc:codex:new' },
      resolved: { model: 'gpt-5.6-terra', effort: 'xhigh' },
      actual_launch: { model: 'gpt-5.6-terra', effort: 'xhigh' },
    });
    unsubscribe();
  });

  // spec_pentacle_mobile__new_chat_spawn_duplication_p0_2026_08: the client intent id is what
  // makes a duplicate spawn collapse onto one session, so its wire shape is contract, not detail.
  test('V2 spawn carries the client intent id as idempotency_key and omits it when absent', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1', resolutionSource: 'profile_default',
      objective: 'Reducer spawn test',
      idempotencyKey: 'mob-spawn-1',
    }).catch(() => undefined);
    expect(JSON.parse(socket.sent.at(-1) || '{}')).toMatchObject({ idempotency_key: 'mob-spawn-1' });

    stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1', resolutionSource: 'profile_default',
      objective: 'Reducer spawn test',
    }).catch(() => undefined);
    expect(JSON.parse(socket.sent.at(-1) || '{}')).not.toHaveProperty('idempotency_key');
    unsubscribe();
  });

  test('a replayed spawn.ok resolves the duplicate onto the original session', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1', resolutionSource: 'profile_default',
      objective: 'Reducer spawn test',
      idempotencyKey: 'mob-spawn-replay',
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    socket.message({
      type: 'spawn.ok', request_id: payload.request_id, replayed: true,
      logical_spawn_request_id: 'spawn.v2-original',
      session: { stream_id: 'hostc:codex:first', host: 'hostc', provider: 'codex', session_name: 'first' },
    });
    await expect(pending).resolves.toMatchObject({ session: { stream_id: 'hostc:codex:first' } });
    unsubscribe();
  });

  test('spawn.indeterminate settles the request as ambiguous instead of hanging to timeout', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      spawnProfile: 'desktop_manual', catalogVersion: 'spawn-catalog-v1', resolutionSource: 'profile_default',
      objective: 'Reducer spawn test',
      idempotencyKey: 'mob-spawn-indeterminate',
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    socket.message({
      type: 'spawn.indeterminate', request_id: payload.request_id,
      error_code: 'idempotency_in_flight_timeout',
      reconcile: 'agent-orch await-spawn --request-id spawn.v2-original --timeout 30',
    });
    await expect(pending).rejects.toMatchObject({ errorCode: 'spawn_indeterminate' });
    unsubscribe();
  });

  test('V2 spawn keeps structured daemon errors', async () => {
    const { stream, socket, unsubscribe } = connectedStream();
    const pending = stream.spawnPentacleSessionV2({
      host: 'hostc', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      spawnProfile: 'desktop_manual', catalogVersion: 'stale', resolutionSource: 'profile_default',
      objective: 'Reducer spawn test',
    });
    const payload = JSON.parse(socket.sent.at(-1) || '{}');
    socket.message({
      type: 'spawn.error', request_id: payload.request_id,
      error: { code: 'spawn_catalog_version_conflict', message: 'Refresh catalog', remediation: 'Retry', supported_choices: ['spawn-catalog-v1'] },
    });
    await expect(pending).rejects.toMatchObject({
      errorCode: 'spawn_catalog_version_conflict', message: 'Refresh catalog', remediation: 'Retry', supportedChoices: ['spawn-catalog-v1'],
    });
    unsubscribe();
  });
});
