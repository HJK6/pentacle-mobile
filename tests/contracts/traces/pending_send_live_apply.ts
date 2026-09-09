// June-30 Bug C — later committed events apply while an optimistic send is pending.

import { selectSessionDetail } from 'pentacle-chat-core';
import type { TraceContract } from './types';

function transcriptTexts(state: Parameters<typeof selectSessionDetail>[0], streamId: string) {
  return selectSessionDetail(state, streamId, { visibleCount: 'all' })?.transcriptItems.map((item) => item.text) ?? [];
}

export const PENDING_SEND_LIVE_APPLY: TraceContract = {
  name: 'pending_send_live_apply',
  fixture: 'pending_send_live_apply_v1',
  description:
    'A pending optimistic send does not head-of-line block a newer committed assistant event from applying and rendering.',
  steps: [
    {
      actor: 'user',
      action: 'composer_press_send',
      payload: {
        text: 'pending user send',
        optimisticId: 'optimistic_hostb_codex_pending_1',
        requestId: 'send-req-pending-1',
      },
      t: 'sameTick',
    },
    {
      actor: 'reducer',
      effect: 'pending_user_row_visible',
      assert: (snap) => transcriptTexts(snap.state, snap.streamId).includes('pending user send'),
      assertLabel: 'pending optimistic row is visible before committed daemon content arrives',
      t: 'sameTick',
    },
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { daemonSeq: 33, timestamp: '2026-06-30T12:00:33.000Z', text: 'committed assistant update' },
      fixtureRow: 0,
      t: '<200ms',
    },
    {
      actor: 'reducer',
      effect: 'committed_event_applies_despite_pending_send',
      assert: (snap) => {
        const texts = transcriptTexts(snap.state, snap.streamId);
        return JSON.stringify(texts) === JSON.stringify(['pending user send', 'committed assistant update']) || {
          ok: false,
          msg: `expected pending row plus committed assistant update, got ${JSON.stringify(texts)}`,
        };
      },
      assertLabel: 'Bug C red replay: pending optimistic send must not block later committed event',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'assist_row_renders',
      assert: (snap) => snap.observers.screen.queryTextByTestID('assist-row')?.includes('committed assistant update') ?? false,
      assertLabel: 'committed assistant update renders while pending send remains visible',
      t: '<50ms',
    },
  ],
};
