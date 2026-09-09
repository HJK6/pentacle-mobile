import {
  dedupeRecentEvents,
  dedupeRecentEventsByStream,
  mergeProgressiveUpdate,
} from 'pentacle-chat-core';

test('progressive merge rejects invalid identities and preserves provenance across real extensions', () => {
  expect(mergeProgressiveUpdate({ daemon_seq: Number.NaN, text: 'a' }, { daemon_seq: 1, text: 'ab' })).toBeNull();
  expect(mergeProgressiveUpdate({ daemon_seq: 1, text: 'a' }, { daemon_seq: Number.NaN, text: 'ab' })).toBeNull();
  expect(mergeProgressiveUpdate({ daemon_seq: 1, text: 'a' }, { daemon_seq: 2, text: 'ab' })).toBeNull();
  expect(mergeProgressiveUpdate({ daemon_seq: 1, text: 'later' }, { daemon_seq: 1, text: 'late' })).toBeNull();

  const raw = { source: 'initial' };
  const prior = { daemon_seq: 1, text: undefined, raw, stable: 'keep' };
  expect(mergeProgressiveUpdate(prior, { daemon_seq: 1, text: undefined, raw })).toBe(prior);
  expect(mergeProgressiveUpdate(prior, { daemon_seq: 1, text: 'extended' })).toEqual({
    daemon_seq: 1,
    text: 'extended',
    raw,
    stable: 'keep',
  });
  expect(mergeProgressiveUpdate(prior, { daemon_seq: 1, text: 'extended', raw: { source: 'next' } })).toEqual(expect.objectContaining({
    text: 'extended',
    raw: { source: 'next' },
  }));
});

test('recent-event dedupe keeps newest valid daemon and optimistic identities within the limit', () => {
  const events = [
    { daemon_seq: 1 },
    { daemon_seq: Number.NaN },
    { daemon_seq: 1 },
    { daemon_seq: 2, client_origin: true, optimistic_id: '' },
    { daemon_seq: 3, client_origin: true, optimistic_id: 'o1' },
    { daemon_seq: 4, client_origin: true, optimistic_id: 'o1' },
    { daemon_seq: 5 },
  ];
  expect(dedupeRecentEvents(events, 3)).toEqual([
    { daemon_seq: 1 },
    { daemon_seq: 4, client_origin: true, optimistic_id: 'o1' },
    { daemon_seq: 5 },
  ]);
  expect(dedupeRecentEvents(events, 1)).toEqual([{ daemon_seq: 5 }]);
});

test('per-stream dedupe applies independent limits and safe unknown-stream handling', () => {
  const events = [
    { daemon_seq: 1, stream_id: 'a' },
    { daemon_seq: 1, stream_id: 'a' },
    { daemon_seq: 2, stream_id: 'a' },
    { daemon_seq: 3, stream_id: 'a' },
    { daemon_seq: Number.NaN, stream_id: 'b' },
    { daemon_seq: 1, stream_id: 'b' },
    { daemon_seq: 2, stream_id: 'b', client_origin: true, optimistic_id: '' },
    { daemon_seq: 3, stream_id: 'b', client_origin: true, optimistic_id: 'shared' },
    { daemon_seq: 4, client_origin: true, optimistic_id: 'shared' },
    { daemon_seq: 5 },
  ];
  expect(dedupeRecentEventsByStream(events, 2)).toEqual([
    { daemon_seq: 2, stream_id: 'a' },
    { daemon_seq: 3, stream_id: 'a' },
    { daemon_seq: 1, stream_id: 'b' },
    { daemon_seq: 4, client_origin: true, optimistic_id: 'shared' },
    { daemon_seq: 5 },
  ]);
});
