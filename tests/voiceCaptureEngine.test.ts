import { AudioModule, setAudioModeAsync } from 'expo-audio';
import { NativeCaptureEngine } from '../src/services/voiceRecordingEngine';
import { VoiceRecorder, MAX_DURATION_MS, type Scheduler } from '../src/services/voiceRecording';
import type { CaptureStatus, NativeVoiceCapture } from '../modules/pentacle-voice-capture';
import { createVoiceQuestionSnapshot, updateVoiceQuestionPage, resetVoiceAnswersForTests, voiceQuestionSnapshot } from '../src/components/questions/voice/voiceAnswersBinding';
import vectors from '../modules/pentacle-voice-capture/contract/capture-contract-v1.json';

jest.mock('../src/services/voiceDelivery', () => ({ voiceDelivery: { setLifecycle: jest.fn() } }));
jest.mock('../src/services/pentacleStream', () => ({ subscribeVoiceTransport: jest.fn(), voiceTransportSnapshot: jest.fn() }));

beforeEach(() => resetVoiceAnswersForTests());

type Event = {
  type: string; nowMs: number; recordingId?: string; admission?: number; pauseEpoch?: number;
  capturedMs?: number; paddingMs?: number; success?: boolean; foreground?: boolean; protectedData?: boolean; sessionActive?: boolean; admissionGeneration?: number; shouldResume?: boolean;
};
type Pending = { kind: 'start' | 'resume'; recordingId: string; admission: number; pauseEpoch: number };
/** Independent executable fake of the public policy contract, shared by every
 * vector assertion below and all real-engine/controller tests in this file.
 * Only step() receives OS/clock events. getStatus() has no behavior or side effects.
 */
class CaptureContractModel {
  state: CaptureStatus['state'] = 'idle'; reason: string | null = null;
  recordingId: string | null = null; pauseEpoch = 0; capturedMs = 0;
  generation = 0; foreground = true; protectedData = true; sessionActive = false;
  lastRecord: Pending | null = null;
  private lastClock: number | null = null; private pending: Pending | null = null;
  private live() { return ['starting', 'recording', 'paused'].includes(this.state); }
  private cap() {
    this.state = 'capped'; this.reason = 'capped'; this.capturedMs = MAX_DURATION_MS;
    this.pending = null; this.lastClock = null; this.sessionActive = false;
    return ['stop', 'releaseSession'];
  }
  private pause(reason: string, force = false) {
    if (!this.live()) return [];
    if (force || this.state !== 'paused' || this.pending) this.pauseEpoch++;
    this.state = 'paused'; this.reason = reason; this.pending = null; this.lastClock = null; this.sessionActive = false;
    return ['pause', 'releaseSession'];
  }
  private refusal(id: string | null | undefined, admission: number | undefined, epoch: number | undefined, resuming: boolean) {
    if (id !== this.recordingId) return 'cancelled';
    if (this.state === 'interrupted') return 'recorder_reset';
    if (this.state === 'capped' || this.capturedMs >= MAX_DURATION_MS) return 'capped';
    if (admission !== undefined && admission !== this.generation) return 'cancelled';
    if (resuming && this.state !== 'paused') return 'not_paused';
    if (resuming && epoch !== this.pauseEpoch) return 'stale_epoch';
    if (!this.foreground) return 'not_foreground';
    if (!this.protectedData) return 'locked';
    return null;
  }
  step(event: Event) {
    const actions: string[] = []; let error: string | null = null;
    if (this.state === 'recording' && event.type !== 'settleCaptured' && event.type !== 'finished' && Number.isFinite(event.nowMs)) {
      this.capturedMs = Math.min(MAX_DURATION_MS, this.capturedMs + Math.max(0, event.nowMs - (this.lastClock ?? event.nowMs)));
      this.lastClock = Math.max(this.lastClock ?? event.nowMs, event.nowMs);
      if (this.capturedMs >= MAX_DURATION_MS) actions.push(...this.cap());
    }
    if (event.foreground !== undefined) this.foreground = event.foreground;
    if (event.protectedData !== undefined) this.protectedData = event.protectedData;
    if (event.sessionActive !== undefined) this.sessionActive = event.sessionActive;
    if (event.admissionGeneration !== undefined) this.generation = Math.max(this.generation, event.admissionGeneration);
    switch (event.type) {
      case 'revoke': if (event.admissionGeneration === undefined) this.generation++; break;
      case 'start': {
        if (!event.recordingId || event.admission === undefined || event.admission !== this.generation) { error = 'cancelled'; break; }
        if (this.live()) { error = 'not_paused'; break; }
        if (event.recordingId === this.recordingId) { error = 'cancelled'; break; }
        this.recordingId = event.recordingId; this.capturedMs = 0; this.pauseEpoch = 0; this.state = 'starting'; this.reason = null; this.lastClock = null;
        error = this.refusal(event.recordingId, event.admission, undefined, false);
        if (error) { actions.push(...this.pause(error)); break; }
        this.pending = { kind: 'start', recordingId: event.recordingId, admission: event.admission, pauseEpoch: 0 };
        actions.push('prepare', 'activateSession'); break;
      }
      case 'resume': {
        if (event.admission === undefined) { error = 'cancelled'; break; }
        error = this.refusal(event.recordingId, event.admission, event.pauseEpoch, true);
        if (error) break;
        if (this.pending || !this.recordingId) { error = 'cancelled'; break; }
        this.pending = { kind: 'resume', recordingId: this.recordingId, admission: event.admission, pauseEpoch: this.pauseEpoch };
        actions.push('activateSession'); break;
      }
      case 'startReady': case 'resumeReady': {
        const resuming = event.type === 'resumeReady'; const pending = this.pending;
        if (!pending || pending.kind !== (resuming ? 'resume' : 'start') || pending.recordingId !== this.recordingId || (event.recordingId !== undefined && event.recordingId !== this.recordingId)) {
          error = this.state === 'interrupted' ? 'recorder_reset' : this.state === 'capped' ? 'capped' : 'cancelled'; break;
        }
        error = this.refusal(pending.recordingId, pending.admission, pending.pauseEpoch, resuming) ?? (this.sessionActive ? null : 'session_failed');
        if (error) { actions.push(...this.pause(error)); break; }
        if (!resuming && this.state !== 'starting') { error = 'cancelled'; break; }
        this.lastRecord = { ...pending }; this.state = 'recording'; this.reason = null; this.pending = null; this.lastClock = event.nowMs;
        actions.push('record'); break;
      }
      case 'pause':
        if (event.recordingId !== undefined && event.recordingId !== this.recordingId) error = 'cancelled';
        else actions.push(...this.pause('user'));
        break;
      case 'interruptionBegan': case 'resignActive': case 'background': case 'lock': {
        if (event.admissionGeneration === undefined) this.generation++;
        if (event.type === 'resignActive' || event.type === 'background') this.foreground = false;
        if (event.type === 'lock') this.protectedData = false;
        const why = event.type === 'interruptionBegan' ? 'interruption' : event.type === 'lock' ? 'locked' : event.type === 'resignActive' ? 'inactive' : 'background';
        actions.push(...this.pause(why, true)); break;
      }
      case 'becameActive': this.foreground = true; break;
      case 'unlock': this.protectedData = true; break;
      case 'mediaReset':
        if (event.admissionGeneration === undefined) this.generation++;
        if (this.live()) {
          this.state = 'interrupted'; this.reason = 'recorder_reset'; this.pending = null; this.lastClock = null;
          this.pauseEpoch++; this.sessionActive = false; actions.push('stop', 'releaseSession');
        }
        break;
      case 'activationAborted': this.sessionActive = false; actions.push('pause', 'releaseSession'); break;
      case 'settleCaptured':
        if (event.capturedMs !== undefined && Number.isFinite(event.capturedMs) && event.capturedMs >= 0) {
          this.capturedMs = Math.min(MAX_DURATION_MS, Math.max(this.capturedMs, event.capturedMs));
          if (event.capturedMs > MAX_DURATION_MS && this.state !== 'discarded') {
            if (this.state === 'interrupted' && this.reason === 'capture_limit_exceeded') break;
            this.state = 'interrupted'; this.reason = 'capture_limit_exceeded'; this.pending = null; this.lastClock = null;
            this.pauseEpoch++; this.sessionActive = false; actions.push('stop', 'releaseSession'); break;
          }
          if (this.capturedMs >= MAX_DURATION_MS && this.live()) actions.push(...this.cap());
        }
        break;
      case 'finished': {
        if (this.state !== 'recording' && this.state !== 'capped') break;
        const alreadyStopped = this.state === 'capped';
        if (event.capturedMs !== undefined && Number.isFinite(event.capturedMs) && event.capturedMs >= 0) {
          this.capturedMs = Math.min(MAX_DURATION_MS, Math.max(this.capturedMs, event.capturedMs));
          if (event.success === true && event.capturedMs === MAX_DURATION_MS && event.paddingMs !== undefined
            && Number.isFinite(event.paddingMs) && event.paddingMs >= 0 && event.paddingMs <= 250) {
            if (!alreadyStopped) actions.push(...this.cap());
            break;
          }
        }
        this.state = 'interrupted'; this.reason = (event.capturedMs ?? 0) > MAX_DURATION_MS ? 'capture_limit_exceeded'
          : (event.paddingMs ?? 0) > 250 ? 'encoder_padding_exceeded' : 'recorder_reset';
        this.pending = null; this.lastClock = null; this.pauseEpoch++; this.sessionActive = false;
        actions.push(...(alreadyStopped ? ['releaseSession'] : ['stop', 'releaseSession'])); break;
      }
      case 'sessionFailed': case 'recordFailed':
        error = event.type === 'sessionFailed' ? 'session_failed' : 'resume_failed'; actions.push(...this.pause(error)); break;
      case 'stop':
        if (event.recordingId !== undefined && event.recordingId !== this.recordingId) { error = 'cancelled'; break; }
        if (this.live()) {
          this.state = 'stopped'; this.reason = null; this.pending = null; this.lastClock = null; this.sessionActive = false;
          actions.push('stop', 'releaseSession');
        } else if (['stopped', 'capped', 'interrupted'].includes(this.state)) actions.push('releaseSession');
        break;
      case 'discard':
        if (event.recordingId !== undefined && event.recordingId !== this.recordingId) { error = 'cancelled'; break; }
        if (this.state !== 'discarded' && this.state !== 'idle') {
          this.state = 'discarded'; this.reason = null; this.pending = null; this.lastClock = null; this.sessionActive = false;
          actions.push('stop', 'releaseSession');
        } else if (this.state === 'discarded') actions.push('releaseSession');
        break;
      case 'tick': case 'environment': case 'foreground': case 'interruptionEnded': case 'routeChanged': break;
      default: error = 'cancelled';
    }
    return { state: this.state, reason: this.reason, pauseEpoch: this.pauseEpoch, capturedMs: this.capturedMs, actions, error };
  }
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
class ContractNative implements NativeVoiceCapture {
  model = new CaptureContractModel(); nowMs = 0; actions: string[] = []; calls: string[] = [];
  gate: ReturnType<typeof deferred> | null = null; gateAt: 'queued' | 'activation' = 'activation';
  uri: string | null = null; prepares = 0; resumeEpochs: number[] = [];
  getCaptureContract = () => ({ contract: 'pentacle-voice-capture', revision: 1, nativeBuild: '101' });
  getStatus = (): CaptureStatus => ({ state: this.model.state, reason: this.model.reason, pauseEpoch: this.model.pauseEpoch,
    capturedMs: this.model.capturedMs, metering: -20, uri: this.uri, recordingId: this.model.recordingId });
  getAdmission = (_id: string) => this.model.generation;
  revokeAdmissions = (_id: string) => { this.calls.push('revoke'); this.event('revoke'); };
  getPermission = jest.fn(async () => ({ granted: true, canAskAgain: true }));
  requestPermission = jest.fn(async () => ({ granted: true, canAskAgain: true }));
  event(type: string, value: Partial<Event> = {}) {
    const result = this.model.step({ type, nowMs: this.nowMs, ...value }); this.actions.push(...result.actions);
    if (result.actions.includes('prepare')) { this.prepares++; this.uri = `file:///cache/capture-${this.prepares}.m4a`; }
    return result;
  }
  advance(ms: number) { this.nowMs += ms; this.event('tick'); }
  private async command(kind: 'start' | 'resume', id: string, admission: number, pauseEpoch?: number) {
    this.calls.push(kind);
    if (this.gate && this.gateAt === 'queued') await this.gate.promise;
    let result = this.event(kind, { recordingId: id, admission, pauseEpoch });
    if (result.error) throw new Error(result.error);
    if (this.gate && this.gateAt === 'activation') await this.gate.promise;
    result = this.event(kind === 'start' ? 'startReady' : 'resumeReady', { recordingId: id, sessionActive: true });
    if (result.error) { this.event('activationAborted'); throw new Error(result.error); }
    return this.getStatus();
  }
  start = (id: string, admission: number) => this.command('start', id, admission);
  resume = (id: string, epoch: number, admission: number) => { this.resumeEpochs.push(epoch); return this.command('resume', id, admission, epoch); };
  pause = async (id: string) => { this.calls.push('pause'); this.event('pause', { recordingId: id }); return this.getStatus(); };
  stop = async (id: string) => { this.calls.push('stop'); this.event('stop', { recordingId: id }); return this.getStatus(); };
  discard = async (id: string) => { this.calls.push('discard'); this.event('discard', { recordingId: id }); };
}
class ManualScheduler implements Scheduler {
  handler: (() => void) | null = null;
  setInterval(handler: () => void) { this.handler = handler; return 1; }
  clearInterval() { this.handler = null; }
  fire() { this.handler?.(); }
}
function fixture() {
  const native = new ContractNative(); const scheduler = new ManualScheduler();
  const engine = new NativeCaptureEngine(undefined, { module: () => native, contract: native.getCaptureContract, build: () => '101' });
  const ownership = {
    create: jest.fn(async (_stream: string, draft?: any) => ({ recordingId: 'take-store-owned-id', draft })),
    checkpoint: jest.fn().mockResolvedValue(undefined), finalize: jest.fn().mockResolvedValue(undefined), requestSend: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined), invalidate: jest.fn(), originAvailable: () => true,
  };
  const recorder = new VoiceRecorder(engine, scheduler, ownership);
  return { native, engine, recorder, scheduler, ownership };
}

for (const vector of vectors.vectors) test(`CAP-01 shared policy vector: ${vector.name}`, () => {
  const model = new CaptureContractModel();
  for (const step of vector.steps) {
    const event = step.event as Event; const generation = model.generation;
    const result = model.step(event);
    expect({ ...result, capturedMs: step.expect.capturedMs }).toEqual(step.expect);
    // JSON decimal clocks and JS/Swift binary floating-point subtraction differ
    // below a microsecond; state, actions, reason and error remain exact.
    expect(result.capturedMs).toBeCloseTo(step.expect.capturedMs, 6);
    expect(result.capturedMs).toBeLessThanOrEqual(MAX_DURATION_MS);
    if (result.actions.includes('record')) {
      expect(['startReady', 'resumeReady']).toContain(event.type);
      expect(result.error).toBeNull(); expect(model.foreground).toBe(true); expect(model.protectedData).toBe(true);
      expect(model.sessionActive).toBe(true); expect(model.generation).toBeGreaterThanOrEqual(generation);
      expect(model.lastRecord?.admission).toBe(model.generation);
      expect(model.lastRecord?.recordingId).toBe(model.recordingId);
      if (event.type === 'resumeReady') expect(model.lastRecord?.pauseEpoch).toBe(model.pauseEpoch);
    }
  }
});

test('CAP-01 NEW-CONTRACT PROBE: sealed begin/end-before-next-poll schedule stays paused', async () => {
  const { native, engine, recorder, scheduler, ownership } = fixture();
  await recorder.start('hosta:origin'); native.advance(2500);
  // The sealed Expo probe has this exact ordering: start, native begin, native
  // end(shouldResume), next JS tick. No JS callback runs between begin and end.
  native.event('interruptionBegan'); expect(native.model.state).toBe('paused');
  native.event('interruptionEnded', { shouldResume: true }); scheduler.fire();
  expect(native.actions.filter(action => action === 'record')).toHaveLength(1);
  expect(native.model.state).toBe('paused'); expect(recorder.snapshot()?.status).toBe('paused');
  expect(engine.poll()).toMatchObject({ interrupted: true, durationMs: 2500 });
  expect(ownership.requestSend).not.toHaveBeenCalled(); await flush(); await recorder.discard();
});

test.each([true, false])('CAP-01 begin/end between 90 ms polls (shouldResume=%s) stays paused until explicit Resume', async shouldResume => {
  const { native, engine, recorder, scheduler, ownership } = fixture();
  const takeId = await recorder.start('hosta:origin'); const id = native.getStatus().recordingId; const uri = engine.nativeUri;
  native.advance(15); native.event('interruptionBegan'); native.advance(5); native.event('interruptionEnded', { shouldResume });
  native.advance(70); // One complete begin/end schedule occurs before the next JS poll.
  expect(native.actions.filter(action => action === 'record')).toHaveLength(1);
  expect(native.getStatus()).toMatchObject({ state: 'paused', capturedMs: 15 });
  scheduler.fire(); await flush();
  expect(recorder.snapshot()).toMatchObject({ recordingId: takeId, status: 'paused', capturedAudioMs: 15 });
  native.advance(60000); scheduler.fire(); expect(recorder.capturedAudioMs()).toBe(15);
  expect(ownership.requestSend).not.toHaveBeenCalled();
  const epoch = native.model.pauseEpoch; await recorder.resume();
  expect(native.resumeEpochs).toEqual([epoch]); expect(native.prepares).toBe(1);
  expect(native.getStatus().recordingId).toBe(id); expect(engine.nativeUri).toBe(uri);
  native.advance(1000); scheduler.fire(); expect(recorder.capturedAudioMs()).toBe(1015);
  expect(AudioModule.AudioRecorder).not.toHaveBeenCalled(); expect(setAudioModeAsync).not.toHaveBeenCalled();
  await recorder.discard();
});

test.each(['pause', 'stop', 'discard'] as const)('CAP-01 %s revokes admissions as its first synchronous native effect', async action => {
  const { engine, native } = fixture(); await engine.start(); native.calls.length = 0;
  const work = engine[action](); expect(native.calls[0]).toBe('revoke'); await work;
});

test.each(['queued', 'activation'] as const)('CAP-01 native start %s then lifecycle pause records nothing', async gateAt => {
  const { native, recorder, ownership } = fixture(); native.gate = deferred(); native.gateAt = gateAt;
  const release = jest.fn(); const starting = recorder.start('hosta:origin', undefined, release).catch(error => error);
  await flush(); recorder.setLifecycle({ foreground: false, unlocked: false });
  expect(native.calls).toContain('revoke'); native.gate.resolve(); await starting; await flush();
  expect(native.actions).not.toContain('record'); expect(release).not.toHaveBeenCalled(); expect(ownership.requestSend).not.toHaveBeenCalled();
  await recorder.discard();
});

test.each(['queued', 'activation'] as const)('CAP-01 Send during %s native resume fences admission before pending work completes and sends once', async gateAt => {
  const { native, recorder, ownership } = fixture(); const release = jest.fn();
  const id = await recorder.start('hosta:origin', undefined, release); native.advance(1500); await recorder.pause();
  native.gate = deferred(); native.gateAt = gateAt;
  const resumed = recorder.resume().catch(error => error); await flush(); native.calls.length = 0;
  const sending = recorder.send(); const duplicate = recorder.send();
  expect(sending).toBe(duplicate); expect(native.calls[0]).toBe('revoke');
  native.gate.resolve(); expect(await resumed).toBeInstanceOf(Error); await sending;
  expect(native.actions.filter(action => action === 'record')).toHaveLength(1);
  expect(native.prepares).toBe(1); expect(ownership.finalize).toHaveBeenCalledTimes(1); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
  expect(ownership.requestSend).toHaveBeenCalledWith(expect.objectContaining({ recordingId: id, capturedAudioMs: 1500 }));
  expect(release).toHaveBeenCalledTimes(1); expect(ownership.discard).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test.each(['queued', 'activation'] as const)('CAP-01 X during %s native resume fences admission immediately and discards once', async gateAt => {
  const { native, recorder, ownership } = fixture(); await recorder.start('hosta:origin'); native.advance(1500); await recorder.pause();
  native.gate = deferred(); native.gateAt = gateAt;
  const resumed = recorder.resume().catch(error => error); await flush(); native.calls.length = 0;
  const discarded = recorder.discard(); expect(native.calls[0]).toBe('revoke'); expect(ownership.invalidate).toHaveBeenCalledTimes(1);
  native.gate.resolve(); await resumed; await discarded;
  expect(native.actions.filter(action => action === 'record')).toHaveLength(1); expect(ownership.discard).toHaveBeenCalledTimes(1);
  expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test.each(['recording', 'paused'] as const)('CAP-01 media reset while %s is retained terminal Interrupted, never Resume or automatic Send', async phase => {
  const { native, recorder, scheduler, ownership } = fixture(); const id = await recorder.start('hosta:origin'); native.advance(2100);
  if (phase === 'paused') await recorder.pause();
  native.event('mediaReset'); scheduler.fire();
  expect(recorder.snapshot()).toMatchObject({ recordingId: id, status: 'finalized', error: 'Interrupted. Send or Discard.', capturedAudioMs: 2100 });
  await expect(recorder.resume()).rejects.toThrow('cannot be resumed'); expect(native.resumeEpochs).toHaveLength(0);
  expect(ownership.requestSend).not.toHaveBeenCalled(); await recorder.send();
  expect(ownership.requestSend).toHaveBeenCalledTimes(1); expect(native.prepares).toBe(1);
});

test('CAP-01 reset first observed by Send or pause cannot bypass cancellation or reopen Resume after a save failure', async () => {
  const { native, recorder, ownership } = fixture(); await recorder.start('hosta:origin'); native.advance(1234); native.event('mediaReset');
  await recorder.pause(); expect(recorder.snapshot()?.status).toBe('finalized');
  ownership.finalize.mockRejectedValueOnce(new Error('disk'));
  await expect(recorder.send()).rejects.toThrow('disk'); expect(recorder.snapshot()?.status).toBe('finalized');
  await expect(recorder.resume()).rejects.toThrow('cannot be resumed');
  await recorder.send(); expect(ownership.requestSend).toHaveBeenCalledTimes(1); expect(native.prepares).toBe(1);
});

test('CAP-01 native cap finalizes while JS is stalled and excludes a long pause crossing the old wall deadline', async () => {
  const { native, recorder, scheduler, ownership } = fixture(); await recorder.start('hosta:origin');
  native.advance(299900); await recorder.pause(); native.advance(90000); scheduler.fire();
  expect(native.model.state).toBe('paused'); expect(native.model.capturedMs).toBe(299900);
  await recorder.resume(); native.advance(5000); // No JS poll drives the native cap.
  expect(native.getStatus()).toMatchObject({ state: 'capped', capturedMs: MAX_DURATION_MS });
  expect(native.actions.filter(action => action === 'record')).toHaveLength(2);
  scheduler.fire(); await flush(); expect(ownership.finalize).toHaveBeenCalledTimes(1);
  expect(ownership.finalize).toHaveBeenCalledWith(expect.objectContaining({ capturedAudioMs: MAX_DURATION_MS, sendRequested: false }));
  expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test.each(['queued', 'activation'] as const)('CAP-01 X during %s native start retains the composer draft and discards ownership once', async gateAt => {
  const { native, recorder, ownership } = fixture(); native.gate = deferred(); native.gateAt = gateAt;
  const release = jest.fn(); const draft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: 'Unchanged draft', images: [] };
  const starting = recorder.start('hosta:origin', draft, release).catch(error => error); await flush(); native.calls.length = 0;
  const discarded = recorder.discard(); expect(native.calls[0]).toBe('revoke');
  native.gate.resolve(); await starting; await expect(discarded).resolves.toBeUndefined();
  expect(native.actions).not.toContain('record'); expect(release).not.toHaveBeenCalled(); expect(draft.textPrefix).toBe('Unchanged draft');
  expect(ownership.discard).toHaveBeenCalledTimes(1); expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test.each(['queued', 'activation'] as const)('CAP-01 Send during %s native start records nothing and retains the untransferred draft', async gateAt => {
  const { native, recorder, ownership } = fixture(); native.gate = deferred(); native.gateAt = gateAt;
  const release = jest.fn(); const starting = recorder.start('hosta:origin', undefined, release).catch(error => error); await flush(); native.calls.length = 0;
  const sending = recorder.send().catch(error => error); expect(native.calls[0]).toBe('revoke');
  native.gate.resolve(); await starting; await sending;
  expect(native.actions).not.toContain('record'); expect(release).not.toHaveBeenCalled();
  expect(ownership.discard).toHaveBeenCalledTimes(1); expect(ownership.requestSend).not.toHaveBeenCalled(); expect(recorder.snapshot()).toBeNull();
});

test('CAP-01 failed session activation on Resume stays paused with the same file and actionable retry', async () => {
  const { native, engine, recorder, ownership } = fixture(); await recorder.start('hosta:origin'); await recorder.pause(); const uri = engine.nativeUri;
  const resume = jest.spyOn(native, 'resume').mockImplementationOnce(async () => { native.event('sessionFailed'); throw new Error('session_failed'); });
  await expect(recorder.resume()).rejects.toThrow('session_failed');
  expect(recorder.snapshot()).toMatchObject({ status: 'paused', error: 'Could not resume. Retry Resume, Send or Discard.' });
  expect(native.getStatus().state).toBe('paused'); expect(engine.nativeUri).toBe(uri); expect(native.prepares).toBe(1);
  expect(ownership.requestSend).not.toHaveBeenCalled(); resume.mockRestore(); await recorder.resume(); await recorder.discard();
});

test('CAP-01 paused controller consumes the native settled tail before checkpoint and Resume', async () => {
  const { native, recorder, scheduler, ownership } = fixture(); await recorder.start('hosta:origin'); native.advance(1250);
  const pause = native.pause;
  jest.spyOn(native, 'pause').mockImplementation(async id => {
    await pause(id); native.event('settleCaptured', { capturedMs: 1260.5 }); return native.getStatus();
  });
  await recorder.pause();
  expect(recorder.snapshot()).toMatchObject({ status: 'paused', capturedAudioMs: 1260.5 });
  expect(ownership.checkpoint).toHaveBeenLastCalledWith(expect.objectContaining({ capturedAudioMs: 1260.5 }), expect.any(String), undefined);
  native.advance(60000); scheduler.fire(); expect(recorder.capturedAudioMs()).toBe(1260.5);
  await recorder.resume(); expect(recorder.snapshot()?.capturedAudioMs).toBe(1260.5);
  await recorder.discard();
});

test.each(['direct Send', 'pause then Send', 'page change during pause', 'Send during pause', 'X during pause', 'short Resume during pause'])(
  'CAP-01 actual question binding uses settled audio boundary: %s', async schedule => {
    const { native, recorder, ownership } = fixture();
    const item = { key: 'question:0', question_id: 'q', notification_id: 'n', producer_stream_id: 'hosta:worker', surface_stream_id: 'hosta:origin', prompt: 'Synthetic question?' };
    const next = { ...item, key: 'question:1', question_id: 'q-next' };
    const draft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: '', images: [], operationKind: 'voice_answer' as const,
      questionBinding: createVoiceQuestionSnapshot([item, next], 2, item.key, [item.key, next.key]) };
    const id = await recorder.start('hosta:origin', draft);
    const short = schedule === 'short Resume during pause'; native.advance(short ? 800 : 1490);
    const settled = short ? 800 : 1510; const gate = deferred(); const pending = schedule.includes('during pause');
    const pause = native.pause;
    jest.spyOn(native, 'pause').mockImplementationOnce(async nativeId => {
      const paused = pause(nativeId); native.event('settleCaptured', { capturedMs: settled });
      await paused; if (pending) await gate.promise; return native.getStatus();
    });
    if (schedule === 'direct Send') await recorder.send();
    else {
      const paused = recorder.pause().catch(error => error); await flush();
      if (schedule === 'page change during pause') {
        updateVoiceQuestionPage(id, next.key, [item.key, next.key], recorder.capturedAudioMs());
        expect(voiceQuestionSnapshot(id)?.visits[0].endMs).toBe(1510);
      }
      const sending = schedule === 'Send during pause' ? recorder.send() : null;
      const discarding = schedule === 'X during pause' ? recorder.discard() : null;
      const resuming = short ? recorder.resume() : null;
      native.advance(60000); gate.resolve(); await paused;
      if (sending) await sending;
      else if (discarding) await discarding;
      else {
        if (resuming) { await resuming; native.advance(800); }
        const sent = recorder.send();
        if (short) await expect(sent).rejects.toThrow('No answers recorded'); else await sent;
      }
    }
    if (short || schedule === 'X during pause') {
      expect(ownership.discard).toHaveBeenCalledTimes(1); expect(ownership.requestSend).not.toHaveBeenCalled();
    } else {
      expect(ownership.discard).not.toHaveBeenCalled(); expect(ownership.requestSend).toHaveBeenCalledTimes(1);
      expect(ownership.requestSend).toHaveBeenCalledWith(expect.objectContaining({ capturedAudioMs: 1510,
        frozenAnswers: [{ ...item, segment: { start_s: 0, end_s: 1.5 } }] }));
    }
    expect(recorder.snapshot()).toBeNull(); expect(voiceQuestionSnapshot(id)).toBeUndefined();
  },
);

test('CAP-01 a failed first checkpoint closes question capture at the settled native pause boundary', async () => {
  const { native, recorder, ownership } = fixture();
  const item = { key: 'question:0', question_id: 'q', notification_id: 'n', producer_stream_id: 'hosta:worker', surface_stream_id: 'hosta:origin', prompt: 'Synthetic question?' };
  const draft = { originGeneration: 'generation-1', originLabel: 'Origin', textPrefix: '', images: [], operationKind: 'voice_answer' as const,
    questionBinding: createVoiceQuestionSnapshot([item], 1, item.key, [item.key]) };
  ownership.checkpoint.mockImplementationOnce(async () => { native.advance(1490); throw new Error('disk'); });
  const pause = native.pause;
  jest.spyOn(native, 'pause').mockImplementationOnce(async id => {
    const result = pause(id); native.event('settleCaptured', { capturedMs: 1510 }); await result; return native.getStatus();
  });
  await expect(recorder.start('hosta:origin', draft)).rejects.toThrow('disk');
  expect(recorder.snapshot()).toMatchObject({ status: 'paused', capturedAudioMs: 1510 });
  await recorder.send(); expect(ownership.requestSend).toHaveBeenCalledTimes(1); expect(ownership.discard).not.toHaveBeenCalled();
});
