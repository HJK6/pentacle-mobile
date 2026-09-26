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

afterEach(() => setTelemetrySink(null));

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
  const started = events.find((e) => e.message === 'chat.voice.record_started');
  expect(started?.subsystem).toBe('mobile_voice');
  expect(started?.data).toMatchObject({ stream_id: 'hosta:a', recording_id: id });
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
  const stopped = events.find((e) => e.message === 'chat.voice.record_stopped');
  expect(stopped?.data.reason).toBe('cap');
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
  const stopped = events.find((e) => e.message === 'chat.voice.record_stopped');
  expect(stopped?.data).toMatchObject({ reason: 'tap', duration_s: 6 });
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
  expect(events.some((e) => e.message === 'chat.voice.record_discarded')).toBe(true);
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
  await Promise.resolve();
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
  await Promise.resolve();
  await Promise.resolve();
  expect(recorder.snapshot()?.error).toContain('Tap stop again or discard');
  expect(scheduler.handler).toBeNull();
  await recorder.stop('tap');
  expect(recorder.isActive()).toBe(false);
});
