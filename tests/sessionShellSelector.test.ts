import { selectSafeSessionSummaryPreview } from 'pentacle-chat-core';
import { selectSessionShellSlice } from '../src/services/pentacleStream';
import { isPentacleSessionSendEligible } from '../src/services/sessionInputReadiness';

function state(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    connecting: false,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [{
      stream_id: 'stream-a',
      host: 'hostc',
      provider: 'codex',
      session_name: 'alpha',
      last_event_at: '2026-08-28T12:00:00.000Z',
      last_text: 'A safe summary preview.',
      last_kind: 'ASSIST',
      draft: '',
      pending: false,
      working: false,
      online: true,
    }],
    updates: [],
    notifications: [],
    optimisticSends: {},
    ...overrides,
  } as any;
}

test('safe summary preview preserves fallback suppression for working, tool, and transient summaries', () => {
  expect(selectSafeSessionSummaryPreview(state(), 'stream-a')).toEqual(expect.objectContaining({
    key: expect.stringMatching(/^preview:stream-a:/),
    text: 'A safe summary preview.',
  }));
  expect(selectSafeSessionSummaryPreview(state({ sessions: [{ ...state().sessions[0], working: true }] }), 'stream-a')).toBeNull();
  expect(selectSafeSessionSummaryPreview(state({ sessions: [{ ...state().sessions[0], last_kind: 'TOOL', last_text: 'Ran a command' }] }), 'stream-a')).toBeNull();
  expect(selectSafeSessionSummaryPreview(state({ sessions: [{ ...state().sessions[0], last_text: 'Working (5s)' }] }), 'stream-a')).toBeNull();
});

test('shell selector is stable and removes preview on the first authoritative bucket commit', () => {
  const loading = state({ eventBucketsByStream: {
    'stream-a': { events: [], request: { status: 'loading' } },
  } });
  const first = selectSessionShellSlice(loading, 'stream-a');
  expect(selectSessionShellSlice(loading, 'stream-a')).toBe(first);
  expect(first.preview?.key).toMatch(/^preview:stream-a:/);

  const committed = state({ eventBucketsByStream: {
    'stream-a': { events: [{ stream_id: 'stream-a', daemon_seq: 1, timestamp: '2026-08-28T12:01:00.000Z', kind: 'ASSIST', text: 'Authoritative row' }], request: { status: 'ready' } },
  } });
  expect(selectSessionShellSlice(committed, 'stream-a')).toEqual(expect.objectContaining({ retainedRows: 1, request: 'ready', preview: null }));
});

test('send eligibility waits for canonical ready while preserving legacy sessions', () => {
  const session = state().sessions[0];
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: 'queued' })).toBe(false);
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: 'starting' })).toBe(false);
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: 'failed' })).toBe(false);
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: 'ready' })).toBe(true);
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: null })).toBe(true);
  expect(isPentacleSessionSendEligible(session)).toBe(true);
  expect(isPentacleSessionSendEligible({ ...session, bootstrap_state: 'started' })).toBe(true);
  expect(isPentacleSessionSendEligible(null)).toBe(false);
});

