import { connect, flush, mockDisk } from './helpers/outboxTransport';
import type { OutboxText } from '../src/services/outboxStore';

const DAY = 86_400_000;
const MINUTE = 60_000;
const STREAM = 'hostb:other';
const GENERATION = 'other-generation-1';
const OLD = 'synthetic-old-local';

const presentation = () => require('../src/services/coldOutboxPresentation') as
  typeof import('../src/services/coldOutboxPresentation');

function record(id: string, createdAt: number, attemptAt = createdAt): Omit<OutboxText, 'scopeHash'> {
  return {
    kind: 'text', id, streamId: STREAM, originGeneration: GENERATION, createdAt,
    error: 'Delivery unconfirmed. Try again.',
    frame: {
      type: 'send', optimistic_id: id, host: 'hostb', session_name: 'other',
      text: 'Synthetic text', request_id: `send-${attemptAt}-abc123`,
    },
  };
}

test('presentation recency uses the newest recorded attempt strictly older than a day', () => {
  const { isOlderRecordedSend } = presentation();
  const now = Date.now();
  for (const age of [30 * MINUTE - 1, 30 * MINUTE, 30 * MINUTE + 1, DAY - 1, DAY]) {
    expect(isOlderRecordedSend(now - age, `send-${now - age}-abc123`, now)).toBe(false);
  }
  expect(isOlderRecordedSend(now - DAY - 1, `send-${now - DAY - 1}-abc123`, now)).toBe(true);
  expect(isOlderRecordedSend(now - 2 * DAY, `send-${now - 31 * MINUTE}-abc123`, now)).toBe(false);
  for (const creation of [0, -1, NaN, Infinity, now - 2 * DAY + 0.5, now + 1, 8.65e15]) {
    expect(isOlderRecordedSend(creation, `send-${now - 2 * DAY}-abc123`, now)).toBe(false);
  }
  for (const request of ['send-old', 'send-0-a', 'send-12.5-x', `photo-${now - 2 * DAY}-abc123`, `send-${now + 1}-abc123`]) {
    expect(isOlderRecordedSend(now - 2 * DAY, request, now)).toBe(false);
  }
});

test('cold restoration folds only the exact old failed attempt and recovery is read-only', async () => {
  const initial = await connect();
  const { outboxStore } = require('../src/services/outboxStore') as typeof import('../src/services/outboxStore');
  const now = Date.now();
  await outboxStore.put(record(OLD, now - 2 * DAY));
  await outboxStore.put(record('recent', now - 31 * MINUTE));
  await outboxStore.put(record('recent-attempt', now - 2 * DAY, now - 31 * MINUTE));
  await outboxStore.put({ ...record('different-generation', now - 2 * DAY), originGeneration: 'another-generation' });
  const reply = record('reply', now - 2 * DAY);
  await outboxStore.put({ ...reply, frame: { ...reply.frame, reply_to_message_id: 'existing-message' } });
  initial.cleanup();

  const fresh = await connect();
  try {
    await flush();
    const { coldOutboxPreviewState, presentEarlierLocalMessages } = presentation();
    const state = fresh.stream.getPentacleStreamState();
    const slice = fresh.stream.selectStreamSlice(state, STREAM);
    expect([...slice.earlierLocalMessageIds!]).toEqual([OLD]);
    expect(state.optimisticSends?.[OLD]).toMatchObject({ status: 'failed' });
    const stableDisk = [...mockDisk].map(([path, value]) => [path, Buffer.from(value)]);
    const inline = presentEarlierLocalMessages(slice.detail!.transcriptItems, slice.earlierLocalMessageIds);
    expect(inline.map(row => row.optimisticId)).toEqual(expect.arrayContaining(['recent', 'recent-attempt', 'different-generation', 'reply']));
    expect(inline.some(row => row.optimisticId === OLD)).toBe(false);
    expect(coldOutboxPreviewState(state).events.some(event => event.optimistic_id === OLD)).toBe(false);

    const expanded = fresh.stream.selectStreamSlice(state, STREAM, { visibleCount: 1, earlierLocalScope: slice.earlierLocalScope });
    const earlier = expanded.earlierLocalRows!;
    expect(earlier).toHaveLength(1);
    expect(earlier[0]).toMatchObject({ optimisticId: OLD, sendState: 'failed' });
    expect(presentEarlierLocalMessages(expanded.detail!.transcriptItems, expanded.earlierLocalMessageIds, earlier)
      .filter(row => row.optimisticId === OLD)).toEqual(earlier);
    expect([...mockDisk]).toEqual(stableDisk);
    expect(fresh.socket.sends()).toEqual([]);
    expect(fresh.socket.frames('send.receipt.get')).toEqual([]);

    const request = fresh.stream.retryOptimisticSend(OLD);
    await flush();
    const [attempt] = fresh.socket.sends();
    expect(attempt).toMatchObject({ optimistic_id: OLD, text: 'Synthetic text' });
    expect(attempt.request_id).not.toBe(state.optimisticSends?.[OLD]?.request_id);
    fresh.socket.message({ type: 'send.error', request_id: attempt.request_id, code: 'pane_unavailable' });
    await Promise.allSettled([request]);
    const retried = fresh.stream.getPentacleStreamState();
    expect(fresh.stream.selectStreamSlice(retried, STREAM).earlierLocalMessageIds).toBeUndefined();
    expect(retried.optimisticSends?.[OLD]?.request_id).toBe(attempt.request_id);
  } finally {
    fresh.cleanup();
  }
});

test.each(['history first', 'restore first'])('authoritative same-ID USER stays visible with %s', async (order) => {
  const initial = await connect();
  const { outboxStore } = require('../src/services/outboxStore') as typeof import('../src/services/outboxStore');
  const manifest = await outboxStore.put(record(OLD, Date.now() - 2 * DAY)) as OutboxText;
  const outboxBytes = () => [...mockDisk].filter(([path]) => path.includes('/outbox-v1/'));
  const original = outboxBytes().map(([path, value]) => [path, Buffer.from(value)]);
  initial.cleanup();

  const echo = {
    host: 'hostb', provider: 'codex', session_id: STREAM, session_name: 'other',
    stream_id: STREAM, timestamp: new Date().toISOString(), kind: 'USER', text: 'Synthetic text',
    optimistic_id: OLD, daemon_seq: 90,
  };
  const fresh = await connect(undefined, false, order === 'history first' ? [echo] : []);
  try {
    if (order === 'history first') {
      expect(fresh.immediatelyAfterSnapshot.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ optimistic_id: OLD, daemon_seq: 90, kind: 'USER' }),
      ]));
    }
    await flush();
    if (order === 'restore first') {
      expect(fresh.stream.getPentacleStreamState().optimisticSends?.[OLD]?.status).toBe('failed');
      fresh.socket.message({ type: 'chat.event', event: echo });
      jest.advanceTimersByTime(200);
      await flush();
    }
    const state = fresh.stream.getPentacleStreamState();
    const slice = fresh.stream.selectStreamSlice(state, STREAM);
    expect(state.events.filter(event => event.optimistic_id === OLD)
      .map(event => event.correlatedDaemonSeq ?? event.daemon_seq)).toEqual([90]);
    const visible = slice.detail?.transcriptItems.filter(row => row.text === 'Synthetic text') ?? [];
    expect(visible).toHaveLength(1);
    expect(visible[0].optimisticId).toBe(OLD);
    expect(visible[0].sendState).toBeUndefined();
    expect(slice.earlierLocalMessageIds).toBeUndefined();
    expect(fresh.socket.sends()).toEqual([]);
    expect(fresh.socket.frames('send.receipt.get')).toEqual([]);
    if (order === 'history first') {
      expect(outboxBytes()).toEqual(original);
      const { hasObservedAuthoritativeUser } = presentation();
      const prior = fresh.immediatelyAfterSnapshot;
      expect(hasObservedAuthoritativeUser(manifest, manifest.scopeHash, prior)).toBe(true);
      expect(hasObservedAuthoritativeUser(manifest, 'different-scope', prior)).toBe(false);
      expect(hasObservedAuthoritativeUser({ ...manifest, originGeneration: 'different-generation' }, manifest.scopeHash, prior))
        .toBe(false);
      const otherId = 'same-body-different-id';
      expect(hasObservedAuthoritativeUser({
        ...manifest, id: otherId, frame: { ...manifest.frame, optimistic_id: otherId },
      }, manifest.scopeHash, prior)).toBe(false);
    }
  } finally {
    fresh.cleanup();
  }
});

test('older inventory keeps the local preview folded while an authoritative same-body summary stays visible', async () => {
  const now = Date.now();
  const target = {
    stream_id: STREAM, host: 'hostb', session_name: 'other', provider: 'codex',
    session_generation: GENERATION, online: true, last_kind: 'ASSIST',
    last_event_at: new Date(now - 3 * DAY).toISOString(), last_text: 'Older server summary',
  };
  const initial = await connect([target]);
  const { outboxStore } = require('../src/services/outboxStore') as typeof import('../src/services/outboxStore');
  await outboxStore.put(record(OLD, now - 2 * DAY));
  initial.cleanup();

  const fresh = await connect([target]);
  try {
    await flush();
    const { coldOutboxPreviewState } = presentation();
    const { createChatListSelector } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
    const selectChatList = createChatListSelector();
    const listPreview = () => selectChatList(coldOutboxPreviewState(fresh.stream.getPentacleStreamState()))
      .find(row => row.streamId === STREAM)?.previewText;
    const preview = () => coldOutboxPreviewState(fresh.stream.getPentacleStreamState()).sessions
      .find(session => session.stream_id === STREAM);
    expect(preview()?.last_text).toBe('Older server summary');
    fresh.socket.message({ type: 'session.inventory', sessions: [target] });
    await flush();
    expect(preview()?.last_text).toBe('Older server summary');
    expect(listPreview()).toBe('Older server summary');

    const sameBody = { ...target, last_text: 'Synthetic text', last_kind: 'USER',
      last_event_at: new Date(now - 2 * DAY - 1).toISOString() };
    fresh.socket.message({ type: 'session.inventory', sessions: [sameBody] });
    await flush();
    expect(preview()).toMatchObject({ last_text: sameBody.last_text, last_event_at: sameBody.last_event_at });
    expect(listPreview()).toBe(sameBody.last_text);
    expect(fresh.stream.selectStreamSlice(fresh.stream.getPentacleStreamState(), STREAM).earlierLocalMessageIds?.has(OLD))
      .toBe(true);
  } finally {
    fresh.cleanup();
  }
});
