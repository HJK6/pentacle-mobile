import {
  applyFetchedStreamEvents,
  applyPentacleEvent,
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  invalidateSessionDetailCache,
  selectSessionDetail,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';

const fixture = require('../../pentacle-chat-core/tests/fixtures/trusted_notification_answer_wire.json');
const before = fixture.before_proof.event as PentacleEvent;
const correction = fixture.correction.event as PentacleEvent;
const streamId = String(correction.stream_id);

const session: PentacleSessionSummary = {
  stream_id: streamId,
  host: String(correction.host),
  provider: String(correction.provider),
  session_name: String(correction.session_name),
  last_event_at: String(correction.timestamp),
  last_text: String(correction.text),
  last_kind: 'USER',
  draft: '',
  pending: false,
  working: false,
  online: true,
};

function seed(): PentacleStreamState {
  return { ...initialPentacleStreamState, connected: true, sessions: [session] };
}

function rows(state: PentacleStreamState) {
  invalidateSessionDetailCache(streamId);
  return selectSessionDetail(state, streamId, { visibleCount: 'all' })?.transcriptItems ?? [];
}

test('unbound generated answer transport is hidden before and after proof correction', () => {
  expect(fixture.provenance).toEqual({
    classification: 'synthetic-known-data',
    generator: 'services/chat-stream-v2/tests/generate_notification_answer_wire_fixture.py',
    path: 'Notify.notification -> OutboundNoticeQueue -> Comms proof -> Store projector -> Notify broadcast',
  });
  expect(fixture.proof).toEqual({
    proof_event_id: correction.daemon_seq,
    proof_state: 'proven',
    proof_watermark: 0,
  });

  const unproven = applyPentacleEvent(seed(), before);
  expect(rows(unproven)).toHaveLength(0);
  const proven = applyPentacleEvent(unproven, correction);
  expect(proven.events).toHaveLength(1);
  expect(rows(proven)).toHaveLength(0);

  const staleReplay = applyFetchedStreamEvents(proven, [before], {
    requestedStreamId: streamId,
  });
  expect(rows(staleReplay)).toHaveLength(0);
  const reconnect = applySnapshotWithOptimisticReconciliation(seed(), {
    sessions: [session],
    events: [correction],
  });
  expect(rows(reconnect)).toHaveLength(0);
});

test('explicit user-bound copies and ordinary quoted prose remain visible', () => {
  const receiptless = applyPentacleEvent(seed(), fixture.receiptless_identical_user.event);
  expect(rows(receiptless)).toHaveLength(0);

  for (const item of [
    fixture.explicit_user_copy.event,
    {
      ...fixture.explicit_user_copy.event,
      daemon_seq: 4,
      request_id: undefined,
      text: `Operator quoted:\n${fixture.notice.body}`,
      raw: { source: 'structured' },
    },
  ] as PentacleEvent[]) {
    const state = applyPentacleEvent(seed(), item);
    expect(rows(state)).toHaveLength(1);
    expect(rows(state)[0]).toMatchObject({
      eventCase: 'user-message',
      displayRule: 'bubble:user',
    });
  }
});
