// June-30 Bug B — optimistic send echo reconciliation.
//
// Scenario: mobile creates an optimistic USER row, the daemon later commits the
// USER echo, then snapshot/history replay repeats the committed row. The UI must
// keep one stable sent row, clear the optimistic send record, and never leave an
// orphaned "sending" bubble.

import { selectSessionDetail } from 'pentacle-chat-core';
import type { TraceContract } from './types';

const OPTIMISTIC_ID = 'optimistic_hostb_codex_reconcile_1';

function rowsForText(state: Parameters<typeof selectSessionDetail>[0], streamId: string, text: string) {
  return selectSessionDetail(state, streamId, { visibleCount: 'all' })?.transcriptItems.filter((item) => item.text === text) ?? [];
}

export const OPTIMISTIC_ECHO_RECONCILE: TraceContract = {
  name: 'optimistic_echo_reconcile',
  fixture: 'optimistic_echo_reconcile_v1',
  description:
    'Optimistic text send reconciles against live daemon USER echo and stays one stable row through snapshot/history replay.',
  steps: [
    {
      actor: 'user',
      action: 'composer_press_send',
      payload: { text: 'match me', optimisticId: OPTIMISTIC_ID, requestId: 'send-req-reconcile-1' },
      t: 'sameTick',
    },
    {
      actor: 'reducer',
      effect: 'optimistic_user_pending',
      assert: (snap) => {
        const row = rowsForText(snap.state, snap.streamId, 'match me')[0];
        return (row?.optimisticId === OPTIMISTIC_ID && row.sendState === 'sending') || {
          ok: false,
          msg: `expected pending optimistic row, got ${JSON.stringify(row)}`,
        };
      },
      assertLabel: 'Bug B red replay: optimistic row appears immediately as sending',
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'USER',
      payload: { daemonSeq: 41, text: 'match me', optimisticId: OPTIMISTIC_ID },
      fixtureRow: 0,
      t: '<200ms',
    },
    {
      actor: 'reducer',
      effect: 'live_echo_reconciles_optimistic_row',
      assert: (snap) => {
        const rows = rowsForText(snap.state, snap.streamId, 'match me');
        const row = rows[0];
        return (
          rows.length === 1 &&
          row.id === OPTIMISTIC_ID &&
          row.optimisticId === OPTIMISTIC_ID &&
          row.correlatedDaemonSeq === 41 &&
          row.sendState !== 'sending' &&
          !snap.state.optimisticSends?.[OPTIMISTIC_ID]
        ) || {
          ok: false,
          msg: `expected one reconciled sent row, got rows=${JSON.stringify(rows)} send=${JSON.stringify(snap.state.optimisticSends?.[OPTIMISTIC_ID])}`,
        };
      },
      assertLabel: 'Bug B red replay: committed echo clears sending without duplicate orphan row',
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'SNAPSHOT_REPLAY',
      payload: { daemonSeq: 41, text: 'match me', optimisticId: OPTIMISTIC_ID },
      fixtureRow: 1,
      t: '<500ms',
    },
    {
      actor: 'daemon',
      event: 'FETCHED_HISTORY',
      payload: { daemonSeq: 41, text: 'match me', optimisticId: OPTIMISTIC_ID },
      fixtureRow: 2,
      t: '<500ms',
    },
    {
      actor: 'reducer',
      effect: 'replayed_echo_does_not_duplicate',
      assert: (snap) => {
        const rows = rowsForText(snap.state, snap.streamId, 'match me');
        return (rows.length === 1 && rows[0].id === OPTIMISTIC_ID) || {
          ok: false,
          msg: `snapshot/history replay should preserve one stable row, got ${JSON.stringify(rows)}`,
        };
      },
      assertLabel: 'Bug B red replay: snapshot/history echo replay keeps one stable row',
      t: 'sameTick',
    },
  ],
};
