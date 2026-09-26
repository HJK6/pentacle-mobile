import { logTelemetry, TELEMETRY_EVENTS } from 'pentacle-chat-core';

import type { VoiceRecordingAsset } from './voiceSendUnit';

// Module-level recording session. It lives OUTSIDE any React component so a take
// survives scrolling, keyboard changes and navigating to another chat (the
// "Recording · m:ss · Return" pill). One recording at a time per app process.
// (spec_pentacle_mobile__voice_input_thoth_transcription_2026_09 § Journey.)

export type VoicePermission = 'granted' | 'denied' | 'undetermined';

export type StopReason = 'tap' | 'interrupted' | 'background' | 'cap';

/** Real capture is behind this interface so the state machine is testable with
 * a fake (no device, no expo-audio). The adapter normalizes metering to [0,1]. */
export interface RecordingEngine {
  requestPermission(): Promise<VoicePermission>;
  getPermission(): Promise<VoicePermission>;
  start(): Promise<void>;
  /** Current normalized level [0,1] and elapsed ms since start. */
  poll(): { level: number; durationMs: number; interrupted?: boolean };
  stop(): Promise<{ uri: string; durationMs: number; bytes?: number }>;
  discard(): Promise<void>;
  /** Container mime of produced files (audio/mp4 for AAC/M4A). */
  readonly mime: string;
}

export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SAMPLE_INTERVAL_MS = 90;
export const DISPLAY_BARS = 46;
export const MAX_DURATION_MS = 5 * 60 * 1000; // 5-minute cap (§ Journey)

export interface ActiveRecording {
  streamId: string;
  recordingId: string;
  /** Full metering series (retained for the pending voice bubble downsample). */
  levels: number[];
  durationMs: number;
  status: 'recording' | 'stopping';
  error?: string;
}

export interface RecordingSnapshot {
  streamId: string;
  recordingId: string;
  levels: number[];
  /** Last DISPLAY_BARS levels for the live strip (filled from the right). */
  displayLevels: number[];
  durationS: number;
  status: 'recording' | 'stopping';
  error?: string;
}

export type FinishedRecording = VoiceRecordingAsset & { streamId: string; recordingId: string; levels: number[]; interrupted: boolean };

type Listener = (snapshot: RecordingSnapshot | null) => void;

export class PermissionDeniedError extends Error {
  constructor() {
    super('microphone_permission_denied');
    this.name = 'PermissionDeniedError';
  }
}

export class RecorderBusyError extends Error {
  constructor() {
    super('a_recording_is_already_active');
    this.name = 'RecorderBusyError';
  }
}

/**
 * The recording session controller. One instance is the app singleton
 * (`voiceRecorder`); tests construct their own with a fake engine + scheduler.
 */
export class VoiceRecorder {
  private engine: RecordingEngine;
  private scheduler: Scheduler;
  private active: ActiveRecording | null = null;
  private tick: unknown = null;
  private listeners = new Set<Listener>();
  private nextId = 0;
  private stoppedListeners = new Set<(take: FinishedRecording) => void>();
  private stopping: Promise<FinishedRecording> | null = null;
  private starting = false;

  subscribeStopped(listener: (take: FinishedRecording) => void): () => void {
    this.stoppedListeners.add(listener);
    return () => { this.stoppedListeners.delete(listener); };
  }

  constructor(engine: RecordingEngine, scheduler: Scheduler = globalScheduler) {
    this.engine = engine;
    this.scheduler = scheduler;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): RecordingSnapshot | null {
    const a = this.active;
    if (!a) return null;
    return {
      streamId: a.streamId,
      recordingId: a.recordingId,
      levels: a.levels,
      displayLevels: a.levels.slice(-DISPLAY_BARS),
      durationS: Math.floor(a.durationMs / 1000),
      status: a.status,
      error: a.error,
    };
  }

  isActive(): boolean {
    return this.active !== null;
  }

  activeStreamId(): string | null {
    return this.active?.streamId ?? null;
  }

  async ensurePermission(): Promise<VoicePermission> {
    const current = await this.engine.getPermission();
    if (current === 'granted' || current === 'denied') return current;
    return this.engine.requestPermission();
  }

  /**
   * Begin a recording bound to `streamId`. Rejects with PermissionDeniedError if
   * the mic is denied, or RecorderBusyError if one is already active elsewhere.
   */
  async start(streamId: string): Promise<string> {
    if (this.active || this.starting) throw new RecorderBusyError();
    this.starting = true;
    try {
    const permission = await this.ensurePermission();
    if (permission !== 'granted') throw new PermissionDeniedError();
    await this.engine.start();
    const recordingId = `rec-${Date.now()}-${this.nextId++}`;
    this.active = { streamId, recordingId, levels: [], durationMs: 0, status: 'recording' };
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_RECORD_STARTED, {
      stream_id: streamId,
      recording_id: recordingId,
    });
    this.tick = this.scheduler.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.emit();
    return recordingId;
    } finally { this.starting = false; }
  }

  private sample(): void {
    const a = this.active;
    if (!a || a.status !== 'recording') return;
    const { level, durationMs, interrupted } = this.engine.poll();
    a.levels.push(clamp01(level));
    a.durationMs = durationMs;
    if (interrupted) {
      void this.stop('interrupted').catch(() => undefined);
      return;
    }
    if (durationMs >= MAX_DURATION_MS) {
      // Auto-stop at the cap; the caller's onStop wiring handles the take.
      void this.stop('cap').catch(() => undefined);
      return;
    }
    this.emit();
  }

  /**
   * Stop capture and return the finished take. `reason` distinguishes a manual
   * tap from an interruption/background/cap stop (all are treated as a stop that
   * proceeds to upload/transcribe/send per § Journey).
   */
  stop(reason: StopReason): Promise<FinishedRecording> {
    if (this.stopping) return this.stopping;
    this.stopping = this.finishStop(reason).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async finishStop(reason: StopReason): Promise<FinishedRecording> {
    const a = this.active;
    if (!a) throw new Error('no_active_recording');
    a.status = 'stopping';
    this.emit();
    this.stopTick();
    let stopped: Awaited<ReturnType<RecordingEngine['stop']>>;
    try { stopped = await this.engine.stop(); }
    catch (error) {
      // Keep the take bound to its origin. A failed automatic stop pauses the
      // timer and exposes Retry-stop/Discard instead of looping at the cap.
      a.status = 'recording';
      a.error = 'Could not stop recording. Tap stop again or discard.';
      this.emit();
      throw error;
    }
    const { uri, durationMs, bytes } = stopped;
    const durationS = Math.max(1, Math.round((durationMs || a.durationMs) / 1000));
    const levels = a.levels.slice();
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_RECORD_STOPPED, {
      stream_id: a.streamId,
      recording_id: a.recordingId,
      reason,
      duration_s: durationS,
    });
    const recordingId = a.recordingId;
    this.active = null;
    this.emit();
    const take: FinishedRecording = {
      streamId: a.streamId,
      uri,
      mime: this.engine.mime,
      durationS,
      bytes,
      recordingId,
      levels,
      interrupted: reason !== 'tap' && reason !== 'cap',
    };
    for (const listener of this.stoppedListeners) listener(take);
    return take;
  }

  /** Discard the active take: drop the file, emit telemetry, clear state. */
  async discard(): Promise<void> {
    const a = this.active;
    if (!a || a.status === 'stopping') return;
    this.stopTick();
    await this.engine.discard();
    logTelemetry(TELEMETRY_EVENTS.CHAT_VOICE_RECORD_DISCARDED, {
      stream_id: a.streamId,
      recording_id: a.recordingId,
      duration_s: Math.floor(a.durationMs / 1000),
    });
    this.active = null;
    this.emit();
  }

  private stopTick(): void {
    if (this.tick != null) {
      this.scheduler.clearInterval(this.tick);
      this.tick = null;
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

const globalScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Downsample a metering series to `n` bars for the pending voice bubble. */
export function downsampleLevels(levels: number[], n: number): number[] {
  if (!levels.length) return Array.from({ length: n }, () => 0.2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    out.push(Math.max(...levels.slice(a, b)));
  }
  return out;
}

/** m:ss formatter matching the design original. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
