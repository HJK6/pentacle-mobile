import { voiceLifecycle } from './voiceTakeStore';
import { createVoiceContext, appendVoiceContext, finalizeVoiceContext, voiceContextPageSnapshot, subscribeVoiceContextPage, type VoiceContextV1 } from './voiceContext';
import { uuid } from 'expo-modules-core';
import type { ProcessedAsset } from './imageCapture';
import type { VoiceRecordingAsset } from './voiceSendUnit';
import {
  startVoiceQuestionSession, updateVoiceQuestionCapture, voiceQuestionSnapshot, refreshVoiceQuestionSession,
  freezeVoiceQuestionAnswers, completeVoiceQuestionSession,
  type VoiceQuestionSessionSnapshot, type VoiceAnswersItem,
} from '../components/questions/voice/voiceAnswersBinding';

export type VoicePermission = 'granted' | 'denied' | 'undetermined';
export type StopReason = 'tap' | 'interrupted' | 'background' | 'cap';
export type PauseReason = 'background' | 'locked' | 'interrupted' | 'origin' | 'storage';
export type CapturePhase = 'starting' | 'recording' | 'paused' | 'stopping' | 'finalized';
export interface RecordingEngine {
  requestPermission(): Promise<VoicePermission>;
  getPermission(): Promise<VoicePermission>;
  start(isCurrent?: () => boolean): Promise<void>;
  pause(): Promise<void>;
  resume(isCurrent?: () => boolean): Promise<void>;
  poll(): { level: number; durationMs: number; interrupted?: boolean; capped?: boolean };
  stop(): Promise<{ uri: string; durationMs: number; bytes?: number }>;
  /** Stops/disarms only. The take repository exclusively deletes owned assets. */
  discard(): Promise<void>;
  readonly mime: string;
  readonly nativeUri?: string;
}
export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export const SAMPLE_INTERVAL_MS = 90;
export const DISPLAY_BARS = 46;
export const MAX_DURATION_MS = 300000;
export interface RecordingDraft {
  originGeneration: string | null;
  originLabel: string;
  textPrefix: string;
  images: ProcessedAsset[];
  operationKind?: 'voice_chat' | 'voice_answer';
  questionBinding?: VoiceQuestionSessionSnapshot;
}
export interface RecordingSnapshot {
  streamId: string; recordingId: string; originLabel: string;
  levels: number[]; displayLevels: number[]; durationS: number; capturedAudioMs: number;
  status: CapturePhase; pauseReason?: PauseReason; error?: string;
  context_v1?: VoiceContextV1;
}
export type FinishedRecording = VoiceRecordingAsset & {
  draft?: RecordingDraft; streamId: string; recordingId: string; levels: number[]; interrupted: boolean;
  capturedAudioMs?: number; reason?: StopReason; sendRequested?: boolean;
  questionBinding?: VoiceQuestionSessionSnapshot; frozenAnswers?: VoiceAnswersItem[]; context_v1?: VoiceContextV1;
};
export interface RecordingOwnership {
  /** Opaque auth/server identity captured synchronously before any permission wait. */
  captureScope?(): string;
  create(streamId: string, draft?: RecordingDraft, expectedScope?: string): Promise<{ recordingId: string; draft?: RecordingDraft }>;
  checkpoint(snapshot: RecordingSnapshot, nativeUri?: string, questionBinding?: VoiceQuestionSessionSnapshot): Promise<void>;
  finalize(take: FinishedRecording): Promise<void>;
  requestSend(take: FinishedRecording): Promise<void>;
  invalidate?(recordingId: string): void;
  discard(recordingId: string, options?: { nativeUri?: string }): Promise<void>;
  ownsScope?(recordingId: string): boolean;
  originAvailable(streamId: string, generation?: string | null, recordingId?: string): boolean;
}
type ActiveRecording = {
  draft?: RecordingDraft; streamId: string; recordingId: string; levels: number[];
  durationMs: number; status: CapturePhase; pauseReason?: PauseReason; error?: string;
  finished?: FinishedRecording;
  context_v1?: VoiceContextV1; stopContextObservation?: () => void;
  nativeInterrupted?: boolean;
  discardUri?: string;
  releaseDraft?: () => void; draftTransferred?: boolean;
};
type Listener = (snapshot: RecordingSnapshot | null) => void;
export class CaptureUnsupportedError extends Error {
  readonly code = 'capture_unsupported';
  constructor() { super('Voice recording requires an updated iPhone app.'); this.name = 'CaptureUnsupportedError'; }
}
export class PermissionDeniedError extends Error { constructor() { super('microphone_permission_denied'); this.name = 'PermissionDeniedError'; } }
export class RecorderBusyError extends Error { constructor() { super('a_recording_is_already_active'); this.name = 'RecorderBusyError'; } }
export class NoVoiceAnswersError extends Error { constructor() { super('No answers recorded. Take discarded.'); this.name = 'NoVoiceAnswersError'; } }
const cancelled = () => new Error('voice_cancelled');
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One process owner. Route mounts never participate in capture eligibility. */
export class VoiceRecorder {
  private active: ActiveRecording | null = null;
  private tick: unknown = null;
  private listeners = new Set<Listener>();
  private stoppedListeners = new Set<(take: FinishedRecording) => void>();
  private starting = false;
  private stopping: Promise<FinishedRecording> | null = null;
  private sendAfterStop = false;
  private resuming: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private checkpointPending = false;
  private checkpointAt = 0;
  private lifecycle = { foreground: true, unlocked: true };
  constructor(private engine: RecordingEngine, private scheduler: Scheduler = globalScheduler, private ownership?: RecordingOwnership) {}
  subscribeStopped(listener: (take: FinishedRecording) => void) { this.stoppedListeners.add(listener); return () => { this.stoppedListeners.delete(listener); }; }
  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener); }; }
  snapshot(): RecordingSnapshot | null {
    const a = this.active; if (!a) return null;
    return { streamId: a.streamId, recordingId: a.recordingId, originLabel: a.draft?.originLabel || 'Chat',
      levels: a.levels.slice(), displayLevels: a.levels.slice(-DISPLAY_BARS), durationS: Math.floor(a.durationMs / 1000), capturedAudioMs: a.durationMs,
      status: a.status, pauseReason: a.pauseReason, error: a.error, ...(a.context_v1 ? { context_v1: a.context_v1 } : {}) };
  }
  isActive() { return this.active !== null || this.starting; }
  isOwnedByCurrentScope(recordingId: string) { return this.ownership?.ownsScope?.(recordingId) ?? true; }
  activeStreamId() { return this.active?.streamId ?? null; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const work = this.tail.catch(() => undefined).then(fn); this.tail = work; return work; }
  private current(epoch: number, a?: ActiveRecording) { return epoch === this.epoch && (!a || this.active === a); }
  private guard(epoch: number, a?: ActiveRecording) { if (!this.current(epoch, a)) throw cancelled(); }
  private ready(a?: ActiveRecording) {
    return this.lifecycle.foreground && this.lifecycle.unlocked && (!a || !this.ownership || this.ownership.originAvailable(a.streamId, a.draft?.originGeneration, a.recordingId));
  }
  setLifecycle(value: { foreground: boolean; unlocked: boolean }) {
    const changed = value.foreground !== this.lifecycle.foreground || value.unlocked !== this.lifecycle.unlocked;
    this.lifecycle = { ...value };
    if (changed && (!value.foreground || !value.unlocked) && (this.active || this.starting)) {
      void this.pause(!value.foreground ? 'background' : 'locked').catch(() => undefined);
    }
    // Unlock/foreground only changes eligibility. Resume is always an explicit command.
  }
  checkOrigin() {
    const a = this.active;
    if (a) { this.emit(); refreshVoiceQuestionSession(a.recordingId); }
    const available = !a || !this.ownership || this.ownership.originAvailable(a.streamId, a.draft?.originGeneration, a.recordingId);
    if (a?.status === 'paused' && a.pauseReason === 'origin') {
      if (available) { a.pauseReason = undefined; a.error = undefined; this.emit(); }
      return;
    }
    if (a && !available) {
      void this.pause('origin').catch(() => undefined);
    }
  }
  async ensurePermission(checkScope: () => void = () => {}): Promise<VoicePermission> {
    const epoch = this.epoch; checkScope();
    const permission = await this.engine.getPermission(); this.guard(epoch); checkScope();
    if (permission !== 'undetermined') return permission;
    const requested = await this.engine.requestPermission(); this.guard(epoch); checkScope(); return requested;
  }
  start(streamId: string, draft?: RecordingDraft, releaseDraft?: () => void): Promise<string> {
    if (this.active || this.starting) return Promise.reject(new RecorderBusyError());
    let capturedScope: string | undefined;
    try { capturedScope = this.ownership?.captureScope?.(); }
    catch (error) { return Promise.reject(error); }
    const scopeMatches = () => {
      try { return !this.ownership?.captureScope || this.ownership.captureScope() === capturedScope; }
      catch { return false; }
    };
    const checkScope = () => { if (!scopeMatches()) throw new Error('Account or connection changed. Start recording again.'); };
    this.starting = true; const epoch = ++this.epoch;
    const capturedDraft = draft ? copy(draft) : undefined;
    return this.serial(async () => {
      let created: { recordingId: string; draft?: RecordingDraft } | undefined;
      let nativeStarted = false;
      try {
        this.guard(epoch); if (!this.ready()) throw new Error('Unlock the app before recording.');
        const permission = await this.ensurePermission(checkScope); this.guard(epoch); checkScope();
        if (permission !== 'granted') throw new PermissionDeniedError();
        created = this.ownership ? await this.ownership.create(streamId, capturedDraft, capturedScope) : { recordingId: uuid.v4(), draft: capturedDraft };
        this.guard(epoch); checkScope();
        const a: ActiveRecording = { streamId, recordingId: created.recordingId, draft: created.draft ?? capturedDraft, durationMs: 0, levels: [], status: 'starting', releaseDraft };
        this.active = a; this.checkpointAt = 0;
        if (a.draft?.questionBinding) startVoiceQuestionSession(a.recordingId, a.draft.questionBinding);
        this.emit();
        await this.engine.start(() => this.current(epoch, a) && this.ready(a) && scopeMatches()); nativeStarted = true; this.guard(epoch, a); checkScope();
        if (process.env.EXPO_PUBLIC_HARNESS === '1') require('../utils/m1Diagnostic').m1Diagnostic('recorder_started', { origin: 'engine_started', stream_id: streamId, operation_kind: capturedDraft?.operationKind ?? 'voice_chat' });
        a.status = 'recording';
        // Capture begins after native arming; permission/arming dwell has no visits.
        // Legacy segmented takes retain their existing binding-only behavior.
        if (a.draft?.operationKind !== 'voice_answer') {
          a.context_v1 = createVoiceContext(voiceContextPageSnapshot());
          a.stopContextObservation = subscribeVoiceContextPage(() => this.sampleContext(a));
        }
        this.startTick(); this.emit();
        if (this.ownership) { await this.ownership.checkpoint(this.snapshot()!, this.engine.nativeUri, voiceQuestionSnapshot(a.recordingId)); this.guard(epoch, a); }
        this.transferDraft(a);
        this.telemetry(a.recordingId, 'started');
        return a.recordingId;
      } catch (error) {
        if (nativeStarted && this.active?.recordingId === created?.recordingId) {
          // A failed ownership checkpoint cannot release the draft. Keep the take visibly paused.
          if (this.current(epoch)) {
            const held = this.active!;
            held.status = 'paused'; held.pauseReason = 'storage'; held.error = 'Could not save recording. Retry Send or Discard.'; this.stopTick();
            try { await this.engine.pause(); this.settleNativePause(held); }
            catch { if (this.active === held && !held.nativeInterrupted) updateVoiceQuestionCapture(held.recordingId, held.durationMs, 'paused'); }
            this.emit();
          }
        } else if (created) {
          const nativeUri = this.active?.discardUri ?? this.engine.nativeUri;
          if (this.active?.recordingId === created.recordingId) this.active.discardUri = nativeUri;
          try {
            await this.engine.discard();
            if (this.ownership) await this.ownership.discard(created.recordingId, { nativeUri });
            this.active?.stopContextObservation?.();
            completeVoiceQuestionSession(created.recordingId, 'discarded');
            if (this.active?.recordingId === created.recordingId) { this.active = null; this.emit(); }
          } catch {
            // A failed tombstone/cleanup keeps the only URI handoff retryable.
            if (this.active?.recordingId === created.recordingId) {
              this.active.status = 'paused'; this.active.error = 'Could not discard recording. Try again.'; this.emit();
            }
          }
        }
        throw error;
      } finally { this.starting = false; }
    });
  }
  capturedAudioMs(): number {
    const a = this.active; if (!a) return 0;
    if (a.status === 'recording' || a.status === 'paused') {
      try {
        const status = this.engine.poll();
        // A published native pause includes its settled capture tail, even when
        // the pause promise has not reached JS yet. Never count paused wall time.
        if (a.status === 'recording' || status.interrupted || status.capped) {
          a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, status.durationMs || 0));
          if (a.status === 'paused' && status.interrupted) updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused');
        }
      } catch (error) { if (!this.consumeNativeReset(error, a)) throw error; }
    }
    return a.durationMs;
  }
  private sampleContext(a: ActiveRecording) {
    if (this.active !== a || a.status !== 'recording' || !a.context_v1 || !this.ready(a)) return;
    try {
      const status = this.engine.poll();
      // Native pause/reset may precede the JS lifecycle notification. Its page
      // cannot be recorded while capture is stopped, even if JS says recording.
      if (status.interrupted || status.capped) return;
      a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, status.durationMs || 0));
      a.context_v1 = appendVoiceContext(a.context_v1, voiceContextPageSnapshot(), a.durationMs);
    } catch (error) { if (!this.consumeNativeReset(error, a)) void this.pause('interrupted').catch(() => undefined); }
  }
  private settleNativePause(a: ActiveRecording) {
    if (this.active !== a || a.nativeInterrupted || a.finished) return;
    try {
      const status = this.engine.poll();
      a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, status.durationMs || 0));
      updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused'); this.emit();
    } catch (error) { if (!this.consumeNativeReset(error, a)) throw error; }
  }
  private consumeNativeReset(error: unknown, a: ActiveRecording): boolean {
    if (!(error instanceof Error) || error.message !== 'recorder_reset') return false;
    const duration = (error as Error & { durationMs?: number }).durationMs;
    if (typeof duration === 'number' && Number.isFinite(duration)) a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, duration));
    a.nativeInterrupted = true; a.status = 'finalized'; a.pauseReason = 'interrupted'; a.error = 'Interrupted. Send or Discard.';
    this.stopTick(); updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'finalized'); this.emit();
    return true;
  }
  private sample() {
    const a = this.active; if (!a || (a.status !== 'recording' && a.status !== 'paused')) return;
    let result: ReturnType<RecordingEngine['poll']>;
    try { result = this.engine.poll(); } catch (error) {
      if (!this.consumeNativeReset(error, a)) void this.pause('interrupted').catch(() => undefined);
      return;
    }
    // A native paused snapshot settles the tail captured before pause. It never
    // accrues paused dwell or adds waveform samples while JS remains paused.
    if (a.status === 'paused') {
      if (result.interrupted || result.capped) {
        a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, result.durationMs || 0));
        updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused'); this.emit();
      }
      if (result.capped) void this.stop('cap').catch(() => undefined);
      return;
    }
    a.levels.push(clamp01(result.level));
    a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, result.durationMs || 0));
    updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'recording');
    if (result.capped || a.durationMs >= MAX_DURATION_MS) { void this.stop('cap').catch(() => undefined); return; }
    if (result.interrupted) { void this.pause('interrupted').catch(() => undefined); return; }
    this.emit();
    if (this.ownership && !this.checkpointPending && a.durationMs - this.checkpointAt >= 1000) {
      const epoch = this.epoch; this.checkpointPending = true; this.checkpointAt = a.durationMs;
      void this.ownership.checkpoint(this.snapshot()!, this.engine.nativeUri, voiceQuestionSnapshot(a.recordingId)).then(() => { this.guard(epoch, a); }).catch(() => {
        if (!this.current(epoch, a) || a.status !== 'recording') return;
        void this.pause('storage').catch(() => undefined); a.error = 'Could not save recording. Retry Send or Discard.'; this.emit();
      }).finally(() => { this.checkpointPending = false; });
    }
  }
  pause(reason: PauseReason = 'interrupted'): Promise<void> {
    const a = this.active;
    if (a?.status === 'stopping') {
      // Finalization owns its epoch. Lifecycle loss must still promptly disarm,
      // without cancelling that stop or waiting for the persistence queue.
      return this.engine.pause().catch(error => {
        if (this.active === a) { a.error = 'Could not pause safely. Retry Send or Discard.'; this.emit(); }
        throw error;
      });
    }
    if (a?.finished || a?.status === 'finalized') return Promise.resolve();
    // Invalidate pending permission/arming synchronously; a stale await cannot record.
    const epoch = ++this.epoch;
    if (!a) return Promise.resolve();
    this.capturedAudioMs();
    if (a.nativeInterrupted) return Promise.resolve();
    a.status = 'paused'; a.pauseReason = reason;
    a.error = reason === 'origin' ? 'Original chat unavailable' : undefined;
    this.startTick(); this.emit();
    // Native pause starts now, before a slow checkpoint can delay the serial persistence tail.
    const nativePause = this.engine.pause(); nativePause.catch(() => undefined);
    return this.serial(async () => {
      try {
        await nativePause;
        // A queued Resume may supersede this operation's persistence epoch, but
        // the same take still needs its settled pause boundary closed first.
        this.settleNativePause(a); this.guard(epoch, a); this.telemetry(a.recordingId, 'paused');
        if (this.ownership) { await this.ownership.checkpoint(this.snapshot()!, this.engine.nativeUri, voiceQuestionSnapshot(a.recordingId)); this.guard(epoch, a); }
      } catch (error) {
        if (this.active === a && !a.nativeInterrupted) updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused');
        if (this.current(epoch, a)) { a.error = 'Could not pause safely. Retry Resume, Send or Discard.'; this.emit(); }
        throw error;
      }
    });
  }
  resume(): Promise<void> {
    if (this.resuming) return this.resuming;
    const a = this.active;
    if (!a || a.status !== 'paused' || a.finished) return Promise.reject(new Error('Recording cannot be resumed. Send or Discard.'));
    if (!this.ready(a)) { a.error = this.lifecycle.foreground && this.lifecycle.unlocked ? 'Original chat unavailable' : 'Unlock the app before resuming.'; this.emit(); return Promise.reject(new Error(a.error)); }
    const epoch = ++this.epoch;
    const work = this.serial(async () => {
      try {
        this.guard(epoch, a);
        await this.engine.resume(() => this.current(epoch, a) && this.ready(a)); this.guard(epoch, a);
        if (!this.ready(a)) throw cancelled();
        a.status = 'recording'; a.error = undefined; a.pauseReason = undefined; this.telemetry(a.recordingId, 'resumed');
        this.sampleContext(a);
        updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'recording'); this.startTick(); this.emit();
        if (this.ownership) { await this.ownership.checkpoint(this.snapshot()!, this.engine.nativeUri, voiceQuestionSnapshot(a.recordingId)); this.guard(epoch, a); }
      } catch (error) {
        if (this.current(epoch, a)) {
          if (this.consumeNativeReset(error, a)) throw error;
          this.startTick(); a.status = 'paused'; a.error = 'Could not resume. Retry Resume, Send or Discard.';
          try { await this.engine.pause(); this.settleNativePause(a); }
          catch { if (this.active === a && !a.nativeInterrupted) updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused'); }
          this.emit();
        }
        throw error;
      }
    });
    this.resuming = work.finally(() => { this.resuming = null; }); return this.resuming;
  }
  send() { return this.stop('tap'); }
  stop(reason: StopReason): Promise<FinishedRecording> {
    if (this.stopping) { if (reason === 'tap') this.sendAfterStop = true; return this.stopping; }
    this.sendAfterStop = reason === 'tap';
    const a = this.active; if (!a) return Promise.reject(new Error('no_active_recording'));
    const epoch = ++this.epoch;
    this.capturedAudioMs(); this.stopTick(); a.status = 'stopping'; this.emit();
    // Close capture eligibility now, even if start/checkpoint still owns the disk tail.
    const nativePause = this.engine.pause(); nativePause.catch(() => undefined);
    const work = this.serial(async () => {
      try {
        this.guard(epoch, a); await nativePause; this.guard(epoch, a);
        if (!a.finished) {
          const result = await this.engine.stop(); this.guard(epoch, a);
          a.durationMs = Math.min(MAX_DURATION_MS, Math.max(a.durationMs, result.durationMs || 0));
          const frozenAnswers = freezeVoiceQuestionAnswers(a.recordingId, a.durationMs);
          a.finished = { streamId: a.streamId, draft: a.draft, recordingId: a.recordingId, uri: result.uri, mime: this.engine.mime,
            durationS: Math.max(1, Math.round(a.durationMs / 1000)), capturedAudioMs: a.durationMs, bytes: result.bytes, levels: a.levels.slice(),
            interrupted: reason !== 'tap' && reason !== 'cap', reason, sendRequested: false,
            ...(a.context_v1 ? { context_v1: finalizeVoiceContext(a.context_v1, a.durationMs) } : {}),
            ...(frozenAnswers ? { frozenAnswers, questionBinding: voiceQuestionSnapshot(a.recordingId) } : {}) };
        }
        const take = a.finished;
        if (this.ownership) { await this.ownership.finalize(take); this.guard(epoch, a); }
        this.transferDraft(a);
        if (this.sendAfterStop) {
          if (take.frozenAnswers && !take.frozenAnswers.length) {
            await this.engine.discard(); this.guard(epoch, a);
            if (this.ownership) { await this.ownership.discard(a.recordingId); this.guard(epoch, a); }
            a.stopContextObservation?.(); this.active = null; completeVoiceQuestionSession(a.recordingId, 'no_answers'); this.emit(); throw new NoVoiceAnswersError();
          }
          if (this.ownership) { await this.ownership.requestSend(take); this.guard(epoch, a); }
          take.sendRequested = true; completeVoiceQuestionSession(a.recordingId, 'sent');
        }
        a?.stopContextObservation?.(); this.active = null; this.emit();
        this.telemetry(a.recordingId, 'finalized');
        for (const listener of this.stoppedListeners) listener(take);
        return take;
      } catch (error) {
        if (this.current(epoch, a)) {
          a.status = a.finished || a.nativeInterrupted ? 'finalized' : 'paused';
          a.error = 'Could not save or stop recording. Tap stop again or discard.';
          if (a.finished || a.nativeInterrupted) updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'finalized');
          try { await this.engine.pause(); this.settleNativePause(a); }
          catch { if (this.active === a && !a.finished && !a.nativeInterrupted) updateVoiceQuestionCapture(a.recordingId, a.durationMs, 'paused'); }
          this.emit();
        }
        throw error;
      }
    });
    this.stopping = work.finally(() => { this.stopping = null; }); return this.stopping;
  }
  discard(): Promise<void> {
    const epoch = ++this.epoch; const a = this.active; this.stopTick();
    if (a) { a.discardUri = a.discardUri ?? this.engine.nativeUri; a.status = 'stopping'; this.emit(); }
    // Synchronous store epoch invalidation blocks an in-flight requestSend/dispatch.
    const pause = a ? this.engine.pause().catch(() => undefined) : Promise.resolve();
    if (a) this.ownership?.invalidate?.(a.recordingId);
    return this.serial(async () => {
      try {
        await pause; this.guard(epoch);
        // A revoked native start may have already cleaned this same take. X is
        // complete in that case; another epoch or another active take still refuses.
        if (a && !this.active) return;
        this.guard(epoch, a ?? undefined);
        await this.engine.discard(); this.guard(epoch, a ?? undefined);
        if (a && this.ownership) { await this.ownership.discard(a.recordingId, { nativeUri: a.discardUri }); this.guard(epoch, a); }
        if (a) { completeVoiceQuestionSession(a.recordingId, 'discarded'); this.telemetry(a.recordingId, 'cancelled'); }
        a?.stopContextObservation?.(); this.active = null; this.emit();
      } catch (error) {
        if (this.current(epoch, a ?? undefined) && a) { a.status = a.finished || a.nativeInterrupted ? 'finalized' : 'paused'; a.error = 'Could not discard recording. Try again.'; this.emit(); }
        throw error;
      }
    });
  }
  private transferDraft(a: ActiveRecording) { if (!a.draftTransferred) { a.draftTransferred = true; a.releaseDraft?.(); } }
  private telemetry(id: string, state: 'started' | 'paused' | 'resumed' | 'finalized' | 'cancelled') { voiceLifecycle(id, 'capture', state); }
  private startTick() { this.stopTick(); this.tick = this.scheduler.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS); }
  private stopTick() { if (this.tick != null) { this.scheduler.clearInterval(this.tick); this.tick = null; } }
  private emit() { const snapshot = this.snapshot(); for (const fn of this.listeners) fn(snapshot); }
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
