import {
  connect,
  flush,
  origin,
  originId,
  MockWebSocket,
  mockDisk,
  scope,
} from './helpers/outboxTransport';

test('U9 text is committed before a socket send and restored once with the original identity after a kill', async () => {
  const j = await connect();
  let durableAtWire = false;
  const send = j.socket.send.bind(j.socket);
  j.socket.send = (raw) => {
    const f = JSON.parse(raw);
    if (f.type === 'send')
      durableAtWire = [...mockDisk.values()].some((b) => b.toString().includes(f.request_id));
    send(raw);
  };
  const id = j.stream.sendTurn(originId, 'Synthetic durable text');
  const sent = j.stream.sendPentacleMessage({
    streamId: originId,
    text: 'Synthetic durable text',
    optimisticId: id!,
  });
  await flush();
  const frame = j.socket.sends()[0];
  expect(frame).toBeDefined();
  expect(durableAtWire).toBe(true);
  expect([...mockDisk.values()].some((b) => b.toString().includes(frame.request_id))).toBe(true);
  j.cleanup();
  await sent.catch(() => undefined);
  jest.resetModules();
  const fresh = await connect();
  await flush();
  const replay = fresh.socket.sends();
  expect(replay).toHaveLength(1);
  expect(replay[0]).toEqual(frame);
  fresh.socket.message({
    type: 'send.result',
    request_id: frame.request_id,
    to_stream_id: originId,
    delivery: 'landed',
  });
  await flush();
  fresh.cleanup();
});
test('U9 prompt.answer offline survives process death, replays exact frame, and already_answered settles it', async () => {
  const j = await connect();
  j.socket.close();
  await flush();
  await j.stream.answerDaemonPrompt({
    questionId: 'owned-question',
    selections: ['owned'],
    text: 'Synthetic note',
  });
  const store = require('../src/services/outboxStore').outboxStore;
  const entry = store.snapshot().entries.find((e: any) => e.kind === 'prompt_answer');
  expect(entry.frame).toMatchObject({
    question_id: 'owned-question',
    text: 'Synthetic note',
    selections: ['owned'],
  });
  j.cleanup();
  jest.resetModules();
  const fresh = await connect();
  fresh.socket.answerError = 'already_answered';
  await flush();
  expect(fresh.socket.frames('prompt.answer')).toEqual([entry.frame]);
  expect(require('../src/services/outboxStore').outboxStore.snapshot().entries).toEqual([]);
  fresh.cleanup();
});
test('U9 legacy send is persisted before dismiss and resumes the remaining send leg after a kill', async () => {
  const j = await connect();
  const optimisticId = j.stream.beginOptimisticQuestionAnswer({
    streamId: originId,
    text: 'Synthetic answer',
  })!;
  const pending = await j.stream.persistLegacyAnswer({
    streamId: originId,
    optimisticId,
    host: origin.host as string,
    sessionName: origin.session_name as string,
    questionKey: 'owned-key',
    text: 'Synthetic answer',
  });
  expect(pending).not.toBeNull();
  expect(j.socket.frames('question.dismiss')).toEqual([]);
  const store = require('../src/services/outboxStore').outboxStore;
  await store.update(pending!.id, (e: any) => ({
    ...e,
    legs: { dismissed: true },
  }));
  j.cleanup();
  jest.resetModules();
  const fresh = await connect();
  await flush();
  expect(fresh.socket.frames('question.dismiss')).toEqual([]);
  expect(fresh.socket.sends()).toHaveLength(1);
  fresh.cleanup();
});
test('U9 another credential cannot restore or replay exact answer frames', async () => {
  const j = await connect();
  j.socket.close();
  await flush();
  await j.stream.answerDaemonPrompt({
    questionId: 'owned-question',
    text: 'Synthetic',
  });
  const store = require('../src/services/outboxStore').outboxStore;
  await store.setScope({ ...scope, credentialId: 'other-operator' });
  expect(store.snapshot().entries).toEqual([]);
  expect(store.snapshot().heldCount).toBe(1);
  j.cleanup();
});
test('U9 a restored text older than 30 minutes stays visible for Retry without a wire attempt', async () => {
  const j = await connect();
  const store = require('../src/services/outboxStore').outboxStore;
  await store.put({
    kind: 'text',
    id: 'old-opt',
    streamId: originId,
    createdAt: Date.now() - 31 * 60 * 1000,
    frame: {
      type: 'send',
      stream_id: originId,
      msg_id: 'old-opt',
      message: 'Synthetic old text',
      request_id: 'send-old',
    },
  });
  j.cleanup();
  jest.resetModules();
  const fresh = await connect();
  await flush();
  expect(fresh.socket.sends()).toEqual([]);
  expect(fresh.stream.getPentacleStreamState().optimisticSends?.['old-opt']).toMatchObject({
    status: 'failed',
    request_id: 'send-old',
  });
  fresh.cleanup();
});
test('U9 notification resolve is restored with its original request id after an offline kill', async () => {
  const j = await connect();
  j.socket.close();
  await flush();
  await j.stream.resolveNotification({
    notification_id: 'owned-action',
    action_kind: 'ack',
  });
  const store = require('../src/services/outboxStore').outboxStore;
  const entry = store.snapshot().entries.find((e: any) => e.kind === 'notification_resolve');
  expect(entry).toBeDefined();
  j.cleanup();
  jest.resetModules();
  const fresh = await connect();
  await flush();
  expect(fresh.socket.frames('notification.resolve')).toEqual([entry.frame]);
  fresh.socket.message({
    type: 'notification.resolve.ok',
    request_id: entry.id,
  });
  await flush();
  expect(require('../src/services/outboxStore').outboxStore.get(entry.id)).toBeUndefined();
  fresh.cleanup();
});
test('U9 a hard prompt error is terminal and its exact answer is retained without automatic replay', async () => {
  const j = await connect();
  j.socket.answerError = 'expired';
  await expect(
    j.stream.answerDaemonPrompt({
      questionId: 'owned-expired',
      text: 'Synthetic',
    }),
  ).rejects.toMatchObject({ errorCode: 'expired' });
  const store = require('../src/services/outboxStore').outboxStore;
  expect(store.snapshot().entries[0]).toMatchObject({
    kind: 'prompt_answer',
    error: 'expired',
  });
  j.cleanup();
  jest.resetModules();
  const fresh = await connect();
  await flush();
  expect(fresh.socket.frames('prompt.answer')).toEqual([]);
  fresh.cleanup();
});
test('U9 a composer loaded after hydration still sees its persisted scoped draft', async () => {
  const j=await connect(),store=require('../src/services/outboxStore').outboxStore;
  await store.setDraft(originId,'Synthetic retained draft');
  const drafts=require('../src/services/composerDrafts') as typeof import('../src/services/composerDrafts');
  // A failed send may restore only the current revision; initial hydration is revision zero.
  expect(drafts.draftRevision(originId)).toBe(0);
  drafts.setDraft(originId,old => {expect(old).toBe('Synthetic retained draft');return old;}); await flush();
  j.cleanup();
});
