jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

import {
  invalidateSessionDetailCache,
  selectSessionDetail,
} from 'pentacle-chat-core';

function buildState(streamId: string, text: string) {
  const event = {
    daemon_seq: streamId.endsWith('a') ? 100 : 200,
    host: 'alpha',
    provider: 'codex',
    session_id: streamId,
    session_name: streamId.split(':').at(-1) || streamId,
    stream_id: streamId,
    timestamp: '2026-05-13T11:00:00.000Z',
    kind: 'ASSIST',
    text,
  };

  return {
    connected: true,
    connecting: false,
    events: [event],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [
      {
        stream_id: streamId,
        host: 'alpha',
        provider: 'codex',
        session_name: streamId.split(':').at(-1) || streamId,
        last_event_at: event.timestamp,
        last_text: text,
        last_kind: 'ASSIST',
        draft: '',
        pending: false,
        working: false,
        online: true,
      },
    ],
    updates: [],
  };
}

test('invalidateSessionDetailCache evicts only the requested stream cache entries', () => {
  const stateA = buildState('alpha:cache-a', 'cached answer a');
  const stateB = buildState('alpha:cache-b', 'cached answer b');

  const firstA = selectSessionDetail(stateA as any, 'alpha:cache-a', { visibleCount: 'all' });
  const firstB = selectSessionDetail(stateB as any, 'alpha:cache-b', { visibleCount: 'all' });

  expect(firstA).toBeTruthy();
  expect(firstB).toBeTruthy();

  invalidateSessionDetailCache('alpha:cache-a');

  const secondA = selectSessionDetail(stateA as any, 'alpha:cache-a', { visibleCount: 'all' });
  const secondB = selectSessionDetail(stateB as any, 'alpha:cache-b', { visibleCount: 'all' });

  expect(secondA).toBeTruthy();
  expect(secondB).toBeTruthy();
  expect(secondA).not.toBe(firstA);
  expect(secondB).toBe(firstB);
});
