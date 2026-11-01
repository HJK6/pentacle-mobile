import {
  rearmOfflineQueuedSends,
  eligibleReconnectReplayOptimisticIds,
} from '../src/services/reconnectReplay';
import { initialPentacleStreamState, sendOptimisticMessage } from 'pentacle-chat-core';
test('U12 photo request ids never enter generic reconnect replay, including before hydration', () => {
  const s = sendOptimisticMessage(initialPentacleStreamState, {
    streamId: 'hosta:chat',
    optimisticId: 'opt',
    requestId: 'photo-123',
    text: 'Synthetic photo',
    createdAt: 1000,
    socketGeneration: 1,
    windowStartedAt: null,
  });
  const armed = rearmOfflineQueuedSends(s, 2, 1100);
  expect(armed).toBe(s);
  expect(eligibleReconnectReplayOptimisticIds(armed, 2, 1100)).toEqual([]);
});

// The transport fixture mocks only filesystem/native boundaries and the daemon peer.
import { connect, flush, originId, image, mockDisk } from './helpers/outboxTransport';
test('U12 commit is acknowledged before image bytes; after the last upload ACK the client never sends', async () => {
  const j = await connect(undefined, true);
  const optimisticId = j.stream.sendTurn(originId, 'Synthetic photo', [
    { key: 'local', mime: 'image/jpeg' },
  ])!;
  const wire = await j.stream.sendPhotoOutbox(optimisticId, [image]);
  await flush();
  expect(wire).toHaveLength(1);
  expect(j.socket.frames('outbound.commit')).toHaveLength(1);
  const types = j.socket.sent.map((f) => f.type);
  expect(types.indexOf('outbound.commit')).toBeLessThan(types.indexOf('upload_blob_init'));
  await j.stream.sendPentacleMessage({
    streamId: originId,
    text: 'Synthetic photo',
    optimisticId,
    attachments: wire,
  });
  expect(j.socket.sends()).toEqual([]);
  const store = require('../src/services/outboxStore').outboxStore;
  expect(store.snapshot().entries[0]).toMatchObject({
    kind: 'photo',
    committed: true,
    uploaded: [wire[0].key],
  });
  j.cleanup();
});
test('U12 no capability sends the ordinary frame once from the owned photo entry', async () => {
  const j = await connect();
  const id = j.stream.sendTurn(originId, 'Synthetic legacy photo')!;
  const work = j.stream.sendPhotoOutbox(id, [image]);
  await flush();
  const send = j.socket.sends()[0];
  expect(send).toBeDefined();
  expect(j.socket.frames('outbound.commit')).toEqual([]);
  j.socket.message({
    type: 'send.result',
    request_id: send.request_id,
    to_stream_id: originId,
    delivery: 'landed',
  });
  await work;
  await flush();
  expect(require('../src/services/outboxStore').outboxStore.snapshot().entries).toEqual([]);
  j.cleanup();
});
test('U13 an in-flight committed photo cannot discard staged bytes; cancelled proof removes them', async () => {
  const j = await connect(undefined, true),
    id = j.stream.sendTurn(originId, 'Synthetic photo')!;
  await j.stream.sendPhotoOutbox(id, [image]);
  const store = require('../src/services/outboxStore').outboxStore;
  const entry = store.snapshot().entries[0];
  const path = entry.attachments[0].staged_path;
  j.socket.outboundState = 'in_flight';
  await expect(j.stream.discardPhotoOutbox(id)).resolves.toBe(false);
  expect(mockDisk.has(path)).toBe(true);
  j.socket.outboundState = 'cancelled';
  await expect(j.stream.discardPhotoOutbox(id)).resolves.toBe(true);
  expect(mockDisk.has(path)).toBe(false);
  j.cleanup();
});
test('U12 an interrupted image resumes from its Documents copy after relaunch with a healthy first socket', async () => {
  const j=await connect(undefined,true),id=j.stream.sendTurn(originId,'Synthetic interrupted photo')!;
  j.socket.holdImageUploads=true;
  const work=j.stream.sendPhotoOutbox(id,[image]).catch(()=>undefined); await flush();
  expect(j.socket.frames('outbound.commit')).toHaveLength(1);
  const saved=require('../src/services/outboxStore').outboxStore.snapshot().entries[0];
  expect(saved).toMatchObject({kind:'photo',committed:true,uploaded:[]});
  mockDisk.delete(image.uri); j.socket.close(); await work; j.cleanup(); jest.resetModules();
  const fresh=await connect(undefined,true); await flush();
  expect(fresh.socket.frames('upload_blob_init')).toHaveLength(1);
  expect(fresh.socket.frames('outbound.commit')).toEqual([]); expect(fresh.socket.sends()).toEqual([]);
  expect(require('../src/services/outboxStore').outboxStore.snapshot().entries[0].uploaded).toEqual([saved.attachments[0].sha256]); fresh.cleanup();
});
