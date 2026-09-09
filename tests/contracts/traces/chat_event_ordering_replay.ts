// June-30 Bug A — deterministic transcript ordering.
//
// Scenario: daemon events arrive out of chronological order. The reducer may
// store them in arrival order, but the rendered transcript must sort by
// authoritative event ordering, including daemon sequence as the same-timestamp
// tiebreak.

import { selectSessionDetail } from 'pentacle-chat-core';
import type { TraceContract } from './types';

function transcriptTexts(state: Parameters<typeof selectSessionDetail>[0], streamId: string) {
  return selectSessionDetail(state, streamId, { visibleCount: 'all' })?.transcriptItems.map((item) => item.text) ?? [];
}

export const CHAT_EVENT_ORDERING_REPLAY: TraceContract = {
  name: 'chat_event_ordering_replay',
  fixture: 'chat_event_ordering_replay_v1',
  description:
    'Out-of-order daemon transcript events render by deterministic event order, with daemon_seq as the same-timestamp tiebreak.',
  steps: [
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { daemonSeq: 3, timestamp: '2026-06-30T12:00:03.000Z', text: 'third' },
      fixtureRow: 0,
      t: '<200ms',
    },
    {
      actor: 'daemon',
      event: 'USER',
      payload: { daemonSeq: 2, timestamp: '2026-06-30T12:00:02.000Z', text: 'second' },
      fixtureRow: 1,
      t: '<200ms',
    },
    {
      actor: 'reducer',
      effect: 'transcript_orders_out_of_order_events',
      assert: (snap) => {
        const texts = transcriptTexts(snap.state, snap.streamId);
        return JSON.stringify(texts) === JSON.stringify(['second', 'third']) || {
          ok: false,
          msg: `expected transcript order second -> third, got ${JSON.stringify(texts)}`,
        };
      },
      assertLabel: 'Bug A red replay: arrival order must not become display order',
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { daemonSeq: 42, timestamp: '2026-06-30T12:00:04.000Z', text: 'seq 42' },
      fixtureRow: 2,
      t: '<200ms',
    },
    {
      actor: 'daemon',
      event: 'USER',
      payload: { daemonSeq: 41, timestamp: '2026-06-30T12:00:04.000Z', text: 'seq 41' },
      fixtureRow: 3,
      t: '<200ms',
    },
    {
      actor: 'reducer',
      effect: 'same_timestamp_uses_daemon_seq_tiebreak',
      assert: (snap) => {
        const texts = transcriptTexts(snap.state, snap.streamId);
        const seq41 = texts.indexOf('seq 41');
        const seq42 = texts.indexOf('seq 42');
        return (seq41 >= 0 && seq42 >= 0 && seq41 < seq42) || {
          ok: false,
          msg: `expected seq 41 before seq 42, got ${JSON.stringify(texts)}`,
        };
      },
      assertLabel: 'Bug A red replay: daemon_seq orders same-timestamp rows',
      t: 'sameTick',
    },
  ],
};
