import { dedupeRecentEvents, dedupeRecentEventsByStream } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

test('dedupeRecentEvents keeps the latest copy of each daemon sequence in order', () => {
  const events = [
    { daemon_seq: 1, text: 'first' },
    { daemon_seq: 2, text: 'second' },
    { daemon_seq: 2, text: 'second latest' },
    { daemon_seq: 3, text: 'third' },
    { daemon_seq: 1, text: 'first latest' },
  ];

  expect(dedupeRecentEvents(events, 10)).toEqual([
    { daemon_seq: 2, text: 'second latest' },
    { daemon_seq: 3, text: 'third' },
    { daemon_seq: 1, text: 'first latest' },
  ]);
});

test('dedupeRecentEvents trims to the most recent unique events', () => {
  const events = [
    { daemon_seq: 1, text: 'one' },
    { daemon_seq: 2, text: 'two' },
    { daemon_seq: 3, text: 'three' },
  ];

  expect(dedupeRecentEvents(events, 2)).toEqual([
    { daemon_seq: 2, text: 'two' },
    { daemon_seq: 3, text: 'three' },
  ]);
});

test('dedupeRecentEvents preserves client-origin optimistic events by optimistic_id', () => {
  const events = [
    { daemon_seq: Number.NaN, client_origin: true, optimistic_id: 'optimistic_one_1', text: 'first copy' },
    { daemon_seq: Number.NaN, client_origin: true, optimistic_id: 'optimistic_two_1', text: 'second' },
    { daemon_seq: Number.NaN, client_origin: true, optimistic_id: 'optimistic_one_1', text: 'first latest' },
    { daemon_seq: Number.NaN, text: 'malformed server event' },
    { daemon_seq: 9, text: 'server event' },
  ];

  expect(dedupeRecentEvents(events, 10)).toEqual([
    { daemon_seq: Number.NaN, client_origin: true, optimistic_id: 'optimistic_two_1', text: 'second' },
    { daemon_seq: Number.NaN, client_origin: true, optimistic_id: 'optimistic_one_1', text: 'first latest' },
    { daemon_seq: 9, text: 'server event' },
  ]);
});

test('dedupeRecentEventsByStream keeps a recent window for each chat stream', () => {
  const events = [
    { daemon_seq: 1, stream_id: 'alpha:long', text: 'alpha 1' },
    { daemon_seq: 2, stream_id: 'alpha:long', text: 'alpha 2' },
    { daemon_seq: 3, stream_id: 'beta:busy', text: 'beta 1' },
    { daemon_seq: 4, stream_id: 'beta:busy', text: 'beta 2' },
    { daemon_seq: 5, stream_id: 'beta:busy', text: 'beta 3' },
    { daemon_seq: 6, stream_id: 'alpha:long', text: 'alpha 3' },
  ];

  expect(dedupeRecentEventsByStream(events, 2)).toEqual([
    { daemon_seq: 2, stream_id: 'alpha:long', text: 'alpha 2' },
    { daemon_seq: 4, stream_id: 'beta:busy', text: 'beta 2' },
    { daemon_seq: 5, stream_id: 'beta:busy', text: 'beta 3' },
    { daemon_seq: 6, stream_id: 'alpha:long', text: 'alpha 3' },
  ]);
});

test('dedupeRecentEventsByStream preserves client-origin optimistic events by stream and optimistic_id', () => {
  const events = [
    { daemon_seq: 1, stream_id: 'alpha:one', text: 'server 1' },
    { daemon_seq: Number.NaN, stream_id: 'alpha:one', client_origin: true, optimistic_id: 'optimistic_one_1', text: 'one first' },
    { daemon_seq: Number.NaN, stream_id: 'alpha:one', client_origin: true, optimistic_id: 'optimistic_one_2', text: 'one second' },
    { daemon_seq: Number.NaN, stream_id: 'alpha:one', client_origin: true, optimistic_id: 'optimistic_one_1', text: 'one first latest' },
    { daemon_seq: Number.NaN, stream_id: 'beta:two', client_origin: true, optimistic_id: 'optimistic_two_1', text: 'two first' },
    { daemon_seq: Number.NaN, stream_id: 'beta:two', text: 'malformed server event' },
    { daemon_seq: 2, stream_id: 'beta:two', text: 'server 2' },
  ];

  expect(dedupeRecentEventsByStream(events, 3)).toEqual([
    { daemon_seq: 1, stream_id: 'alpha:one', text: 'server 1' },
    { daemon_seq: Number.NaN, stream_id: 'alpha:one', client_origin: true, optimistic_id: 'optimistic_one_2', text: 'one second' },
    { daemon_seq: Number.NaN, stream_id: 'alpha:one', client_origin: true, optimistic_id: 'optimistic_one_1', text: 'one first latest' },
    { daemon_seq: Number.NaN, stream_id: 'beta:two', client_origin: true, optimistic_id: 'optimistic_two_1', text: 'two first' },
    { daemon_seq: 2, stream_id: 'beta:two', text: 'server 2' },
  ]);
});
