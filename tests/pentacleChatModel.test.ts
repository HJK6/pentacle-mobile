import { readFileSync } from 'node:fs';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function expectPresent<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeTruthy();
}
import {
  __getInterpretMissCountForTests,
  __resetInterpretMissCountForTests,
  diagSessionDetailCounts,
  selectChatList,
  selectMachineStatsTabs,
  selectMachineStatusList,
  selectSessionDetail,
} from 'pentacle-chat-core';
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';

function versionForEvent(event: any) {
  const text = JSON.stringify({
    seq: event?.daemon_seq,
    stream_id: event?.stream_id,
    kind: event?.kind,
    text: event?.text,
    provider: event?.provider,
    raw: event?.raw,
    optimistic_id: event?.optimistic_id,
    client_origin: event?.client_origin,
    pending: event?.pending,
  });
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash || 1;
}

function versionsByStream(events: any[]) {
  const versions: Record<string, number> = {};
  for (const event of events) {
    const streamId = String(event?.stream_id || '');
    if (!streamId) continue;
    versions[streamId] = ((versions[streamId] || 0) + versionForEvent(event)) >>> 0;
  }
  return versions;
}

function buildState(overrides: Partial<any> = {}) {
  const events = overrides.events ?? [];
  return {
    connected: true,
    connecting: false,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [],
    updates: [],
    notifications: [],
    eventContentVersionByStream: versionsByStream(events),
    ...overrides,
  };
}

function fixtureData() {
  return JSON.parse(readFileSync('test/fixtures/pentacle_mobile_chat_cases.json', 'utf8'));
}

function claudeFixture(name: string): any {
  const item = fixtureData().cases.find((candidate: { name: string }) => candidate.name === name);
  expectPresent(item);
  return item.event;
}

function claudeScenario(name: string): any {
  const item = fixtureData().scenarios.find((candidate: { name: string }) => candidate.name === name);
  expectPresent(item);
  return item;
}

function stateForClaudeEvents(events: any[], overrides: Partial<any> = {}) {
  return buildState({
    events,
    sessions: [
      {
        stream_id: 'beta:claude-jsonl-fixture',
        host: 'beta',
        provider: 'claude',
        session_name: 'claude-jsonl-fixture',
        last_event_at: events.at(-1)?.timestamp || '2026-04-30T05:20:50.484Z',
        last_text: events.at(-1)?.text || '',
        last_kind: events.at(-1)?.kind || '',
        draft: '',
        pending: false,
        working: false,
        online: true,
        ...overrides,
      },
    ],
  });
}

afterEach(() => {
  setTelemetrySink(null);
});

test('selectSessionDetail appends fallback assistant output when session summary is newer than visible events', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 10,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-1',
        session_name: 'chat-1',
        stream_id: 'alpha:chat-1',
        timestamp: '2026-04-24T10:00:00.000Z',
        kind: 'TOOL',
        text: 'ssh beta uptime',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-1',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-1',
        last_event_at: '2026-04-24T10:00:05.000Z',
        last_text: 'Final answer from Alpha',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-1', { includeTools: true });
  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(2);
  expect(detail.transcriptItems[0]?.kind).toBe('TOOL');
  expect(detail.transcriptItems[1]?.kind).toBe('ASSIST');
  expect(detail.transcriptItems[1]?.label).toBe('Alpha');
  expect(detail.transcriptItems[1]?.text).toBe('Final answer from Alpha');
});

test('selectSessionDetail does not leak session-summary fallback tool rows when tools are hidden', () => {
  const streamId = 'alpha:chat-tool-fallback';
  const state = buildState({
    events: [
      {
        daemon_seq: 12,
        host: 'alpha',
        provider: 'codex',
        session_id: streamId,
        session_name: 'chat-tool-fallback',
        stream_id: streamId,
        timestamp: '2026-05-27T10:00:00.000Z',
        kind: 'USER',
        text: 'please inspect the repo',
      },
    ],
    sessions: [
      {
        stream_id: streamId,
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-tool-fallback',
        last_event_at: '2026-05-27T10:00:05.000Z',
        last_text: 'Bash(git status --short)',
        last_kind: 'TOOL',
        draft: '',
        pending: false,
        working: true,
        online: true,
      },
    ],
  });
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  const hidden = selectSessionDetail(state, streamId, {
    includeTools: false,
    visibleCount: 'all',
  });
  expectPresent(hidden);
  expect(hidden.transcriptItems.map((item) => item.id)).toEqual(['12']);
  expect(hidden.transcriptItems.some((item) => item.id === `fallback:${streamId}`)).toBe(false);
  expect(
    seen.some(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED &&
        payload.data.source === 'session_summary_fallback' &&
        String(payload.data.display_rule || '').startsWith('activity:'),
    ),
  ).toBe(false);

  seen.length = 0;
  const shown = selectSessionDetail(state, streamId, {
    includeTools: true,
    visibleCount: 'all',
    // Chat-core gating defaults emitRenderTelemetry false; this assertion
    // checks the CHAT_EVENT_RENDERED payload, so opt in like the real render path.
    emitRenderTelemetry: true,
  });
  expectPresent(shown);
  expect(shown.transcriptItems.map((item) => [item.id, item.displayRule, item.text])).toEqual([
    ['12', 'bubble:user', 'please inspect the repo'],
    [`fallback:${streamId}`, 'activity:command', 'Bash(git status --short)'],
  ]);
  expect(
    seen.some(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED &&
        payload.data.source === 'session_summary_fallback' &&
        payload.data.display_rule === 'activity:command',
    ),
  ).toBe(true);
});

test('selectSessionDetail does not leak a structured TOOL_USE session-summary fallback when tools are hidden', () => {
  // Regression for a live Claude working-turn edge case: the live turn
  // sets session.last_kind='TOOL_USE' and last_text='Bash\n<command>'. The
  // fallback builds a synthetic event with NO `raw`, so the interpreter labels
  // it 'bubble:assistant' — but the item keeps kind 'TOOL_USE' and mobile
  // renders it as a ToolInvocationCard. isToolActionRow must catch tool KINDS so
  // the fallback is suppressed while tools are hidden. (The TOOL-kind test above
  // did NOT exercise this path: the interpreter classifies 'TOOL' differently.)
  const streamId = 'hostc:claude-hostc-tooluse-fallback';
  const state = buildState({
    events: [
      {
        daemon_seq: 5,
        host: 'hostc',
        provider: 'claude',
        session_id: streamId,
        session_name: 'tooluse-fallback',
        stream_id: streamId,
        timestamp: '2026-05-27T10:00:00.000Z',
        kind: 'USER',
        text: 'use the bash tool',
      },
    ],
    sessions: [
      {
        stream_id: streamId,
        host: 'hostc',
        provider: 'claude',
        session_name: 'tooluse-fallback',
        last_event_at: '2026-05-27T10:00:05.000Z',
        last_text: 'Bash\nprintf sample_tool_fallback',
        last_kind: 'TOOL_USE',
        draft: '',
        pending: false,
        working: true,
        online: true,
      },
    ],
  });

  const hidden = selectSessionDetail(state, streamId, { includeTools: false, visibleCount: 'all' });
  expectPresent(hidden);
  // The core assertion: no session-summary fallback row, and nothing carrying the
  // running Bash/tool text or a TOOL_USE kind leaks into the tools-hidden transcript.
  expect(hidden.transcriptItems.some((item) => String(item.id).startsWith(`fallback:${streamId}`))).toBe(false);
  expect(hidden.transcriptItems.some((item) => item.kind === 'TOOL_USE')).toBe(false);
  expect(hidden.transcriptItems.some((item) => (item.text || '').includes('printf sample_tool_fallback'))).toBe(false);

  const shown = selectSessionDetail(state, streamId, { includeTools: true, visibleCount: 'all' });
  expectPresent(shown);
  const fallback = shown.transcriptItems.find((item) => String(item.id).startsWith(`fallback:${streamId}`));
  expect(fallback).toBeTruthy();
  expect(fallback?.kind).toBe('TOOL_USE');
});

test('selectSessionDetail does not flicker the session-summary fallback while working (tools hidden)', () => {
  // Regression scenario: while the agent works, the fallback row at the bottom
  // churns through transient last_text values ("Thinking" -> "Ran 1 shell
  // command" -> "Worked for 4s · 25 msgs" -> a running Bash command), re-mounting
  // every tick = a fast flicker + a noisy "Worked for Ns · N msgs" row. With
  // tools hidden, no fallback should append while working; tools-on still shows it.
  const streamId = 'hostc:claude-hostc-flicker';
  const mk = (lastText: string, lastKind: string) => buildState({
    events: [
      { daemon_seq: 7, host: 'hostc', provider: 'claude', session_id: streamId, session_name: 's', stream_id: streamId, timestamp: '2026-05-27T10:00:00.000Z', kind: 'USER', text: 'do the thing' },
      { daemon_seq: 8, host: 'hostc', provider: 'claude', session_id: streamId, session_name: 's', stream_id: streamId, timestamp: '2026-05-27T10:00:01.000Z', kind: 'ASSIST', text: 'On it.' },
    ],
    sessions: [
      { stream_id: streamId, host: 'hostc', provider: 'claude', session_name: 's', last_event_at: '2026-05-27T10:00:05.000Z', last_text: lastText, last_kind: lastKind, draft: '', pending: false, working: true, online: true },
    ],
  });

  for (const [text, kind] of [['Worked for 4s · 25 msgs', 'SYSTEM'], ['Thinking', 'THINKING'], ['Ran 1 shell command', 'ASSIST']] as const) {
    const hidden = selectSessionDetail(mk(text, kind), streamId, { includeTools: false, visibleCount: 'all' });
    expectPresent(hidden);
    expect(hidden.transcriptItems.some((item) => String(item.id).startsWith(`fallback:${streamId}`))).toBe(false);
    expect(hidden.transcriptItems.some((item) => (item.text || '').includes('Worked for'))).toBe(false);
  }

  // tools-on view still surfaces live activity while working (opt-in preserved).
  const shown = selectSessionDetail(mk('Worked for 4s · 25 msgs', 'SYSTEM'), streamId, { includeTools: true, visibleCount: 'all' });
  expectPresent(shown);
  expect(shown.transcriptItems.some((item) => String(item.id).startsWith(`fallback:${streamId}`))).toBe(true);
});

test('selectSessionDetail drops terminal-furniture events and fallback summaries', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 20,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:divider-fallback',
        session_name: 'divider-fallback',
        stream_id: 'alpha:divider-fallback',
        timestamp: '2026-05-16T12:00:01.000Z',
        kind: 'SYSTEM',
        text: 'Worked for 1s',
      },
      {
        daemon_seq: 21,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:divider-fallback',
        session_name: 'divider-fallback',
        stream_id: 'alpha:divider-fallback',
        timestamp: '2026-05-16T12:00:02.000Z',
        kind: 'SYSTEM',
        text: '',
        raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:divider-fallback',
        host: 'alpha',
        provider: 'codex',
        session_name: 'divider-fallback',
        last_event_at: '2026-05-16T12:00:04.000Z',
        last_text: 'Worked for 4s',
        last_kind: 'SYSTEM',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:divider-fallback', {
    includeSystem: true,
    visibleCount: 'all',
  });

  expectPresent(detail);
  expect(detail.transcriptItems).toEqual([]);
});

test('diagSessionDetailCounts matches selectSessionDetail row counts without render telemetry', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 110,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:diag-counts',
        session_name: 'diag-counts',
        stream_id: 'alpha:diag-counts',
        timestamp: '2026-05-10T10:00:00.000Z',
        kind: 'USER',
        text: 'What changed?',
      },
      {
        daemon_seq: 111,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:diag-counts',
        session_name: 'diag-counts',
        stream_id: 'alpha:diag-counts',
        timestamp: '2026-05-10T10:00:01.000Z',
        kind: 'TOOL',
        text: 'git status --short',
      },
      {
        daemon_seq: 112,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:diag-counts',
        session_name: 'diag-counts',
        stream_id: 'alpha:diag-counts',
        timestamp: '2026-05-10T10:00:02.000Z',
        kind: 'ASSIST',
        text: 'One file changed.',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:diag-counts',
        host: 'alpha',
        provider: 'codex',
        session_name: 'diag-counts',
        last_event_at: '2026-05-10T10:00:02.000Z',
        last_text: 'One file changed.',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  const full = selectSessionDetail(state, 'alpha:diag-counts', {
    includeTools: true,
    includeSystem: true,
    visibleCount: 'all',
    // The duplicate-sequence regression contract asserts CHAT_EVENT_RENDERED emission;
    // chat-core gating
    // makes emission opt-in, so this render-path call opts in.
    emitRenderTelemetry: true,
  });
  const visible = selectSessionDetail(state, 'alpha:diag-counts', { visibleCount: 'all' });
  expectPresent(full);
  expectPresent(visible);
  expect(seen.some((payload) => payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED)).toBe(true);

  // Each CHAT_EVENT_RENDERED must carry the
  // identifiers the scenario uses to correlate selector → row_rendered
  // mounts. `seq` correlates broadcast events, `optimistic_id` correlates
  // pre-reconcile optimistic rows. Selectors without either identifier
  // make this check non-actionable (cannot tell which row was
  // supposed to mount).
  const renderPayloads = seen.filter(
    (payload) => payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED,
  );
  expect(renderPayloads.length).toBeGreaterThan(0);
  for (const payload of renderPayloads) {
    expect(payload.data).toMatchObject({ stream_id: 'alpha:diag-counts' });
    expect('seq' in (payload.data as Record<string, unknown>)).toBe(true);
    expect('optimistic_id' in (payload.data as Record<string, unknown>)).toBe(true);
  }

  seen.length = 0;
  expect(diagSessionDetailCounts(state, 'alpha:diag-counts')).toEqual({
    rendered_full_count: full.transcriptItems.length,
    rendered_visible_count: visible.transcriptItems.length,
  });
  expect(seen.filter((payload) => payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED)).toHaveLength(0);
});

test('selectSessionDetail does not duplicate the final assistant output when it is already present in events', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 11,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-2',
        session_name: 'chat-2',
        stream_id: 'alpha:chat-2',
        timestamp: '2026-04-24T10:10:00.000Z',
        kind: 'ASSIST',
        text: 'Already visible final answer',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-2',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-2',
        last_event_at: '2026-04-24T10:10:00.000Z',
        last_text: 'Already visible final answer',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-2');
  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(1);
  expect(detail.transcriptItems[0]?.id).toBe('11');
  expect(detail.transcriptItems[0]?.text).toBe('Already visible final answer');
});

test('selectSessionDetail keeps consecutive assistant events as separate transcript rows', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 21,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-3',
        session_name: 'chat-3',
        stream_id: 'alpha:chat-3',
        timestamp: '2026-04-24T10:20:00.000Z',
        kind: 'ASSIST',
        text: 'Investigating the first subsystem',
      },
      {
        daemon_seq: 22,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-3',
        session_name: 'chat-3',
        stream_id: 'alpha:chat-3',
        timestamp: '2026-04-24T10:20:05.000Z',
        kind: 'ASSIST',
        text: 'Investigating the second subsystem',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-3',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-3',
        last_event_at: '2026-04-24T10:20:05.000Z',
        last_text: 'Investigating the second subsystem',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: true,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-3');
  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(2);
  expect(detail.transcriptItems[0]?.id).toBe('21');
  expect(detail.transcriptItems[1]?.id).toBe('22');
});

test('selectSessionDetail can render the full available transcript history', () => {
  const events = Array.from({ length: 150 }, (_, index) => ({
    daemon_seq: 200 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:long-history',
    session_name: 'long-history',
    stream_id: 'alpha:long-history',
    timestamp: `2026-04-24T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `message ${index}`,
  }));
  const state = buildState({
    events,
    sessions: [
      {
        stream_id: 'alpha:long-history',
        host: 'alpha',
        provider: 'codex',
        session_name: 'long-history',
        last_event_at: '2026-04-24T12:02:29.000Z',
        last_text: 'message 149',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:long-history', { visibleCount: 'all' });

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(150);
  expect(detail.remainingCount).toBe(0);
  expect(detail.transcriptItems[0]?.text).toBe('message 0');
  expect(detail.transcriptItems[149]?.text).toBe('message 149');
});

test('selectSessionDetail still supports bounded transcript windows', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    daemon_seq: 400 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:bounded-history',
    session_name: 'bounded-history',
    stream_id: 'alpha:bounded-history',
    timestamp: `2026-04-24T12:10:${String(index).padStart(2, '0')}.000Z`,
    kind: 'ASSIST',
    text: `bounded message ${index}`,
  }));
  const state = buildState({
    events,
    sessions: [
      {
        stream_id: 'alpha:bounded-history',
        host: 'alpha',
        provider: 'codex',
        session_name: 'bounded-history',
        last_event_at: '2026-04-24T12:10:19.000Z',
        last_text: 'bounded message 19',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:bounded-history', { visibleCount: 5 });

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(5);
  expect(detail.remainingCount).toBe(15);
  expect(detail.transcriptItems[0]?.text).toBe('bounded message 15');
  expect(detail.transcriptItems[4]?.text).toBe('bounded message 19');
});

test('selectSessionDetail only labels timestamps when the visible minute changes', () => {
  const events = [
    {
      daemon_seq: 430,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:timestamp-history',
      session_name: 'timestamp-history',
      stream_id: 'alpha:timestamp-history',
      timestamp: '2026-04-24T12:15:02.000Z',
      kind: 'USER',
      text: 'first minute user message',
    },
    {
      daemon_seq: 431,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:timestamp-history',
      session_name: 'timestamp-history',
      stream_id: 'alpha:timestamp-history',
      timestamp: '2026-04-24T12:15:42.000Z',
      kind: 'ASSIST',
      text: 'same minute assistant message',
    },
    {
      daemon_seq: 432,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:timestamp-history',
      session_name: 'timestamp-history',
      stream_id: 'alpha:timestamp-history',
      timestamp: '2026-04-24T12:16:01.000Z',
      kind: 'ASSIST',
      text: 'next minute assistant message',
    },
  ];
  const state = buildState({
    events,
    sessions: [
      {
        stream_id: 'alpha:timestamp-history',
        host: 'alpha',
        provider: 'codex',
        session_name: 'timestamp-history',
        last_event_at: '2026-04-24T12:16:01.000Z',
        last_text: 'next minute assistant message',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:timestamp-history');

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(3);
  expect(detail.transcriptItems[0]?.timestampLabel).not.toBe('');
  expect(detail.transcriptItems[1]?.timestampLabel).toBe('');
  expect(detail.transcriptItems[2]?.timestampLabel).not.toBe('');
});

test('selectSessionDetail collapses adjacent replay duplicate transcript rows by shared identity', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 31,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-4',
        session_name: 'chat-4',
        stream_id: 'alpha:chat-4',
        timestamp: '2026-04-24T10:30:00.000Z',
        kind: 'ASSIST',
        text: 'Repeated output',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-repeated-output-1' },
      },
      {
        daemon_seq: 32,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-4',
        session_name: 'chat-4',
        stream_id: 'alpha:chat-4',
        timestamp: '2026-04-24T10:30:01.000Z',
        kind: 'ASSIST',
        text: 'Repeated   output',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-repeated-output-1' },
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-4',
        host: 'alpha',
        provider: 'claude',
        session_name: 'chat-4',
        last_event_at: '2026-04-24T10:30:01.000Z',
        last_text: 'Repeated output',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-4');
  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(1);
  expect(detail.transcriptItems[0]?.id).toBe('31');
  expect(detail.transcriptItems[0]?.text).toBe('Repeated output');
});

test('selectSessionDetail collapses replayed duplicate rows across the visible window', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 51,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:50:00.000Z',
        kind: 'USER',
        text: 'What is the state of the 0DTE bot?',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-user-1' },
      },
      {
        daemon_seq: 52,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:50:01.000Z',
        kind: 'ASSIST',
        text: 'Checking live state now.',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-assist-1' },
      },
      {
        daemon_seq: 53,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:51:00.000Z',
        kind: 'TOOL_USE',
        text: 'Ran aws ec2 describe-instances',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-tool-1', tool_name: 'Bash' },
      },
      {
        daemon_seq: 54,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:52:00.000Z',
        kind: 'USER',
        text: 'What is the state of the 0DTE bot?',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-user-1' },
      },
      {
        daemon_seq: 55,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:52:01.000Z',
        kind: 'ASSIST',
        text: 'Checking live state now.',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-assist-1' },
      },
      {
        daemon_seq: 56,
        host: 'alpha',
        provider: 'claude',
        session_id: 'alpha:chat-6',
        session_name: 'chat-6',
        stream_id: 'alpha:chat-6',
        timestamp: '2026-04-24T10:53:00.000Z',
        kind: 'ASSIST',
        text: 'The EC2 instance is stopped.',
        raw: { source: 'claude-jsonl', jsonl_record_uuid: 'jsonl-state-final-1' },
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-6',
        host: 'alpha',
        provider: 'claude',
        session_name: 'chat-6',
        last_event_at: '2026-04-24T10:53:00.000Z',
        last_text: 'The EC2 instance is stopped.',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-6');
  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual([
    'What is the state of the 0DTE bot?',
    'Checking live state now.',
    'The EC2 instance is stopped.',
  ]);
});

test('selectSessionDetail keeps completed background terminal command rows when tool actions are shown', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 61,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-7',
        session_name: 'chat-7',
        stream_id: 'alpha:chat-7',
        timestamp: '2026-04-24T11:00:00.000Z',
        kind: 'ASSIST',
        text: 'Waited for background terminal',
      },
      {
        daemon_seq: 62,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-7',
        session_name: 'chat-7',
        stream_id: 'alpha:chat-7',
        timestamp: '2026-04-24T11:00:30.000Z',
        kind: 'ASSIST',
        text: 'Waited for background terminal · aws logs filter-log-events --log-group-name /0dte/trader/alpha',
      },
      {
        daemon_seq: 63,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-7',
        session_name: 'chat-7',
        stream_id: 'alpha:chat-7',
        timestamp: '2026-04-24T11:01:00.000Z',
        kind: 'ASSIST',
        text: 'Interpreting this as the latest 0DTE bot state.',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-7',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-7',
        last_event_at: '2026-04-24T11:01:00.000Z',
        last_text: 'Interpreting this as the latest 0DTE bot state.',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-7', { showToolActions: true });
  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual([
    'Waited for background terminal',
    'Waited for background terminal · aws logs filter-log-events --log-group-name /0dte/trader/alpha',
    'Interpreting this as the latest 0DTE bot state.',
  ]);
});

test('selectSessionDetail filters working status rows from externally-started sessions', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 81,
        host: 'gamma',
        provider: 'codex',
        session_id: 'gamma:chat-9',
        session_name: 'chat-9',
        stream_id: 'gamma:chat-9',
        timestamp: '2026-04-24T11:20:00.000Z',
        kind: 'ASSIST',
        text: 'Explored └ Read main.js, server.py, app.js ◦ Working (24s • esc to interrupt)',
      },
      {
        daemon_seq: 82,
        host: 'gamma',
        provider: 'codex',
        session_id: 'gamma:chat-9',
        session_name: 'chat-9',
        stream_id: 'gamma:chat-9',
        timestamp: '2026-04-24T11:21:00.000Z',
        kind: 'ASSIST',
        text: 'The existing rename endpoint renames the tmux session itself.',
      },
    ],
    sessions: [
      {
        stream_id: 'gamma:chat-9',
        host: 'gamma',
        provider: 'codex',
        session_name: 'chat-9',
        last_event_at: '2026-04-24T11:21:30.000Z',
        last_text: 'Read main.js ◦ Working (35s • esc to interrupt)',
        last_kind: 'TOOL',
        draft: '',
        pending: false,
        working: true,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'gamma:chat-9');
  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual([
    'The existing rename endpoint renames the tmux session itself.',
  ]);
});

test('selectSessionDetail keeps the fullest progressive user and assistant rows', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 71,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-8',
        session_name: 'chat-8',
        stream_id: 'alpha:chat-8',
        timestamp: '2026-04-24T11:10:00.000Z',
        kind: 'USER',
        text: 'and the top of the chat still says session instead',
      },
      {
        daemon_seq: 72,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-8',
        session_name: 'chat-8',
        stream_id: 'alpha:chat-8',
        timestamp: '2026-04-24T11:10:01.000Z',
        kind: 'USER',
        text: 'and the top of the chat still says session instead of the name of the machine',
      },
      {
        daemon_seq: 73,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-8',
        session_name: 'chat-8',
        stream_id: 'alpha:chat-8',
        timestamp: '2026-04-24T11:10:20.000Z',
        kind: 'ASSIST',
        text: 'Interpreting this as the state of the 0DTE bot. Current state: stopped.',
      },
      {
        daemon_seq: 74,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-8',
        session_name: 'chat-8',
        stream_id: 'alpha:chat-8',
        timestamp: '2026-04-24T11:10:40.000Z',
        kind: 'ASSIST',
        text: 'Interpreting this as the state of the 0DTE bot. Current state: stopped. Latest trading-day state was data-starved.',
      },
    ],
    sessions: [
      {
        stream_id: 'alpha:chat-8',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-8',
        last_event_at: '2026-04-24T11:10:40.000Z',
        last_text: 'Interpreting this as the state of the 0DTE bot. Current state: stopped. Latest trading-day state was data-starved.',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-8');
  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual([
    'and the top of the chat still says session instead of the name of the machine',
    'Interpreting this as the state of the 0DTE bot. Current state: stopped. Latest trading-day state was data-starved.',
  ]);
});

test('selectSessionDetail keeps draft display separate from transcript rows', () => {
  const state = buildState({
    events: [
      {
        daemon_seq: 41,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-5',
        session_name: 'chat-5',
        stream_id: 'alpha:chat-5',
        timestamp: '2026-04-24T10:40:00.000Z',
        kind: 'ASSIST',
        text: 'Committed output',
      },
      {
        daemon_seq: 42,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-5',
        session_name: 'chat-5',
        stream_id: 'alpha:chat-5',
        timestamp: '2026-04-24T10:40:01.000Z',
        kind: 'DRAFT',
        text: 'Uncommitted draft',
        raw: { working: true, working_label: 'running tests' },
      },
    ],
    drafts: {
      'alpha:chat-5': {
        daemon_seq: 42,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-5',
        session_name: 'chat-5',
        stream_id: 'alpha:chat-5',
        timestamp: '2026-04-24T10:40:01.000Z',
        kind: 'DRAFT',
        text: 'Uncommitted draft',
        raw: { working: true, working_label: 'running tests' },
      },
    },
    sessions: [
      {
        stream_id: 'alpha:chat-5',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-5',
        last_event_at: '2026-04-24T10:40:00.000Z',
        last_text: 'Committed output',
        last_kind: 'ASSIST',
        draft: 'Uncommitted draft',
        pending: false,
        working: true,
        working_label: 'running tests',
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-5');
  expectPresent(detail);
  expect(detail.status).toBe('working');
  expect(detail.workingLabel).toBe('running tests');
  expect(detail.draftText).toBe('Uncommitted draft');
  expect(detail.transcriptItems.map((item) => item.text)).toEqual(['Committed output']);
});

test('selectSessionDetail can ignore desktop draft ticks for stable open-chat rendering', () => {
  const baseSession = {
    stream_id: 'alpha:chat-draft-stability',
    host: 'alpha',
    provider: 'codex',
    session_name: 'chat-draft-stability',
    last_event_at: '2026-04-24T10:55:00.000Z',
    last_text: 'Committed output',
    last_kind: 'ASSIST',
    draft: 'a',
    pending: false,
    working: true,
    working_label: 'editing prompt',
    online: true,
  };
  const committedEvent = {
    daemon_seq: 91,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:chat-draft-stability',
    session_name: 'chat-draft-stability',
    stream_id: 'alpha:chat-draft-stability',
    timestamp: '2026-04-24T10:55:00.000Z',
    kind: 'ASSIST',
    text: 'Committed output',
  };
  const first = buildState({
    events: [committedEvent],
    drafts: {
      'alpha:chat-draft-stability': {
        ...committedEvent,
        daemon_seq: 92,
        timestamp: '2026-04-24T10:55:01.000Z',
        kind: 'DRAFT',
        text: 'a',
        raw: { working: true, working_label: 'editing prompt' },
      },
    },
    sessions: [baseSession],
  });
  const second = buildState({
    events: [committedEvent],
    drafts: {
      'alpha:chat-draft-stability': {
        ...committedEvent,
        daemon_seq: 93,
        timestamp: '2026-04-24T10:55:02.000Z',
        kind: 'DRAFT',
        text: 'abc',
        raw: { working: true, working_label: 'editing prompt' },
      },
    },
    sessions: [{ ...baseSession, draft: 'abc' }],
  });

  const detailOne = selectSessionDetail(first, 'alpha:chat-draft-stability', { includeDraft: false });
  const detailTwo = selectSessionDetail(second, 'alpha:chat-draft-stability', { includeDraft: false });

  expectPresent(detailOne);
  expect(detailOne).toBe(detailTwo);
  expect(detailOne.draftText).toBe('');
  expect(detailOne.transcriptItems.map((item) => item.text)).toEqual(['Committed output']);
});

test('selectSessionDetail still uses draft working state when draft text is hidden', () => {
  const state = buildState({
    drafts: {
      'alpha:chat-working-draft': {
        daemon_seq: 94,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-working-draft',
        session_name: 'chat-working-draft',
        stream_id: 'alpha:chat-working-draft',
        timestamp: '2026-04-24T10:56:01.000Z',
        kind: 'DRAFT',
        text: 'changing draft text',
        raw: { working: true, working_label: '42s' },
      },
    },
    sessions: [
      {
        stream_id: 'alpha:chat-working-draft',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-working-draft',
        last_event_at: '2026-04-24T10:56:00.000Z',
        last_text: 'Committed output',
        last_kind: 'ASSIST',
        draft: 'changing draft text',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, 'alpha:chat-working-draft', { includeDraft: false });

  expectPresent(detail);
  expect(detail.status).toBe('working');
  expect(detail.workingLabel).toBe('42s');
  expect(detail.draftText).toBe('');
});

test('selectMachineStatusList preserves unknown host ids without legacy aliasing', () => {
  const machines = selectMachineStatusList(buildState({
    sessions: [
      {
        stream_id: 'legacy:codex-legacy-1',
        host: 'legacy',
        provider: 'codex',
        session_name: 'codex-legacy-1',
        last_event_at: '2026-04-24T11:05:00.000Z',
        last_text: 'hello',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  }));

  const legacy = machines.find((machine) => machine.host === 'legacy');
  expect(legacy?.online).toBe(true);
  expect(legacy?.sessionCount).toBe(1);
  expect(legacy?.title).toBe('Legacy');
});

test('selectSessionDetail renders Claude JSONL user, assistant, thinking, and Bash tool rows', () => {
  const events = [
    claudeFixture('claude-jsonl-user-message'),
    claudeFixture('claude-jsonl-assistant-text'),
    claudeFixture('claude-jsonl-thinking'),
    claudeFixture('claude-jsonl-tool-use-bash'),
  ];
  const detail = selectSessionDetail(stateForClaudeEvents(events), 'beta:claude-jsonl-fixture', {
    includeTools: true,
  });

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.kind)).toEqual(['USER', 'ASSIST_TEXT', 'THINKING', 'TOOL_USE']);
  expect(detail.transcriptItems.map((item) => item.displayRule)).toEqual(['bubble:user', 'bubble:assistant', 'activity:thinking', 'activity:command']);
});

test('Case A: Claude interrupt marker preserves the sent user message in transcript', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([
    {
      daemon_seq: 301,
      host: 'beta',
      provider: 'claude',
      session_id: 'beta:claude-jsonl-fixture',
      session_name: 'claude-jsonl-fixture',
      stream_id: 'beta:claude-jsonl-fixture',
      timestamp: '2026-06-18T10:35:30.000Z',
      kind: 'USER',
      text: 'can you help me understand the migration plan?',
      raw: { source: 'claude-jsonl', type: 'user', uuid: 'user-request-1' },
    },
    {
      daemon_seq: 302,
      host: 'beta',
      provider: 'claude',
      session_id: 'beta:claude-jsonl-fixture',
      session_name: 'claude-jsonl-fixture',
      stream_id: 'beta:claude-jsonl-fixture',
      timestamp: '2026-06-18T10:35:38.000Z',
      kind: 'USER',
      text: '[Request interrupted by user]',
      raw: {
        source: 'claude-jsonl',
        type: 'user',
        uuid: 'interrupt-marker-1',
        interruptedMessageId: 'msg_assistant_1',
      },
    },
  ]), 'beta:claude-jsonl-fixture', { visibleCount: 'all' });

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual([
    'can you help me understand the migration plan?',
    '[Request interrupted by user]',
  ]);
  expect(detail.transcriptItems.map((item) => item.displayRule)).toEqual(['bubble:user', 'bubble:user']);
});

test('selectSessionDetail hides structured Claude JSONL tool rows in the default transcript', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([
    claudeFixture('claude-jsonl-tool-use-bash'),
  ], {
    last_text: '',
    last_kind: '',
  }), 'beta:claude-jsonl-fixture');

  expectPresent(detail);
  expect(detail.transcriptItems).toHaveLength(0);
});

test('selectSessionDetail propagates transcript provider and source for normal events', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([
    claudeFixture('claude-jsonl-tool-use-bash'),
  ]), 'beta:claude-jsonl-fixture', { showToolActions: true });

  expectPresent(detail);
  expect(detail.transcriptItems[0]?.provider).toBe('claude');
  expect(detail.transcriptItems[0]?.source).toBe('claude-jsonl');
});

test('selectSessionDetail transcript reuse includes provider and source', () => {
  const baseEvent = {
    daemon_seq: 2401,
    host: 'beta',
    provider: 'claude',
    session_id: 'beta:source-equality',
    session_name: 'source-equality',
    stream_id: 'beta:source-equality',
    timestamp: '2026-05-01T12:00:00.000Z',
    kind: 'SYSTEM',
    text: 'Runtime notice',
    raw: { source: 'tmux-pane' },
  };
  const session = {
    stream_id: 'beta:source-equality',
    host: 'beta',
    provider: 'claude',
    session_name: 'source-equality',
    last_event_at: baseEvent.timestamp,
    last_text: baseEvent.text,
    last_kind: baseEvent.kind,
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
  const first = selectSessionDetail(buildState({ events: [baseEvent], sessions: [session] }), 'beta:source-equality', { visibleCount: 'all', includeSystem: true });
  const secondEvent = {
    ...baseEvent,
    raw: { source: 'claude-jsonl' },
  };
  const second = selectSessionDetail(buildState({ events: [secondEvent], sessions: [session] }), 'beta:source-equality', { visibleCount: 'all', includeSystem: true });

  expectPresent(first);
  expectPresent(second);
  expect(first.transcriptItems[0]?.source).toBe('tmux-pane');
  expect(second.transcriptItems[0]?.source).toBe('claude-jsonl');
  expect(first.transcriptItems[0]).not.toBe(second.transcriptItems[0]);
});

test('selectSessionDetail propagates provider/source and cleaning for fallback transcript items', () => {
  const state = buildState({
    sessions: [
      {
        stream_id: 'beta:summary-only',
        host: 'beta',
        provider: 'claude',
        session_name: 'summary-only',
        last_event_at: '2026-05-01T12:10:00.000Z',
        last_text: 'Searched for 1 pattern (ctrl+o to expand).',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });
  const detail = selectSessionDetail(state, 'beta:summary-only');

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(1);
  expect(detail.transcriptItems[0]?.id).toBe('fallback:beta:summary-only');
  expect(detail.transcriptItems[0]?.provider).toBe('claude');
  expect(detail.transcriptItems[0]?.source).toBe('');
  expect(detail.transcriptItems[0]?.text).toBe('Searched for 1 pattern');
});

test('selectSessionDetail maps Claude JSONL Read tool results to code-block rows', () => {
  const events = [
    {
      ...claudeFixture('claude-jsonl-tool-use-bash'),
      daemon_seq: 1201,
      kind: 'TOOL_USE',
      text: 'Read /workspace/docs/example-project.md',
      raw: {
        ...claudeFixture('claude-jsonl-tool-use-bash').raw,
        tool_use_id: claudeFixture('claude-jsonl-tool-result-read').raw.tool_use_id,
        tool_name: 'Read',
      },
    },
    claudeFixture('claude-jsonl-tool-result-read'),
  ];
  const detail = selectSessionDetail(stateForClaudeEvents(events), 'beta:claude-jsonl-fixture', {
    includeTools: true,
  });

  expectPresent(detail);
  expect(detail.transcriptItems.at(-1)?.displayRule).toBe('activity:code-block');
  expect(detail.transcriptItems.at(-1)?.text || '').toMatch(/^1\t---/);
});

test('selectSessionDetail pairs Claude JSONL TOOL_RESULT rows with TOOL_USE input', () => {
  const toolUse = {
    ...claudeFixture('claude-jsonl-tool-use-bash'),
    daemon_seq: 1221,
    kind: 'TOOL_USE',
    text: 'Write /tmp/synthetic-prompt.txt',
    raw: {
      ...claudeFixture('claude-jsonl-tool-use-bash').raw,
      tool_use_id: 'toolu_write_pairing',
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/synthetic-prompt.txt',
        content: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
      },
    },
  };
  const toolResult = {
    ...claudeFixture('claude-jsonl-tool-result-read'),
    daemon_seq: 1222,
    kind: 'TOOL_RESULT',
    text: 'File written successfully',
    raw: {
      source: 'claude-jsonl',
      tool_use_id: 'toolu_write_pairing',
      tool_content: 'File written successfully',
      is_error: false,
      cwd: '/workspace',
    },
  };
  const detail = selectSessionDetail(stateForClaudeEvents([toolUse, toolResult]), 'beta:claude-jsonl-fixture', {
    includeTools: true,
    visibleCount: 'all',
  });

  expectPresent(detail);
  const resultRow = detail.transcriptItems.find((item) => item.id === '1222');
  expect(resultRow?.displayRule).toBe('activity:tool-output');
  expect(resultRow?.text).toBe('Wrote 40 lines to ../tmp/synthetic-prompt.txt');
});

test('selectSessionDetail preserves Claude JSONL fenced assistant text for screen code parsing', () => {
  const event = claudeFixture('claude-jsonl-codeblock-text');
  const detail = selectSessionDetail(stateForClaudeEvents([event]), 'beta:claude-jsonl-fixture');

  expectPresent(detail);
  expect(detail.transcriptItems[0]?.kind).toBe('ASSIST_TEXT');
  expect(detail.transcriptItems[0]?.text || '').toMatch(/```/);
});

test('selectSessionDetail keeps Claude JSONL turn summaries when tool actions are shown', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([
    {
      ...claudeFixture('claude-jsonl-assistant-text'),
      daemon_seq: 1301,
      kind: 'SYSTEM',
      text: 'Worked for 4m 52s · 53 msgs',
      raw: {
        source: 'claude-jsonl',
        subtype: 'turn-summary',
      },
    },
  ]), 'beta:claude-jsonl-fixture', { showToolActions: true });

  expectPresent(detail);
  expect(detail.transcriptItems[0]?.displayRule).toBe('activity:turn-summary');
  expect(detail.transcriptItems[0]?.text).toBe('Worked for 4m 52s · 53 msgs');
});

test('selectSessionDetail collapses Claude JSONL Agent tool rows with child count', () => {
  const scenario = claudeScenario('claude-jsonl-explore-grouping');
  const detail = selectSessionDetail(buildState({
    events: scenario.events,
    sessions: [scenario.session],
  }), 'beta:claude-jsonl-fixture', {
    includeTools: true,
  });

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(1);
  expect(detail.transcriptItems[0]?.displayRule).toBe('activity:collapsed-tool');
  expect(detail.transcriptItems[0]?.text || '').toMatch(/1 child event/);
});

test('selectSessionDetail exposes Claude JSONL working labels from session state', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([claudeFixture('claude-jsonl-assistant-text')], {
    working: true,
    working_label: 'Bash',
  }), 'beta:claude-jsonl-fixture');

  expectPresent(detail);
  expect(detail.status).toBe('working');
  expect(detail.workingLabel).toBe('Bash');
});

test('selectSessionDetail preserves full Claude JSONL live working labels', () => {
  const detail = selectSessionDetail(stateForClaudeEvents([claudeFixture('claude-jsonl-assistant-text')], {
    working: true,
    working_label: 'Herding… (3m 49s · ↓ 15.1k tokens · thought for 1s)',
  }), 'beta:claude-jsonl-fixture');

  expectPresent(detail);
  expect(detail.workingLabel).toBe('Herding… (3m 49s · ↓ 15.1k tokens · thought for 1s)');
});

test('selectSessionDetail shows no transcript rows for Claude JSONL no-draft scenario', () => {
  const scenario = claudeScenario('claude-jsonl-no-draft-echo');
  const detail = selectSessionDetail(buildState({
    events: scenario.events,
    sessions: [scenario.session],
  }), 'beta:claude-jsonl-fixture');

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(0);
  expect(detail.draftText).toBe('');
});

test('selectMachineStatsTabs returns Host A first with status and desktop-style stats', () => {
  const tabs = selectMachineStatsTabs(buildState({
    hosts: {
      hosta: {
        host: 'hosta',
        online: true,
        checked_at: '2026-04-28T10:00:00.000Z',
        session_count: 2,
      },
      hostb: {
        host: 'hostb',
        online: false,
        checked_at: '2026-04-28T10:00:00.000Z',
        session_count: 0,
        error: 'ssh offline',
      },
    },
    machineStats: {
      hosta: {
        host: 'hosta',
        cpu_load_1m: 1.2,
        memory_used_bytes: 8_000_000,
        memory_total_bytes: 16_000_000,
        disk_used_bytes: 100_000_000,
        disk_total_bytes: 200_000_000,
        uptime_seconds: 4 * 86400,
        sampled_at: '2026-04-28T10:00:00.000Z',
      },
    },
  }));

  expect(tabs[0]?.host).toBe('hosta');
  expect(tabs[0]?.title).toBe('Host A');
  expect(tabs[0]?.online).toBe(true);
  expect(tabs[0]?.stats?.cpu_load_1m).toBe(1.2);
  expect(tabs[1]?.host).toBe('hostb');
  expect(tabs[1]?.online).toBe(false);
  expect(tabs[2]?.host).toBe('hostc');
});

test('selectMachineStatsTabs preserves offline host status fields', () => {
  const tabs = selectMachineStatsTabs(buildState({
    hosts: {
      hosta: {
        host: 'hosta',
        online: false,
        checked_at: '2026-07-06T14:00:00.000Z',
        session_count: 0,
        host_status_reason: 'unreachable',
        host_status_since: '2026-07-06T13:30:00.000Z',
      },
    },
  }));

  expect(tabs[0]?.host).toBe('hosta');
  expect(tabs[0]?.hostStatusReason).toBe('unreachable');
  expect(tabs[0]?.hostStatusSince).toBe('2026-07-06T13:30:00.000Z');
});

test('selectChatList preserves unknown host ids for send actions', () => {
  const chats = selectChatList(buildState({
    sessions: [
      {
        stream_id: 'legacy:codex-legacy-1',
        host: 'legacy',
        provider: 'codex',
        session_name: 'codex-legacy-1',
        last_event_at: '2026-04-24T11:05:00.000Z',
        last_text: 'hello',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  }));

  expect(chats[0]?.host).toBe('legacy');
  expect(chats[0]?.hostTitle).toBe('Legacy');
});

test('selectChatList preserves session offline host status fields', () => {
  const chats = selectChatList(buildState({
    sessions: [
      {
        stream_id: 'hostc:offline-agent',
        host: 'hostc',
        provider: 'codex',
        session_name: 'offline-agent',
        last_event_at: '2026-07-06T13:45:00.000Z',
        last_text: 'waiting',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: false,
        host_status: 'offline',
        host_status_reason: 'unreachable',
        host_status_since: '2026-07-06T13:30:00.000Z',
      },
    ],
  }));

  expect(chats[0]?.hostStatus).toBe('offline');
  expect(chats[0]?.hostStatusReason).toBe('unreachable');
  expect(chats[0]?.hostStatusSince).toBe('2026-07-06T13:30:00.000Z');
});

test('selectChatList does not use tmux draft text as the chat preview', () => {
  const state = buildState({
    drafts: {
      'alpha:chat-preview': {
        daemon_seq: 101,
        host: 'alpha',
        provider: 'codex',
        session_id: 'alpha:chat-preview',
        session_name: 'chat-preview',
        stream_id: 'alpha:chat-preview',
        timestamp: '2026-04-24T11:00:01.000Z',
        kind: 'DRAFT',
        text: 'half typed desktop input',
      },
    },
    sessions: [
      {
        stream_id: 'alpha:chat-preview',
        host: 'alpha',
        provider: 'codex',
        session_name: 'chat-preview',
        last_event_at: '2026-04-24T11:00:00.000Z',
        last_text: 'Last committed answer',
        last_kind: 'ASSIST',
        draft: 'half typed desktop input',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const chats = selectChatList(state);

  expect(chats[0]?.previewText).toBe('Last committed answer');
  expect(chats[0]?.draft).toBe('');
});

test('selectChatList preview matches latest Session-displayed row when newest event is a tool call', () => {
  const streamId = 'hostc:claude-tool-preview';
  const state = buildState({
    events: [
      {
        daemon_seq: 10,
        host: 'hostc',
        provider: 'claude',
        session_id: streamId,
        session_name: 'claude-tool-preview',
        stream_id: streamId,
        timestamp: '2026-07-05T14:00:00.000Z',
        kind: 'USER',
        text: 'Please inspect the billing sync.',
      },
      {
        daemon_seq: 11,
        host: 'hostc',
        provider: 'claude',
        session_id: streamId,
        session_name: 'claude-tool-preview',
        stream_id: streamId,
        timestamp: '2026-07-05T14:00:05.000Z',
        kind: 'TOOL_USE',
        text: 'Bash\nrg -n billing src',
      },
    ],
    sessions: [
      {
        stream_id: streamId,
        host: 'hostc',
        provider: 'claude',
        session_name: 'claude-tool-preview',
        last_event_at: '2026-07-05T14:00:05.000Z',
        last_text: 'Bash\nrg -n billing src',
        last_kind: 'TOOL_USE',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const detail = selectSessionDetail(state, streamId, { includeTools: false, visibleCount: 'all' });
  const sessionLatest = detail?.transcriptItems.at(-1)?.text;

  expect(sessionLatest).toBe('Please inspect the billing sync.');
  expect(selectChatList(state)[0]?.previewText).toBe(sessionLatest);
});

test('selectors prefer websocket display_name over raw tmux session name', () => {
  const state = buildState({
    sessions: [
      {
        stream_id: 'alpha:codex-20260426-abc',
        host: 'alpha',
        provider: 'codex',
        session_name: 'codex-20260426-abc',
        display_name: 'Pentacle chat Data source',
        last_event_at: '2026-04-24T11:05:00.000Z',
        last_text: 'Committed answer',
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });

  const chats = selectChatList(state);
  const detail = selectSessionDetail(state, 'alpha:codex-20260426-abc', { includeDraft: false });

  expect(chats[0]?.sessionName).toBe('codex-20260426-abc');
  expect(chats[0]?.title).toBe('Pentacle chat Data source');
  expect(detail?.title).toBe('Pentacle chat Data source');
});

test('selectSessionDetail caches interpretPentacleEvent results by event reference', () => {
  const baseEvents = [
    {
      daemon_seq: 501,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:cache-1',
      session_name: 'cache-1',
      stream_id: 'alpha:cache-1',
      timestamp: '2026-04-29T12:00:00.000Z',
      kind: 'USER',
      text: 'first message',
    },
    {
      daemon_seq: 502,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:cache-1',
      session_name: 'cache-1',
      stream_id: 'alpha:cache-1',
      timestamp: '2026-04-29T12:00:01.000Z',
      kind: 'ASSIST',
      text: 'first reply',
    },
    {
      daemon_seq: 503,
      host: 'alpha',
      provider: 'codex',
      session_id: 'alpha:cache-1',
      session_name: 'cache-1',
      stream_id: 'alpha:cache-1',
      timestamp: '2026-04-29T12:00:02.000Z',
      kind: 'USER',
      text: 'second message',
    },
  ];
  const session = {
    stream_id: 'alpha:cache-1',
    host: 'alpha',
    provider: 'codex',
    session_name: 'cache-1',
    last_event_at: '2026-04-29T12:00:02.000Z',
    last_text: 'second message',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  __resetInterpretMissCountForTests();

  const stateOne = buildState({ events: baseEvents, sessions: [session] });
  selectSessionDetail(stateOne, 'alpha:cache-1', { visibleCount: 'all' });
  const afterFirst = __getInterpretMissCountForTests();
  expect(afterFirst).toBe(3);

  const stateTwo = buildState({ events: baseEvents, sessions: [session] });
  selectSessionDetail(stateTwo, 'alpha:cache-1', { visibleCount: 1 });
  const afterSecond = __getInterpretMissCountForTests();
  expect(afterSecond).toBe(afterFirst);

  const newEvent = {
    daemon_seq: 504,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:cache-1',
    session_name: 'cache-1',
    stream_id: 'alpha:cache-1',
    timestamp: '2026-04-29T12:00:03.000Z',
    kind: 'ASSIST',
    text: 'second reply',
  };
  const stateThree = buildState({
    events: [...baseEvents, newEvent],
    sessions: [{ ...session, last_event_at: newEvent.timestamp, last_text: newEvent.text, last_kind: 'ASSIST' }],
  });
  selectSessionDetail(stateThree, 'alpha:cache-1', { visibleCount: 'all' });
  const afterThird = __getInterpretMissCountForTests();
  expect(afterThird - afterSecond).toBe(1);
});

test('selectSessionDetail interprets each held event once for exact large-chat counts', () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    daemon_seq: 1000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:large-budget',
    session_name: 'large-budget',
    stream_id: 'alpha:large-budget',
    timestamp: `2026-04-29T13:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `large budget message ${index}`,
  }));
  const session = {
    stream_id: 'alpha:large-budget',
    host: 'alpha',
    provider: 'codex',
    session_name: 'large-budget',
    last_event_at: '2026-04-29T13:08:19.000Z',
    last_text: 'large budget message 499',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  __resetInterpretMissCountForTests();

  selectSessionDetail(buildState({ events, sessions: [session] }), 'alpha:large-budget', { visibleCount: 8 });

  expect(__getInterpretMissCountForTests()).toBe(events.length);
});

test('selectSessionDetail reuses interpretation when widening the exact transcript window', () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    daemon_seq: 2000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:load-earlier-window',
    session_name: 'load-earlier-window',
    stream_id: 'alpha:load-earlier-window',
    timestamp: `2026-04-29T14:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `load earlier message ${index}`,
  }));
  const session = {
    stream_id: 'alpha:load-earlier-window',
    host: 'alpha',
    provider: 'codex',
    session_name: 'load-earlier-window',
    last_event_at: '2026-04-29T14:08:19.000Z',
    last_text: 'load earlier message 499',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
  const state = buildState({ events, sessions: [session] });

  __resetInterpretMissCountForTests();

  selectSessionDetail(state, 'alpha:load-earlier-window', { visibleCount: 8 });
  const afterInitialWindow = __getInterpretMissCountForTests();
  selectSessionDetail(state, 'alpha:load-earlier-window', { visibleCount: 32 });
  const missDelta = __getInterpretMissCountForTests() - afterInitialWindow;

  expect(afterInitialWindow).toBe(events.length);
  expect(missDelta).toBe(0);
});

test('selectSessionDetail remainingCount includes out-of-window events', () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    daemon_seq: 3000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:remaining-window',
    session_name: 'remaining-window',
    stream_id: 'alpha:remaining-window',
    timestamp: `2026-04-29T15:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `remaining window message ${index}`,
  }));
  const session = {
    stream_id: 'alpha:remaining-window',
    host: 'alpha',
    provider: 'codex',
    session_name: 'remaining-window',
    last_event_at: '2026-04-29T15:03:19.000Z',
    last_text: 'remaining window message 199',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  __resetInterpretMissCountForTests();

  const detail = selectSessionDetail(buildState({ events, sessions: [session] }), 'alpha:remaining-window', { visibleCount: 8 });

  expectPresent(detail);
  expect(detail.remainingCount > 0).toBeTruthy();
  expect(detail.remainingCount >= 136).toBeTruthy();
});

test('selectSessionDetail remainingCount excludes hidden rows outside the visible window', () => {
  const streamId = 'alpha:exact-remaining-window';
  const visibleEvents = Array.from({ length: 8 }, (_, index) => ({
    daemon_seq: 6000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: streamId,
    session_name: 'exact-remaining-window',
    stream_id: streamId,
    timestamp: `2026-04-29T15:00:${String(index).padStart(2, '0')}.000Z`,
    kind: 'ASSIST',
    text: `visible message ${index}`,
  }));
  const hiddenEvents = Array.from({ length: 40 }, (_, index) => ({
    daemon_seq: 5900 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: streamId,
    session_name: 'exact-remaining-window',
    stream_id: streamId,
    timestamp: `2026-04-29T14:59:${String(index).padStart(2, '0')}.000Z`,
    kind: 'SYSTEM',
    text: `hidden system row ${index}`,
  }));
  const session = {
    stream_id: streamId,
    host: 'alpha',
    provider: 'codex',
    session_name: 'exact-remaining-window',
    last_event_at: '2026-04-29T15:00:07.000Z',
    last_text: 'visible message 7',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  const detail = selectSessionDetail(
    buildState({ events: [...hiddenEvents, ...visibleEvents], sessions: [session] }),
    streamId,
    { visibleCount: 8 },
  );

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual(visibleEvents.map((event) => event.text));
  expect(detail.remainingCount).toBe(0);
});

test('selectSessionDetail remainingCount applies filtering and coalescing before counting', () => {
  const streamId = 'alpha:coalesced-remaining-window';
  const event = (daemon_seq: number, kind: string, text: string, raw: Record<string, unknown> = {}) => ({
    daemon_seq,
    host: 'alpha',
    provider: 'claude',
    session_id: streamId,
    session_name: 'coalesced-remaining-window',
    stream_id: streamId,
    timestamp: `2026-04-29T14:58:${String(daemon_seq).padStart(2, '0')}.000Z`,
    kind,
    text,
    raw,
  });
  const olderCandidates = [
    event(1, 'ASSIST', 'replayed answer', { source: 'claude-jsonl', jsonl_record_uuid: 'same-answer' }),
    event(2, 'ASSIST', 'replayed   answer', { source: 'claude-jsonl', jsonl_record_uuid: 'same-answer' }),
    event(3, 'USER', 'progressive question with enough initial text to qualify for coalescing'),
    event(4, 'USER', 'progressive question with enough initial text to qualify for coalescing and the complete suffix'),
    event(5, 'TOOL_USE', 'hidden tool call'),
    event(6, 'SYSTEM', 'hidden system row'),
  ];
  const visibleEvents = Array.from({ length: 8 }, (_, index) => event(
    20 + index,
    index % 2 === 0 ? 'USER' : 'ASSIST',
    `visible row ${index}`,
  ));
  const session = {
    stream_id: streamId,
    host: 'alpha',
    provider: 'claude',
    session_name: 'coalesced-remaining-window',
    last_event_at: visibleEvents.at(-1)?.timestamp,
    last_text: visibleEvents.at(-1)?.text,
    last_kind: visibleEvents.at(-1)?.kind,
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  const detail = selectSessionDetail(
    buildState({ events: [...olderCandidates, ...visibleEvents], sessions: [session] }),
    streamId,
    { visibleCount: 8 },
  );

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual(visibleEvents.map((item) => item.text));
  expect(detail.remainingCount).toBe(2);
});

test('selectSessionDetail visibleCount all still renders all qualifying events', () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    daemon_seq: 4000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:all-window',
    session_name: 'all-window',
    stream_id: 'alpha:all-window',
    timestamp: `2026-04-29T16:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `all window message ${index}`,
  }));
  const session = {
    stream_id: 'alpha:all-window',
    host: 'alpha',
    provider: 'codex',
    session_name: 'all-window',
    last_event_at: '2026-04-29T16:08:19.000Z',
    last_text: 'all window message 499',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  __resetInterpretMissCountForTests();

  const detail = selectSessionDetail(buildState({ events, sessions: [session] }), 'alpha:all-window', { visibleCount: 'all' });

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(500);
  expect(detail.remainingCount).toBe(0);
});

test('selectSessionDetail visibleCount zero returns zero transcript rows', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    daemon_seq: 5000 + index,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:zero-window',
    session_name: 'zero-window',
    stream_id: 'alpha:zero-window',
    timestamp: `2026-04-29T17:00:${String(index).padStart(2, '0')}.000Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `zero window message ${index}`,
  }));
  const session = {
    stream_id: 'alpha:zero-window',
    host: 'alpha',
    provider: 'codex',
    session_name: 'zero-window',
    last_event_at: '2026-04-29T17:00:09.000Z',
    last_text: '',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  __resetInterpretMissCountForTests();

  const detail = selectSessionDetail(buildState({ events, sessions: [session] }), 'alpha:zero-window', { visibleCount: 0 });

  expectPresent(detail);
  expect(detail.transcriptItems.length).toBe(0);
  expect(detail.remainingCount).toBe(10);
});

function decisionEvent(overrides: Partial<any>) {
  return {
    daemon_seq: 9000,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:decision-table',
    session_name: 'decision-table',
    stream_id: 'alpha:decision-table',
    timestamp: '2026-05-13T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'decision row',
    ...overrides,
  };
}

function stateForDecisionEvents(events: any[], streamId = 'alpha:decision-table') {
  return buildState({
    events: events.map((event, index) => ({
      ...event,
      daemon_seq: event.daemon_seq ?? 9000 + index,
      session_id: streamId,
      session_name: streamId.split(':').at(-1) || 'decision-table',
      stream_id: streamId,
    })),
    sessions: [
      {
        stream_id: streamId,
        host: 'alpha',
        provider: 'codex',
        session_name: streamId.split(':').at(-1) || 'decision-table',
        last_event_at: events.at(-1)?.timestamp || '2026-05-13T10:00:00.000Z',
        last_text: '',
        last_kind: '',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
  });
}

describe('showToolActions decision table', () => {
  const cases = [
    {
      name: 'user bubble',
      event: decisionEvent({ kind: 'USER', text: 'hello from the user' }),
      hiddenRules: ['bubble:user'],
      shownRules: ['bubble:user'],
    },
    {
      name: 'assistant bubble',
      event: decisionEvent({ kind: 'ASSIST', text: 'hello from the assistant' }),
      hiddenRules: ['bubble:assistant'],
      shownRules: ['bubble:assistant'],
    },
    {
      name: 'tool command',
      event: decisionEvent({ kind: 'TOOL', text: 'Bash npm test' }),
      hiddenRules: [],
      shownRules: ['activity:command'],
    },
    {
      name: 'tool output',
      event: decisionEvent({ kind: 'TOOL-OUT', text: 'test output' }),
      hiddenRules: [],
      shownRules: ['activity:tool-output'],
    },
    {
      name: 'tool batch summary',
      event: decisionEvent({
        kind: 'TOOL_BATCH_SUMMARY',
        provider: 'claude',
        text: 'Ran 2 tools',
        raw: { source: 'claude-jsonl' },
      }),
      hiddenRules: [],
      shownRules: ['activity:tool-batch'],
    },
    {
      name: 'explore action',
      event: decisionEvent({ kind: 'TOOL', text: 'Read src/App.tsx' }),
      hiddenRules: [],
      shownRules: ['activity:explored'],
    },
    {
      name: 'file change',
      event: decisionEvent({ kind: 'TOOL', text: 'Edit src/App.tsx' }),
      hiddenRules: [],
      shownRules: ['activity:file-change'],
    },
    {
      name: 'code block',
      event: decisionEvent({
        kind: 'TOOL_RESULT',
        provider: 'claude',
        text: '1\tconst value = true;',
        raw: { source: 'claude-jsonl', tool_name: 'Read', tool_use_id: 'toolu_read_decision' },
      }),
      hiddenRules: [],
      shownRules: ['activity:code-block'],
    },
    {
      name: 'thinking',
      event: decisionEvent({ kind: 'THINK', text: 'Thinking about the answer' }),
      hiddenRules: [],
      shownRules: ['activity:thinking'],
    },
    {
      name: 'structured Claude tool',
      event: decisionEvent({
        kind: 'TOOL_USE',
        provider: 'claude',
        text: 'Bash(ls)',
        raw: {
          source: 'claude-jsonl',
          tool_name: 'Bash',
          tool_use_id: 'toolu_structured_decision',
        },
      }),
      hiddenRules: [],
      shownRules: ['activity:command'],
    },
    {
      name: 'turn summary non-empty',
      event: decisionEvent({
        kind: 'SYSTEM',
        provider: 'claude',
        text: 'Worked for 1m 02s',
        raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
      }),
      hiddenRules: [],
      shownRules: [],
    },
    {
      name: 'turn summary empty',
      event: decisionEvent({
        kind: 'SYSTEM',
        provider: 'claude',
        text: '   ',
        raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
      }),
      hiddenRules: [],
      shownRules: [],
    },
    {
      name: 'terminal divider non-empty',
      event: decisionEvent({ kind: 'SYSTEM', text: 'Worked for 2m 10s' }),
      hiddenRules: [],
      shownRules: [],
    },
    {
      name: 'terminal divider empty',
      event: decisionEvent({ kind: 'SYSTEM', text: '----------' }),
      hiddenRules: [],
      shownRules: [],
    },
    {
      name: 'system compacted',
      event: decisionEvent({ kind: 'SYSTEM', text: 'Context Compacted: previous conversation summarized' }),
      hiddenRules: ['system:compacted'],
      shownRules: ['system:compacted'],
    },
    {
      name: 'generic empty non-bubble row',
      event: decisionEvent({ kind: 'SYSTEM', text: '' }),
      hiddenRules: [],
      shownRules: [],
    },
    {
      name: 'hidden noise',
      event: decisionEvent({ kind: 'USER', text: 'summarize recent commits' }),
      hiddenRules: [],
      shownRules: [],
    },
  ];

  describe.each(cases)('$name', ({ event, hiddenRules, shownRules }) => {
    test('showToolActions=false', () => {
      const detail = selectSessionDetail(stateForDecisionEvents([event]), 'alpha:decision-table', {
        visibleCount: 'all',
        showToolActions: false,
      });

      expectPresent(detail);
      expect(detail.transcriptItems.map((item) => item.displayRule)).toEqual(hiddenRules);
    });

    test('showToolActions=true', () => {
      const detail = selectSessionDetail(stateForDecisionEvents([event]), 'alpha:decision-table', {
        visibleCount: 'all',
        showToolActions: true,
      });

      expectPresent(detail);
      expect(detail.transcriptItems.map((item) => item.displayRule)).toEqual(shownRules);
    });
  });
});

test('selectSessionDetail re-filters the same events after a mid-stream showToolActions flip', () => {
  const events = [
    decisionEvent({ daemon_seq: 9101, kind: 'USER', text: 'please run the checks' }),
    decisionEvent({ daemon_seq: 9102, kind: 'TOOL', text: 'Bash npm test' }),
    decisionEvent({ daemon_seq: 9103, kind: 'THINK', text: 'Thinking about failures' }),
    decisionEvent({
      daemon_seq: 9104,
      kind: 'SYSTEM',
      provider: 'claude',
      text: 'Worked for 12s',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
    }),
    decisionEvent({ daemon_seq: 9105, kind: 'SYSTEM', text: 'Worked for 13s' }),
    decisionEvent({ daemon_seq: 9106, kind: 'ASSIST', text: 'checks passed' }),
  ];
  const state = stateForDecisionEvents(events);

  const hidden = selectSessionDetail(state, 'alpha:decision-table', {
    visibleCount: 'all',
    showToolActions: false,
  });
  const shown = selectSessionDetail(state, 'alpha:decision-table', {
    visibleCount: 'all',
    showToolActions: true,
  });

  expectPresent(hidden);
  expectPresent(shown);
  expect(hidden.transcriptItems.map((item) => item.displayRule)).toEqual([
    'bubble:user',
    'bubble:assistant',
  ]);
  expect(shown.transcriptItems.map((item) => item.displayRule)).toEqual([
    'bubble:user',
    'activity:command',
    'activity:thinking',
    'bubble:assistant',
  ]);
});

test('selectSessionDetail drops Claude JSONL trailing blank rows from the default transcript', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const events = [
    decisionEvent({ daemon_seq: 9201, kind: 'USER', provider: 'claude', text: 'hello, my name is hostc' }),
    decisionEvent({ daemon_seq: 9202, kind: 'ASSIST_TEXT', provider: 'claude', text: 'Hello, hostc.', raw: { source: 'claude-jsonl' } }),
    decisionEvent({
      daemon_seq: 9203,
      kind: 'TOOL_RESULT',
      provider: 'claude',
      text: '',
      raw: {
        source: 'claude-jsonl',
        tool_name: 'Bash',
        tool_use_id: 'toolu_empty_result',
        tool_content: '',
      },
    }),
    decisionEvent({
      daemon_seq: 9204,
      kind: 'SYSTEM',
      provider: 'claude',
      text: '',
      raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
    }),
    decisionEvent({ daemon_seq: 9205, kind: 'SYSTEM', provider: 'claude', text: '----------' }),
  ];
  const detail = selectSessionDetail(stateForDecisionEvents(events), 'alpha:decision-table', {
    visibleCount: 'all',
  });

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.displayRule)).toEqual(['bubble:user', 'bubble:assistant']);
  expect(detail.transcriptItems.map((item) => item.text)).toEqual(['hello, my name is hostc', 'Hello, hostc.']);
  expect(detail.transcriptItems.some((item) => item.text === ' ')).toBe(false);
  expect(seen.filter((payload) => payload.message === TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED)).toEqual([]);
});

test('selectSessionDetail uses optimistic_id for non-finite daemon_seq transcript ids and exposes failed pending state', () => {
  const optimistic = decisionEvent({
    daemon_seq: Number.NaN,
    kind: 'USER',
    text: 'still visible',
    client_origin: true,
    optimistic_id: 'optimistic_alpha_decision_table_1',
    pending: false,
    created_at: Date.now(),
  });
  const detail = selectSessionDetail(stateForDecisionEvents([optimistic]), 'alpha:decision-table', {
    visibleCount: 'all',
  });

  expectPresent(detail);
  expect(detail.transcriptItems).toHaveLength(1);
  expect(detail.transcriptItems[0]).toEqual(expect.objectContaining({
    id: 'optimistic_alpha_decision_table_1',
    text: 'still visible',
    isUser: true,
    pending: false,
  }));
});

test('selectSessionDetail does not append fallback beside a correlated optimistic echo', () => {
  const streamId = 'alpha:decision-table';
  const echoed = decisionEvent({
    daemon_seq: Number.NaN,
    correlatedDaemonSeq: 106,
    kind: 'USER',
    text: 'sample live latency check',
    client_origin: true,
    optimistic_id: 'optimistic_alpha_decision_table_1',
    pending: false,
    created_at: Date.now(),
  });
  const detail = selectSessionDetail(buildState({
    events: [echoed],
    sessions: [{
      stream_id: streamId,
      host: 'alpha',
      provider: 'codex',
      session_name: 'decision-table',
      last_event_at: '2026-05-13T10:00:01.000Z',
      last_text: 'sample live latency check',
      last_kind: 'USER',
      draft: '',
      pending: false,
      working: false,
      online: true,
    }],
  }), streamId, { visibleCount: 'all' });

  expectPresent(detail);
  expect(detail.transcriptItems.map((item) => item.id)).toEqual(['optimistic_alpha_decision_table_1']);
  expect(detail.transcriptItems[0]).toEqual(expect.objectContaining({
    correlatedDaemonSeq: 106,
    eventKey: `${streamId}:106`,
    pending: false,
  }));
});
