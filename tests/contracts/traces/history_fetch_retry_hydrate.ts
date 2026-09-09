// Connect/hydrate recovery — summary hello has no transcript events; after a
// history fetch error, a later externally issued retry response applies the
// fetched transcript. This is not an automatic retry-scheduler trace; service
// tests own request emission and rejection behavior.

import { selectSessionDetail } from 'pentacle-chat-core';
import type { TraceContract } from './types';

export const HISTORY_FETCH_RETRY_HYDRATE: TraceContract = {
  name: 'history_fetch_retry_hydrate',
  fixture: 'history_fetch_retry_hydrate_v1',
  description:
    'Summary-mode hydrate starts with no transcript events; after a failed request_stream_events call, a later externally issued retry response applies fetched history.',
  steps: [
    {
      actor: 'daemon',
      event: 'HELLO_SUMMARY',
      payload: { streamId: 'hostb:codex:hydrate' },
      fixtureRow: 0,
      t: 'sameTick',
    },
    {
      actor: 'reducer',
      effect: 'summary_mode_has_no_detail_events',
      assert: (snap) => snap.state.events.filter((event) => event.stream_id === snap.streamId).length === 0,
      assertLabel: 'summary-mode hello does not imply transcript detail is hydrated',
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'request_stream_events',
      payload: { attempt: 1 },
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'REQUEST_STREAM_EVENTS_ERROR',
      payload: { requestId: 'history-1', error: 'temporary failure' },
      fixtureRow: 1,
      t: '<200ms',
    },
    {
      actor: 'user',
      action: 'request_stream_events_retry',
      payload: { attempt: 2 },
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'REQUEST_STREAM_EVENTS_OK',
      payload: { daemonSeq: 9, text: 'history line after retry' },
      fixtureRow: 2,
      t: '<500ms',
    },
    {
      actor: 'reducer',
      effect: 'fetched_history_applies_after_retry',
      assert: (snap) => {
        const rows = selectSessionDetail(snap.state, snap.streamId, { visibleCount: 'all' })?.transcriptItems ?? [];
        return rows.some((row) => row.text === 'history line after retry') || {
          ok: false,
          msg: `expected fetched history row after retry, got ${JSON.stringify(rows)}`,
        };
      },
      assertLabel: 'history retry applies fetched transcript event',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'history_row_renders',
      assert: (snap) => snap.observers.screen.queryTextByTestID('transcript')?.includes('history line after retry') ?? false,
      assertLabel: 'fetched history row is visible after retry',
      t: '<50ms',
    },
  ],
};
