import { uuid } from 'expo-modules-core';
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';

import {
  VoiceRecorder,
  PermissionDeniedError,
  RecorderBusyError,
  downsampleLevels,
  formatDuration,
  DISPLAY_BARS,
  MAX_DURATION_MS,
  SAMPLE_INTERVAL_MS,
  type RecordingEngine,
  type Scheduler,
  type VoicePermission,
} from '../src/services/voiceRecording';

class FakeEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  nativeUri: string | undefined = 'file:///cache/test-owned.m4a';
  permission: VoicePermission = 'granted';
  requested = false;
  started = false;
  stopped = false;
  discarded = false;
  level = 0.5;
  durationMs = 0;
  stopResult = { uri: 'file:///tmp/take.m4a', durationMs: 6000, bytes: 999 };

  async requestPermission() {
    this.requested = true;
    return this.permission;
  }
  async getPermission() {
    return this.permission === 'granted' || this.permission === 'denied'
      ? this.permission
      : 'undetermined';
  }
  async start() {
    this.started = true;
  }
  poll() {
    return { level: this.level, durationMs: this.durationMs };
  }
  async pause() {}
  async resume() {}
  async stop() {
    this.stopped = true;
    return this.stopResult;
  }
  async discard() {
    this.discarded = true;
  }
}

/** A scheduler whose single interval handler we fire manually per test. */
class ManualScheduler implements Scheduler {
  handler: (() => void) | null = null;
  ms = 0;
  cleared = false;
  setInterval(handler: () => void, ms: number) {
    this.handler = handler;
    this.ms = ms;
    return 1;
  }
  clearInterval() {
    this.cleared = true;
    this.handler = null;
  }
  fire() {
    this.handler?.();
  }
}

function capture() {
  const events: TelemetryPayload[] = [];
  setTelemetrySink((p) => events.push(p));
  return events;
}

beforeEach(() => { jest.spyOn(uuid, 'v4').mockReturnValue('efbc042e-ce76-48fb-8dfc-2606f46243dc'); });
afterEach(() => { setTelemetrySink(null); jest.restoreAllMocks(); });

test('start requires granted permission and emits record_started', async () => {
  const events = capture();
  const engine = new FakeEngine();
  const sched = new ManualScheduler();
  const rec = new VoiceRecorder(engine, sched);

  const id = await rec.start('hosta:a');
  expect(engine.started).toBe(true);
  expect(rec.isActive()).toBe(true);
  expect(rec.activeStreamId()).toBe('hosta:a');
  expect(sched.ms).toBe(SAMPLE_INTERVAL_MS);
  const started = events.find((e) => String(e.message) === 'voice_delivery:lifecycle' && e.data.state === 'started');
  expect(started?.subsystem).toBe('voice_delivery');
  expect(started?.data).toMatchObject({ recording_id: id, subsystem: 'voice_delivery', bug_ref: 'continuous_voice' });
});

test('undetermined permission is requested; denial rejects', async () => {
  const engine = new FakeEngine();
  engine.permission = 'undetermined';
  const rec = new VoiceRecorder(engine, new ManualScheduler());
  engine.permission = 'undetermined';
  // getPermission returns undetermined -> requestPermission is called; make it deny
  const denyEngine = new FakeEngine();
  denyEngine.permission = 'undetermined';
  denyEngine.requestPermission = async () => {
    denyEngine.requested = true;
    return 'denied';
  };
  const rec2 = new VoiceRecorder(denyEngine, new ManualScheduler());
  await expect(rec2.start('hosta:a')).rejects.toBeInstanceOf(PermissionDeniedError);
  expect(denyEngine.requested).toBe(true);
  expect(denyEngine.started).toBe(false);
});

test('a second start while active is refused', async () => {
  const rec = new VoiceRecorder(new FakeEngine(), new ManualScheduler());
  await rec.start('hosta:a');
  await expect(rec.start('hosta:b')).rejects.toBeInstanceOf(RecorderBusyError);
});

test('sampling appends levels and duration; snapshot keeps last DISPLAY_BARS', async () => {
  const engine = new FakeEngine();
  const sched = new ManualScheduler();
  const rec = new VoiceRecorder(engine, sched);
  await rec.start('hosta:a');
  for (let i = 0; i < DISPLAY_BARS + 10; i++) {
    engine.level = 0.3;
    engine.durationMs = (i + 1) * SAMPLE_INTERVAL_MS;
    sched.fire();
  }
  const snap = rec.snapshot()!;
  expect(snap.levels.length).toBe(DISPLAY_BARS + 10);
  expect(snap.displayLevels.length).toBe(DISPLAY_BARS);
  expect(snap.durationS).toBe(Math.floor(((DISPLAY_BARS + 10) * SAMPLE_INTERVAL_MS) / 1000));
});

test('reaching the cap auto-stops with reason cap', async () => {
  const events = capture();
  const engine = new FakeEngine();
  const sched = new ManualScheduler();
  const rec = new VoiceRecorder(engine, sched);
  await rec.start('hosta:a');
  engine.durationMs = MAX_DURATION_MS;
  sched.fire();
  // allow the async stop() to settle
  await new Promise((r) => setImmediate(r));
  expect(engine.stopped).toBe(true);
  expect(rec.isActive()).toBe(false);
  const stopped = events.find((e) => String(e.message) === 'voice_delivery:lifecycle' && e.data.state === 'finalized');
  expect(stopped?.data).toMatchObject({ stage: 'capture', state: 'finalized' });
});

test('stop(tap) returns the finished take and emits record_stopped', async () => {
  const events = capture();
  const engine = new FakeEngine();
  const rec = new VoiceRecorder(engine, new ManualScheduler());
  const id = await rec.start('hosta:a');
  const take = await rec.stop('tap');
  expect(take).toMatchObject({
    uri: 'file:///tmp/take.m4a',
    mime: 'audio/mp4',
    durationS: 6,
    bytes: 999,
    recordingId: id,
    interrupted: false,
  });
  expect(rec.isActive()).toBe(false);
  const stopped = events.find((e) => String(e.message) === 'voice_delivery:lifecycle' && e.data.state === 'finalized');
  expect(stopped?.data).toMatchObject({ stage: 'capture', state: 'finalized' });
});

test('an interrupted stop is flagged interrupted', async () => {
  const rec = new VoiceRecorder(new FakeEngine(), new ManualScheduler());
  await rec.start('hosta:a');
  const take = await rec.stop('interrupted');
  expect(take.interrupted).toBe(true);
});

test('discard drops the take and emits record_discarded', async () => {
  const events = capture();
  const engine = new FakeEngine();
  const rec = new VoiceRecorder(engine, new ManualScheduler());
  await rec.start('hosta:a');
  await rec.discard();
  expect(engine.discarded).toBe(true);
  expect(rec.isActive()).toBe(false);
  expect(events.some((e) => String(e.message) === 'voice_delivery:lifecycle' && e.data.state === 'cancelled')).toBe(true);
});

test('downsampleLevels and formatDuration', () => {
  expect(downsampleLevels([], 3)).toEqual([0.2, 0.2, 0.2]);
  expect(downsampleLevels([0.1, 0.9, 0.2, 0.8], 2)).toEqual([0.9, 0.8]);
  expect(formatDuration(0)).toBe('0:00');
  expect(formatDuration(9)).toBe('0:09');
  expect(formatDuration(75)).toBe('1:15');
});


test('cap delivers the finished take to the same stop subscriber exactly once', async () => {
  const engine = new FakeEngine();
  const sched = new ManualScheduler();
  const rec = new VoiceRecorder(engine, sched);
  const finished = jest.fn();
  rec.subscribeStopped(finished);
  await rec.start('hosta:origin');
  engine.durationMs = MAX_DURATION_MS;
  sched.handler?.();
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toHaveBeenCalledTimes(1);
  expect(finished).toHaveBeenCalledWith(expect.objectContaining({
    streamId: 'hosta:origin', uri: engine.stopResult.uri, interrupted: false,
  }));
});

test('overlapping stop taps share one native stop and one completed take', async () => {
  const engine = new FakeEngine();
  const recorder = new VoiceRecorder(engine, new ManualScheduler());
  const stopped = jest.spyOn(engine, 'stop');
  const finished = jest.fn();
  recorder.subscribeStopped(finished);
  await recorder.start('hosta:origin');
  const first = recorder.stop('tap');
  const second = recorder.stop('tap');
  expect(first).toBe(second);
  await first;
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(finished).toHaveBeenCalledTimes(1);
});

test('failed automatic stop stays visible for manual stop retry or discard without auto-looping', async () => {
  const engine = new FakeEngine();
  const scheduler = new ManualScheduler();
  const recorder = new VoiceRecorder(engine, scheduler);
  jest.spyOn(engine, 'stop').mockRejectedValueOnce(new Error('native stop failed'));
  await recorder.start('hosta:origin');
  engine.durationMs = MAX_DURATION_MS;
  scheduler.handler?.();
  await new Promise((resolve) => setImmediate(resolve));
  expect(recorder.snapshot()?.error).toContain('Tap stop again or discard');
  expect(scheduler.handler).toBeNull();
  await recorder.stop('tap');
  expect(recorder.isActive()).toBe(false);
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
async function flushCapture() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function owned() {
  const engine = new FakeEngine(); const scheduler = new ManualScheduler();
  const ownership = {
    create: jest.fn(async (_stream: string, draft?: any) => ({ recordingId: 'efbc042e-ce76-48fb-8dfc-2606f46243dc', draft })),
    checkpoint: jest.fn().mockResolvedValue(undefined), finalize: jest.fn().mockResolvedValue(undefined),
    requestSend: jest.fn().mockResolvedValue(undefined), discard: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(), originAvailable: jest.fn(() => true),
  };
  const recorder = new VoiceRecorder(engine, scheduler, ownership);
  return { recorder, engine, scheduler, ownership };
}

test('R11 pause freezes captured milliseconds; explicit resume uses same live take and never starts again', async () => {
  const { recorder, engine, ownership } = owned(); const start = jest.spyOn(engine, 'start'); const resume = jest.spyOn(engine, 'resume');
  const id = await recorder.start('hosta:origin'); engine.durationMs = 1400;
  await recorder.pause('background'); engine.durationMs = 61400;
  expect(recorder.capturedAudioMs()).toBe(1400);
  expect(recorder.snapshot()).toMatchObject({ recordingId: id, status: 'paused', capturedAudioMs: 1400 });
  await recorder.resume(); expect(start).toHaveBeenCalledTimes(1); expect(resume).toHaveBeenCalledTimes(1);
  expect(ownership.requestSend).not.toHaveBeenCalled(); await recorder.discard();
});

test('R11 unlock and foreground never automatically resume; locked Resume is refused', async () => {
  const { recorder, engine } = owned(); const resume = jest.spyOn(engine, 'resume');
  await recorder.start('hosta:origin'); recorder.setLifecycle({ foreground: false, unlocked: false }); await flushCapture();
  await expect(recorder.resume()).rejects.toThrow('Unlock');
  recorder.setLifecycle({ foreground: true, unlocked: true }); await flushCapture();
  expect(recorder.snapshot()?.status).toBe('paused'); expect(resume).not.toHaveBeenCalled();
  await recorder.resume(); expect(resume).toHaveBeenCalledTimes(1); await recorder.discard();
});

test('R10 storage ownership failure never starts native capture', async () => {
  const { recorder, engine, ownership } = owned(); ownership.create.mockRejectedValueOnce(new Error('storage_full'));
  await expect(recorder.start('hosta:origin')).rejects.toThrow('storage_full');
  expect(engine.started).toBe(false); expect(recorder.isActive()).toBe(false);
});

test('R10 Discard during permission prevents a late native start', async () => {
  const { recorder, engine, ownership } = owned(); const permission = deferred<VoicePermission>();
  jest.spyOn(engine, 'getPermission').mockReturnValueOnce(permission.promise);
  const start = recorder.start('hosta:origin').catch(error => error);
  await flushCapture(); const discard = recorder.discard(); permission.resolve('granted'); await discard;
  expect((await start).message).toBe('voice_cancelled'); expect(engine.started).toBe(false); expect(ownership.create).not.toHaveBeenCalled();
});

test('R10 Discard during ownership write cleans only that new take and cannot record', async () => {
  const { recorder, engine, ownership } = owned(); const creation = deferred<{ recordingId: string }>();
  ownership.create.mockReturnValueOnce(creation.promise as any);
  const start = recorder.start('hosta:origin').catch(error => error); await flushCapture();
  const discard = recorder.discard(); creation.resolve({ recordingId: 'efbc042e-ce76-48fb-8dfc-2606f46243dc' }); await discard;
  expect((await start).message).toBe('voice_cancelled'); expect(engine.started).toBe(false); expect(ownership.discard).toHaveBeenCalledTimes(1);
});

test('R11 background pause preempts a pending ownership checkpoint without waiting on disk', async () => {
  const { recorder, engine, ownership } = owned(); const checkpoint = deferred<void>(); const pause = jest.spyOn(engine, 'pause');
  ownership.checkpoint.mockReturnValueOnce(checkpoint.promise);
  const start = recorder.start('hosta:origin').catch(error => error); await flushCapture();
  recorder.setLifecycle({ foreground: false, unlocked: false });
  expect(pause).toHaveBeenCalledTimes(1); expect(recorder.snapshot()?.status).toBe('paused');
  checkpoint.resolve(); await start; await flushCapture(); expect(ownership.requestSend).not.toHaveBeenCalled(); await recorder.discard();
});

test('R10 X during finalization fences Send immediately and waits for native close before cleanup', async () => {
  const { recorder, engine, ownership } = owned(); const stopped = deferred<typeof engine.stopResult>();
  jest.spyOn(engine, 'stop').mockReturnValueOnce(stopped.promise);
  await recorder.start('hosta:origin'); const send = recorder.send().catch(error => error); await flushCapture();
  const discard = recorder.discard(); expect(ownership.invalidate).toHaveBeenCalledTimes(1); expect(ownership.discard).not.toHaveBeenCalled();
  stopped.resolve(engine.stopResult); await discard; expect((await send).message).toBe('voice_cancelled');
  expect(ownership.requestSend).not.toHaveBeenCalled(); expect(ownership.discard).toHaveBeenCalledTimes(1); expect(recorder.snapshot()).toBeNull();
});

test('R10 duplicate Send shares one native stop and durable request', async () => {
  const { recorder, engine, ownership } = owned(); const stop = jest.spyOn(engine, 'stop');
  await recorder.start('hosta:origin'); const first = recorder.send(); const second = recorder.send(); expect(first).toBe(second); await first;
  expect(stop).toHaveBeenCalledTimes(1); expect(ownership.finalize).toHaveBeenCalledTimes(1); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
});

test('R12 cap finalizes durable unsent without requesting Send', async () => {
  const { recorder, engine, scheduler, ownership } = owned(); const stop = jest.spyOn(engine, 'stop');
  await recorder.start('hosta:origin'); engine.durationMs = MAX_DURATION_MS; scheduler.fire();
  await recorder.stop('cap'); expect(stop).toHaveBeenCalledTimes(1); expect(ownership.finalize).toHaveBeenCalledTimes(1);
  expect(ownership.finalize.mock.calls[0][0]).toMatchObject({ capturedAudioMs: MAX_DURATION_MS, sendRequested: false });
  expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test('R10 failed audio adoption retains native stop result so Retry does not stop twice', async () => {
  const { recorder, engine, ownership } = owned(); const stop = jest.spyOn(engine, 'stop'); ownership.finalize.mockRejectedValueOnce(new Error('disk'));
  await recorder.start('hosta:origin'); await expect(recorder.send()).rejects.toThrow('disk');
  expect(recorder.snapshot()?.status).toBe('finalized'); await recorder.send();
  expect(stop).toHaveBeenCalledTimes(1); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
});

test('R11 authoritative origin replacement blocks Resume and preserves recording', async () => {
  const { recorder, ownership } = owned(); await recorder.start('hosta:origin'); await recorder.pause();
  ownership.originAvailable.mockReturnValue(false); await expect(recorder.resume()).rejects.toThrow('Original chat unavailable');
  expect(recorder.isActive()).toBe(true); expect(ownership.requestSend).not.toHaveBeenCalled(); await recorder.discard();
});

test('R12 explicit Send racing cap finalization still durably requests exactly one send', async () => {
  const { recorder, engine, scheduler, ownership } = owned(); const finalized = deferred<void>();
  ownership.finalize.mockReturnValueOnce(finalized.promise); const stop = jest.spyOn(engine, 'stop');
  await recorder.start('hosta:origin'); engine.durationMs = MAX_DURATION_MS; scheduler.fire(); await flushCapture();
  const send = recorder.send(); finalized.resolve(); await send;
  expect(stop).toHaveBeenCalledTimes(1); expect(ownership.finalize).toHaveBeenCalledTimes(1); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
});
test('R10 failed start checkpoint keeps composer draft; explicit recovery sends owned snapshot and releases once', async () => {
  const { recorder, ownership } = owned(); const release = jest.fn(); ownership.checkpoint.mockRejectedValueOnce(new Error('disk'));
  const draft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: 'original', images: [] };
  await expect(recorder.start('hosta:origin', draft, release)).rejects.toThrow('disk'); draft.textPrefix = 'newer edit';
  expect(release).not.toHaveBeenCalled(); expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()?.status).toBe('paused');
  await recorder.send(); expect(release).toHaveBeenCalledTimes(1); expect(ownership.requestSend.mock.calls[0][0].draft.textPrefix).toBe('original');
});

test('CAP-02 Send preempts native capture while the initial checkpoint is pending; lock preserves exactly one stop and send', async () => {
  const { recorder, engine, ownership } = owned(); const checkpoint = deferred<void>();
  const pause = jest.spyOn(engine, 'pause'); const stop = jest.spyOn(engine, 'stop');
  ownership.checkpoint.mockReturnValueOnce(checkpoint.promise);
  const starting = recorder.start('hosta:origin').catch(error => error); await flushCapture();
  const sending = recorder.send(); expect(pause).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
  recorder.setLifecycle({ foreground: false, unlocked: false }); expect(pause).toHaveBeenCalledTimes(2);
  recorder.setLifecycle({ foreground: true, unlocked: false });
  checkpoint.resolve(); await starting; await sending;
  expect(stop).toHaveBeenCalledTimes(1); expect(ownership.finalize).toHaveBeenCalledTimes(1); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
});
test('MOB-03 Discard carries native URI across a cancelled first checkpoint and retryable tombstone failure', async () => {
  const { recorder, engine, ownership } = owned(); const checkpoint = deferred<void>();
  ownership.checkpoint.mockReturnValueOnce(checkpoint.promise);
  jest.spyOn(engine, 'discard').mockImplementation(async () => { engine.nativeUri = undefined; });
  const starting = recorder.start('hosta:origin').catch(error => error); await flushCapture();
  ownership.discard.mockRejectedValueOnce(new Error('tombstone failed'));
  const discard = recorder.discard().catch(error => error); checkpoint.resolve(); await starting; expect((await discard).message).toBe('tombstone failed');
  expect(recorder.snapshot()?.status).toBe('paused'); expect(engine.nativeUri).toBeUndefined();
  expect(ownership.discard).toHaveBeenLastCalledWith(expect.any(String), { nativeUri: 'file:///cache/test-owned.m4a' });
  await recorder.discard(); expect(ownership.discard).toHaveBeenLastCalledWith(expect.any(String), { nativeUri: 'file:///cache/test-owned.m4a' });
  expect(recorder.snapshot()).toBeNull();
});
