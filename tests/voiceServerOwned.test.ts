import { connect, retain, flush, originId, mockDisk } from './helpers/outboxTransport';
test('U7 identity and frozen mandate persist before init; acknowledged server ownership never transcribes or sends', async () => {
  const j = await connect(undefined, true),
    take = await retain(j);
  await j.voiceDelivery.send(take.recordingId);
  await flush();
  const initial = j.socket.frames('upload_blob_init')[0];
  expect(initial.send_mandate).toMatchObject({
    request_id: expect.stringMatching(/^voice-send-/),
    original_request: { logical_id: take.recordingId },
    text_prefix: '',
  });
  expect(j.store.get(take.recordingId)).toMatchObject({
    serverMandate: { mandate: initial.send_mandate },
    delivery: { phase: 'server_owned' },
  });
  expect(j.socket.frames('transcribe_blob')).toEqual([]);
  expect(j.socket.sends()).toEqual([]);
  j.socket.outboundState = 'proved';
  j.socket.receiptState = 'landed';
  await j.voiceDelivery.drain();
  await flush();
  expect(j.store.get(take.recordingId)).toBeUndefined();
  expect(j.socket.sends()).toEqual([]);
  j.cleanup();
});
test('U8 a failed mandate retries on the client with the same identity and never commits a second mandate', async () => {
  const j = await connect(undefined, true),
    take = await retain(j);
  await j.voiceDelivery.send(take.recordingId);
  await flush();
  const original = j.socket.frames('upload_blob_init')[0].send_mandate;
  j.socket.outboundState = 'failed';
  j.socket.outboundCode = 'transcribe_unavailable';
  await j.voiceDelivery.drain();
  expect(j.voiceDelivery.snapshot().takes[0]).toMatchObject({
    status: 'failed',
    error: 'Transcription is unavailable right now. Try again in a moment.',
  });
  const retry = j.voiceDelivery.retry(take.recordingId);
  await flush();
  const sent = j.socket.sends()[0];
  j.socket.message({
    type: 'send.result',
    request_id: sent.request_id,
    to_stream_id: originId,
    delivery: 'landed',
  });
  await retry;
  await flush();
  expect(j.socket.sends()[0]).toMatchObject({
    request_id: original.request_id,
    msg_id: original.optimistic_id,
    message: 'spoken detail',
  });
  expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
  j.cleanup();
});
test('U8 an in-flight cancel retains audio and checking ownership, then resolves by receipt', async () => {
  const j = await connect(undefined, true),
    take = await retain(j);
  await j.voiceDelivery.send(take.recordingId);
  await flush();
  j.socket.outboundState = 'in_flight';
  await j.voiceDelivery.discard(take.recordingId);
  expect(j.store.get(take.recordingId)?.audio).toEqual(take.audio);
  expect(j.store.get(take.recordingId)?.delivery.phase).toBe('checking');
  j.socket.outboundState = 'proved';
  j.socket.receiptState = 'landed';
  await j.voiceDelivery.drain();
  await flush();
  expect(j.store.get(take.recordingId)).toBeUndefined();
  j.cleanup();
});
test('U7 capability advertised but server_send absent uses the identical pre-upload identity on the legacy path', async () => {
  const j = await connect(undefined, true),
    take = await retain(j);
  j.socket.serverSend = false;
  const sending = j.voiceDelivery.send(take.recordingId);
  await flush();
  const init = j.socket.frames('upload_blob_init')[0],
    send = j.socket.sends()[0];
  expect(init.send_mandate.request_id).toBe(send.request_id);
  expect(init.send_mandate.optimistic_id).toBe(send.msg_id);
  expect(j.socket.frames('transcribe_blob')).toHaveLength(1);
  j.socket.message({
    type: 'send.result',
    request_id: send.request_id,
    to_stream_id: originId,
    delivery: 'landed',
  });
  await sending;
  j.cleanup();
});
test('U8 not_landed rotates only the request after terminal failure, retaining logical/message ids and issuing no second mandate', async () => {
  const j = await connect(undefined, true),
    take = await retain(j);
  await j.voiceDelivery.send(take.recordingId);
  await flush();
  const original = j.socket.frames('upload_blob_init')[0].send_mandate;
  j.socket.outboundState = 'failed';
  j.socket.outboundCode = 'not_landed';
  await j.voiceDelivery.drain();
  const retry = j.voiceDelivery.retry(take.recordingId);
  await flush();
  const send = j.socket.sends()[0];
  expect(send.request_id).not.toBe(original.request_id);
  expect(send.msg_id).toBe(original.optimistic_id);
  expect(j.store.get(take.recordingId)?.sequence).toBe(2);
  expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
  j.socket.message({
    type: 'send.result',
    request_id: send.request_id,
    to_stream_id: originId,
    delivery: 'landed',
  });
  await retry;
  j.cleanup();
});
test('U7 an accepted init followed by an interrupted audio chunk resumes upload and repeats the exact mandate', async () => {
  const j=await connect(undefined,true),take=await retain(j); j.socket.holdAudioChunks=true;
  const sending=j.voiceDelivery.send(take.recordingId); await flush();
  const init=j.socket.frames('upload_blob_init')[0]; expect(init.send_mandate).toBeDefined();
  j.socket.close(); await sending; j.cleanup(); jest.resetModules();
  const fresh=await connect(undefined,true); await flush();
  // Foreground recovery honors the retained retry delay.
  jest.advanceTimersByTime(2000); await flush();
  expect(fresh.socket.frames('upload_blob_init')[0].send_mandate).toEqual(init.send_mandate);
  expect(fresh.store.get(take.recordingId)?.delivery.phase).toBe('server_owned');
  expect(fresh.socket.frames('transcribe_blob')).toEqual([]); expect(fresh.socket.sends()).toEqual([]); fresh.cleanup();
});

test('U8 repeated not_landed after server handoff rotates the latest client intent without another mandate', async () => {
  const j = await connect(undefined, true), take = await retain(j);
  try {
    await j.voiceDelivery.send(take.recordingId);
    await flush();
    const original = j.store.get(take.recordingId)!.serverMandate!;
    j.socket.outboundState = 'failed';
    j.socket.outboundCode = 'not_landed';
    await j.voiceDelivery.drain();
    await flush();
    const firstRetry = j.voiceDelivery.retry(take.recordingId);
    await flush();
    const second = j.socket.sends()[0];
    expect(second).toBeDefined();
    j.socket.receiptState = 'not_landed';
    j.socket.message({ type: 'send.result', request_id: second.request_id,
      to_stream_id: originId, delivery: 'not_landed' });
    await flush();
    await firstRetry;
    await j.voiceDelivery.checkAgain(take.recordingId);
    expect(j.store.get(take.recordingId)?.delivery.phase).toBe('not_landed');

    j.socket.receiptState = 'unknown';
    const nextRetry = j.voiceDelivery.retry(take.recordingId);
    await flush();
    expect(j.socket.sends()).toHaveLength(2);
    const third = j.socket.sends()[1];
    expect(third).toEqual({ ...second, request_id: expect.any(String) });
    expect(third.request_id).not.toBe(second.request_id);
    expect(j.store.get(take.recordingId)).toMatchObject({
      sequence: 3, serverMandate: original, serverMandateFailed: true,
      dispatchIntent: { sequence: 3, requestId: third.request_id },
    });
    expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
    expect(j.socket.frames('outbound.commit')).toEqual([]);
    j.socket.message({ type: 'send.result', request_id: third.request_id,
      to_stream_id: originId, delivery: 'landed' });
    await nextRetry;
    await flush();
    expect(j.store.get(take.recordingId)).toBeUndefined();
  } finally { j.cleanup(); }
});

test('U8 terminal server handoff respects the attempt limit before rotating', async () => {
  const initial = await connect(undefined, true), take = await retain(initial);
  initial.cleanup();
  // Hydrate the valid final sequence directly instead of exercising 999 retries.
  const path = [...mockDisk.keys()].find(p => p.endsWith('manifest.json')
    && JSON.parse(mockDisk.get(p)!.toString()).recordingId === take.recordingId)!;
  const manifest = JSON.parse(mockDisk.get(path)!.toString());
  mockDisk.set(path, Buffer.from(JSON.stringify({ ...manifest, sequence: 1000 })));
  const j = await connect(undefined, true);
  try {
    await j.voiceDelivery.send(take.recordingId);
    await flush();
    j.socket.outboundState = 'failed';
    j.socket.outboundCode = 'not_landed';
    await j.voiceDelivery.drain();
    await flush();
    const original = j.store.get(take.recordingId)!.serverMandate!;
    await j.voiceDelivery.retry(take.recordingId);
    expect(j.store.get(take.recordingId)).toMatchObject({
      sequence: 1000, serverMandate: original,
      delivery: { phase: 'failed', error: 'attempt_limit' },
    });
    // Pressing Retry again must not turn the exhausted handoff into another send.
    j.socket.receiptState = 'not_landed';
    const retryAgain = j.voiceDelivery.retry(take.recordingId);
    await flush();
    expect(j.socket.sends()).toEqual([]);
    await retryAgain;
    expect(j.store.get(take.recordingId)?.delivery).toMatchObject({
      phase: 'failed', error: 'attempt_limit',
    });
    expect(j.socket.sends()).toEqual([]);
    expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
  } finally { j.cleanup(); }
});

test.each(['server_owned', 'checking'] as const)('manual check reconciles %s mandate without a client dispatch intent', async phase => {
  const j = await connect(undefined, true), take = await retain(j);
  try {
    await j.voiceDelivery.send(take.recordingId);
    await flush();
    const retained = j.store.get(take.recordingId)!;
    const mandate = retained.serverMandate;
    // Install the valid pre-proof shape through the store writer, not a frozen snapshot.
    await (j.store as any).mutate(take.recordingId, (value: any) => ({
      ...value, dispatchIntent: undefined, delivery: { ...value.delivery, phase },
    }));
    expect(j.store.get(take.recordingId)?.dispatchIntent).toBeUndefined();
    const before = j.socket.frames('outbound.get').length;
    await Promise.all([j.voiceDelivery.checkAgain(take.recordingId), j.voiceDelivery.checkAgain(take.recordingId)]);
    await flush();
    expect(j.socket.frames('outbound.get').length).toBeGreaterThan(before);
    expect(j.store.get(take.recordingId)?.serverMandate).toEqual(mandate);
    expect(j.store.get(take.recordingId)?.dispatchIntent).toBeUndefined();
    j.socket.outboundState = 'proved'; j.socket.receiptState = 'landed';
    await j.voiceDelivery.checkAgain(take.recordingId); await flush();
    expect(j.store.get(take.recordingId)).toBeUndefined();
    expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
    expect(j.socket.frames('transcribe_blob')).toEqual([]);
    expect(j.socket.sends()).toEqual([]);
  } finally { j.cleanup(); }
});

test.each(['server_owned', 'checking'] as const)('manual %s lookup exposes authoritative failure without creating a client intent', async phase => {
  const j = await connect(undefined, true), take = await retain(j);
  try {
    await j.voiceDelivery.send(take.recordingId); await flush();
    await (j.store as any).mutate(take.recordingId, (value: any) => ({
      ...value, dispatchIntent: undefined, delivery: { ...value.delivery, phase },
    }));
    const original = j.store.get(take.recordingId)!;
    await j.voiceDelivery.checkAgain(take.recordingId);
    expect(j.store.get(take.recordingId)?.serverMandateFailed).toBeFalsy();
    j.socket.outboundState = 'failed'; j.socket.outboundCode = 'transcribe_unavailable';
    await j.voiceDelivery.checkAgain(take.recordingId); await flush();
    expect(j.voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'failed' });
    expect(j.store.get(take.recordingId)).toMatchObject({ serverMandateFailed: true, audio: original.audio, serverMandate: original.serverMandate });
    expect(j.store.get(take.recordingId)?.dispatchIntent).toBeUndefined();
    expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
    expect(j.socket.frames('transcribe_blob')).toEqual([]); expect(j.socket.sends()).toEqual([]);
  } finally { j.cleanup(); }
});
test('manual checking after in-flight cancel without client intent accepts late proof and never dispatches', async () => {
  const j = await connect(undefined, true), take = await retain(j);
  try {
    await j.voiceDelivery.send(take.recordingId); await flush();
    await (j.store as any).mutate(take.recordingId, (value: any) => ({ ...value, dispatchIntent: undefined }));
    j.socket.outboundState = 'in_flight';
    await j.voiceDelivery.discard(take.recordingId);
    expect(j.store.get(take.recordingId)?.delivery.phase).toBe('checking');
    await Promise.all([j.voiceDelivery.checkAgain(take.recordingId), j.voiceDelivery.checkAgain(take.recordingId)]);
    expect(j.store.get(take.recordingId)?.audio).toEqual(take.audio);
    j.socket.outboundState = 'proved'; j.socket.receiptState = 'landed';
    await j.voiceDelivery.checkAgain(take.recordingId); await flush();
    expect(j.store.get(take.recordingId)).toBeUndefined();
    expect(j.socket.frames('upload_blob_init')).toHaveLength(1);
    expect(j.socket.frames('transcribe_blob')).toEqual([]); expect(j.socket.sends()).toEqual([]);
  } finally { j.cleanup(); }
});
