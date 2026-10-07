import {
  VoiceRecorder,
  type FinishedRecording,
  type RecordingEngine,
  type VoicePermission,
} from '../../src/services/voiceRecording';

// A recorder wired to a fake engine whose clock is Date.now (jest fake timers), so the
// overlay's segment clock and the recorder's own duration agree in tests.
export class FakeEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  permission: VoicePermission = 'granted';
  startedAt = 0;
  discarded = false;
  stopped = false;
  stopFails = false;
  async requestPermission() { return this.permission; }
  async getPermission() { return this.permission; }
  async start() { this.startedAt = Date.now(); }
  poll() { return { level: 0.5, durationMs: Date.now() - this.startedAt }; }
  async stop() {
    if (this.stopFails) throw new Error('stop_failed');
    this.stopped = true;
    return { uri: 'file:///tmp/p6-take.m4a', durationMs: Date.now() - this.startedAt, bytes: 1000 };
  }
  async discard() { this.discarded = true; }
}

export function makeRecorderHarness() {
  const engine = new FakeEngine();
  const recorder = new VoiceRecorder(engine);
  const stopped: FinishedRecording[] = [];
  recorder.subscribeStopped((take) => { stopped.push(take); });
  return { engine, recorder, stopped };
}
