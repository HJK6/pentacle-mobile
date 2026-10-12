import { AppState } from 'react-native';
import { uuid } from 'expo-modules-core';
import { getAppIdentity } from '../config/appIdentity';
import { nativeVoiceCapture, getCaptureContract, ACCEPTED_CAPTURE_REVISION, type NativeVoiceCapture, type CaptureStatus } from '../../modules/pentacle-voice-capture';
import { VoiceRecorder, MAX_DURATION_MS, type RecordingEngine, type VoicePermission, type RecordingDraft, NoVoiceAnswersError, CaptureUnsupportedError } from './voiceRecording';
import { voiceDelivery } from './voiceDelivery';
import { voiceTakeStore, voiceScopeHash, VoiceStorageError } from './voiceTakeStore';
import { voiceTransportSnapshot, voiceOriginStatus, subscribeVoiceTransport, getPentacleStreamState } from './pentacleStream';
import { voiceQuestionSnapshot, updateVoiceQuestionLiveKeys, freezeVoiceQuestionAnswers, startVoiceQuestionSession, completeVoiceQuestionSession } from '../components/questions/voice/voiceAnswersBinding';

export { ACCEPTED_CAPTURE_REVISION } from '../../modules/pentacle-voice-capture';
export const RECORDING_OPTIONS = Object.freeze({
  extension: '.m4a', sampleRate: 16000, numberOfChannels: 1,
  bitRate: 32000, isMeteringEnabled: true,
});
function normalizeMeter(db?: number | null) { return typeof db === 'number' && Number.isFinite(db) ? (Math.max(-60, Math.min(0, db)) + 60) / 60 : 0; }
function mapPermission(value: { granted: boolean; canAskAgain?: boolean }): VoicePermission { return value.granted ? 'granted' : value.canAskAgain === false ? 'denied' : 'undetermined'; }
function captureMilliseconds(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(MAX_DURATION_MS, value)) : 0; }

type CaptureBindings = {
  module(): NativeVoiceCapture | null;
  contract(): unknown;
  build(): string;
};
const installedBindings: CaptureBindings = {
  module: nativeVoiceCapture, contract: getCaptureContract, build: () => getAppIdentity().buildNumber,
};

/** One retained native handle/file per live capture. The take store's UUID is separate:
 * this opaque handle only fences native commands; nativeUri is the ownership handoff.
 * No Expo Audio recorder or audio-session API participates in this capture path.
 */
export class NativeCaptureEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  private native: NativeVoiceCapture | null = null;
  private recordingId: string | null = null;
  private appStateSubscription: { remove(): void } | null = null;
  private status: CaptureStatus | null = null;
  private stopped: { uri: string; durationMs: number } | null = null;
  private stopping: Promise<{ uri: string; durationMs: number }> | null = null;
  constructor(private onAppState?: (state: string) => void, private bindings: CaptureBindings = installedBindings) {}
  private supported(): NativeVoiceCapture {
    try {
      const native = this.bindings.module();
      const contract = this.bindings.contract();
      const build = this.bindings.build();
      if (!native || !contract || typeof contract !== 'object' || Array.isArray(contract)) throw new CaptureUnsupportedError();
      const value = contract as Record<string, unknown>;
      if (value.contract !== 'pentacle-voice-capture' || value.revision !== ACCEPTED_CAPTURE_REVISION
        || typeof value.nativeBuild !== 'string' || !value.nativeBuild.trim() || value.nativeBuild !== build)
        throw new CaptureUnsupportedError();
      // Missing bridge methods are also unsupported; never enter ownership with a partial module.
      for (const key of ['getStatus', 'getAdmission', 'revokeAdmissions', 'getPermission', 'requestPermission', 'start', 'pause', 'resume', 'stop', 'discard'] as const)
        if (typeof native[key] !== 'function') throw new CaptureUnsupportedError();
      this.native = native; return native;
    } catch { throw new CaptureUnsupportedError(); }
  }
  get nativeUri(): string | undefined { return this.snapshot()?.uri ?? this.stopped?.uri ?? undefined; }
  // VoiceRecorder asks getPermission before ownership.create or any permission prompt.
  async getPermission() { return mapPermission(await this.supported().getPermission()); }
  async requestPermission() { return mapPermission(await this.supported().requestPermission()); }
  private snapshot(): CaptureStatus | null {
    if (!this.native || !this.recordingId) return null;
    const status = this.native.getStatus();
    if (status.recordingId === this.recordingId) this.status = status;
    return this.status;
  }
  private revokeAdmissions() {
    if (this.native && this.recordingId) this.native.revokeAdmissions(this.recordingId);
  }
  private async guard(isCurrent: () => boolean) {
    if (isCurrent()) return;
    await this.pause(); throw new Error('voice_cancelled');
  }
  async start(isCurrent: () => boolean = () => true) {
    const native = this.supported();
    if (!this.appStateSubscription && this.onAppState) this.appStateSubscription = AppState.addEventListener('change', this.onAppState);
    if (this.recordingId && !this.stopped) throw new Error('a_recording_is_already_active');
    this.recordingId = uuid.v4(); this.status = null; this.stopped = null;
    const admission = native.getAdmission(this.recordingId);
    if (!isCurrent()) await this.guard(isCurrent);
    this.status = await native.start(this.recordingId, admission);
    await this.guard(isCurrent);
    this.snapshot();
  }
  poll() {
    const status = this.snapshot();
    const durationMs = captureMilliseconds(status?.capturedMs ?? this.stopped?.durationMs ?? 0);
    // A reset is terminal. Use the existing engine interface's failure channel so
    // the controller can retain Send/Discard without exposing a resumable pause.
    if (status?.state === 'interrupted') throw Object.assign(new Error('recorder_reset'), { durationMs });
    return { level: normalizeMeter(status?.metering), durationMs,
      interrupted: status?.state === 'paused', capped: status?.state === 'capped' };
  }
  async pause() {
    this.revokeAdmissions(); // Must be the first synchronous statement, before any await or queue.
    if (!this.native || !this.recordingId || this.stopped) return;
    this.status = await this.native.pause(this.recordingId);
  }
  async resume(isCurrent: () => boolean = () => true) {
    const native = this.supported();
    const status = this.snapshot();
    if (status?.state === 'interrupted') throw Object.assign(new Error('recorder_reset'), { durationMs: captureMilliseconds(status.capturedMs) });
    if (!this.recordingId || this.stopped || status?.state !== 'paused') throw new Error(status?.state === 'capped' ? 'capped' : 'not_paused');
    const admission = native.getAdmission(this.recordingId);
    if (!isCurrent()) await this.guard(isCurrent);
    // Both epoch and admission are checked again natively after session activation.
    try { this.status = await native.resume(this.recordingId, status.pauseEpoch, admission); }
    catch (error) { this.poll(); throw error; }
    await this.guard(isCurrent);
    this.poll();
  }
  async stop() {
    this.revokeAdmissions(); // Send cancels queued/activating admission immediately.
    if (this.stopped) return this.stopped;
    if (this.stopping) return this.stopping;
    if (!this.native || !this.recordingId) throw new Error('no_active_recording');
    const native = this.native; const id = this.recordingId;
    const work = (async () => {
      this.status = await native.stop(id);
      this.stopped = { uri: this.status.uri ?? '', durationMs: captureMilliseconds(this.status.capturedMs) };
      return this.stopped;
    })();
    this.stopping = work;
    try { return await work; } finally { this.stopping = null; }
  }
  async discard() {
    this.revokeAdmissions(); // X cancels queued/activating admission immediately.
    if (this.native && this.recordingId) await this.native.discard(this.recordingId);
    this.recordingId = null; this.status = null; this.stopped = null;
  }
}

let lifecycle = { foreground: AppState.currentState === 'active', unlocked: false };
const lifecycleListeners = new Set<() => void>();
let stopOriginSubscription: (() => void) | null = null;
function ensureOriginSubscription() { if (!stopOriginSubscription) stopOriginSubscription = subscribeVoiceTransport(() => voiceRecorder.checkOrigin()); }
export const voiceLifecycleSnapshot = () => lifecycle;
export const subscribeVoiceLifecycle = (listener: () => void) => { lifecycleListeners.add(listener); return () => { lifecycleListeners.delete(listener); }; };
export function setVoiceLifecycle(value: { foreground: boolean; unlocked: boolean }) {
  lifecycle = { ...value };
  if (value.foreground && value.unlocked) ensureOriginSubscription();
  voiceRecorder.setLifecycle(lifecycle); voiceDelivery.setLifecycle(lifecycle);
  for (const listener of lifecycleListeners) listener();
}
function refreshQuestionKeys(id: string) {
  if (!voiceQuestionSnapshot(id)) return;
  const state = getPentacleStreamState(); const transport = voiceTransportSnapshot();
  // An offline/unhydrated deck is not evidence that original questions disappeared.
  if (state.hasHydrated && transport.ready && transport.inventoryFresh && !transport.authNeeded) {
    // Idle/global controls must not import app screens through the legacy deck.
    const { selectQuestionDeck } = require('../components/questions/questionSelectors') as typeof import('../components/questions/questionSelectors');
    updateVoiceQuestionLiveKeys(id, selectQuestionDeck(state).map(page => page.key));
  }
}
function ownsCurrentScope(recordingId: string) {
  const take = voiceTakeStore.get(recordingId); const context = voiceTransportSnapshot();
  return !!take && !!context.credentialId && !!context.serverIdentity
    && take.scopeHash === voiceScopeHash({ serverIdentity: context.serverIdentity, credentialId: context.credentialId });
}
function currentCaptureScope(): string {
  const context = voiceTransportSnapshot();
  if (!context.credentialId || !context.serverIdentity || context.authNeeded) throw new VoiceStorageError('auth_needed');
  return `${voiceScopeHash({ serverIdentity: context.serverIdentity, credentialId: context.credentialId })}:${context.scopeGeneration ?? 0}`;
}
export const voiceRecorder = new VoiceRecorder(new NativeCaptureEngine(state => {
  setVoiceLifecycle({ foreground: state === 'active', unlocked: state === 'active' ? lifecycle.unlocked : false });
}), undefined, {
  captureScope: currentCaptureScope,
  create: async (streamId, draft, expectedScope) => {
    const checkScope = () => { if (expectedScope !== undefined && currentCaptureScope() !== expectedScope) throw new Error('Account or connection changed. Start recording again.'); };
    checkScope(); ensureOriginSubscription();
    await voiceDelivery.initialize(); checkScope();
    const context = voiceTransportSnapshot();
    const origin = context.origins.find(row => row.stream_id === streamId);
    if (!context.credentialId || context.authNeeded) throw new VoiceStorageError('auth_needed');
    if (!origin?.session_generation || voiceOriginStatus(streamId, origin.session_generation) !== 'available') throw new VoiceStorageError('origin_unverifiable');
    if (draft?.originGeneration && draft.originGeneration !== origin.session_generation) throw new VoiceStorageError('origin_unverifiable');
    const captured: RecordingDraft = { originGeneration: origin.session_generation, originLabel: draft?.originLabel || origin.title || 'Chat',
      textPrefix: draft?.textPrefix ?? '', images: draft?.images.slice() ?? [], operationKind: draft?.operationKind ?? 'voice_chat', questionBinding: draft?.questionBinding };
    const take = await voiceTakeStore.create({ scope: { serverIdentity: context.serverIdentity, credentialId: context.credentialId },
      origin: { streamId, generation: origin.session_generation, label: captured.originLabel }, draft: captured, operationKind: captured.operationKind, questionBinding: captured.questionBinding });
    return { recordingId: take.recordingId, draft: { ...captured, images: voiceTakeStore.images(take) } };
  },
  checkpoint: async (snapshot, nativeUri, questionBinding) => {
    await voiceTakeStore.noteCapture(snapshot.recordingId, { nativeUri, capturedAudioMs: snapshot.capturedAudioMs, phase: snapshot.status === 'recording' ? 'recording' : 'paused', levels: snapshot.levels, questionBinding, context_v1: snapshot.context_v1 });
  },
  finalize: async take => {
    refreshQuestionKeys(take.recordingId);
    const frozenAnswers = freezeVoiceQuestionAnswers(take.recordingId, take.capturedAudioMs ?? take.durationS * 1000) ?? take.frozenAnswers;
    take.frozenAnswers = frozenAnswers; take.questionBinding = voiceQuestionSnapshot(take.recordingId);
    await voiceTakeStore.adoptFinalized(take.recordingId, { uri: take.uri, mime: take.mime, capturedAudioMs: take.capturedAudioMs ?? take.durationS * 1000, levels: take.levels, frozenAnswers, questionBinding: take.questionBinding, context_v1: take.context_v1 });
  },
  requestSend: async take => {
    if (take.draft?.operationKind === 'voice_answer' && !take.frozenAnswers?.length) {
      await voiceDelivery.discard(take.recordingId); completeVoiceQuestionSession(take.recordingId, 'no_answers'); throw new NoVoiceAnswersError();
    }
    await voiceDelivery.enqueue(take.recordingId, { frozenAnswers: take.frozenAnswers });
  },
  invalidate: id => { voiceTakeStore.invalidate(id); },
  discard: (id, options) => voiceTakeStore.get(id) ? voiceDelivery.discard(id, options) : voiceTakeStore.discard(id, options),
  ownsScope: ownsCurrentScope,
  originAvailable: (streamId, generation, recordingId) => !!recordingId && ownsCurrentScope(recordingId)
    && !voiceTransportSnapshot().authNeeded && !!generation && voiceOriginStatus(streamId, generation) === 'available',
});
voiceRecorder.setLifecycle(lifecycle);

/** Every retained/global Send freezes the same process binding before the committed queue. */
export async function sendVoiceTake(id: string) {
  if (voiceRecorder.snapshot()?.recordingId === id) { await voiceRecorder.send(); return; }
  const take = voiceTakeStore.get(id); if (!take) return;
  // Finalized persisted answers are already the committed immutable Send input.
  // Restoring UI bindings must never reinterpret their eligibility from a cold deck.
  let frozenAnswers = take.frozenAnswers;
  if (frozenAnswers === undefined) {
    if (take.questionBinding && !voiceQuestionSnapshot(id)) startVoiceQuestionSession(id, take.questionBinding);
    refreshQuestionKeys(id);
    frozenAnswers = freezeVoiceQuestionAnswers(id, take.capturedAudioMs);
  }
  if (take.operation.operation_kind === 'voice_answer' && !frozenAnswers?.length) {
    await voiceDelivery.discard(id); completeVoiceQuestionSession(id, 'no_answers'); throw new NoVoiceAnswersError();
  }
  await voiceDelivery.enqueue(id, { frozenAnswers }); completeVoiceQuestionSession(id, 'sent');
}
export async function discardVoiceTake(id: string) {
  if (voiceRecorder.snapshot()?.recordingId === id) await voiceRecorder.discard();
  else { await voiceDelivery.discard(id); completeVoiceQuestionSession(id, 'discarded'); }
}
