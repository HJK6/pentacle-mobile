import { AppState } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, type RecordingOptions } from 'expo-audio';
import { VoiceRecorder, MAX_DURATION_MS, type RecordingEngine, type VoicePermission, type RecordingDraft, NoVoiceAnswersError } from './voiceRecording';
import { voiceDelivery } from './voiceDelivery';
import { voiceTakeStore, voiceScopeHash, VoiceStorageError } from './voiceTakeStore';
import { voiceTransportSnapshot, voiceOriginStatus, subscribeVoiceTransport, getPentacleStreamState } from './pentacleStream';
import { selectQuestionDeck } from '../components/questions/questionSelectors';
import { voiceQuestionSnapshot, updateVoiceQuestionLiveKeys, freezeVoiceQuestionAnswers, startVoiceQuestionSession, completeVoiceQuestionSession } from '../components/questions/voice/voiceAnswersBinding';

export const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY, extension: '.m4a', sampleRate: 16000,
  numberOfChannels: 1, bitRate: 32000, isMeteringEnabled: true,
};
function normalizeMeter(db?: number) { return typeof db === 'number' && Number.isFinite(db) ? (Math.max(-60, Math.min(0, db)) + 60) / 60 : 0; }
function mapPermission(value: { granted: boolean; canAskAgain?: boolean }): VoicePermission { return value.granted ? 'granted' : value.canAskAgain === false ? 'denied' : 'undetermined'; }

/** Same native recorder/file for the entire live take. Never prepare on Resume. */
export class ExpoAudioEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  private recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  private listener: { remove(): void } | null = null;
  private appStateSubscription: { remove(): void } | null = null;
  private capturedMs = 0;
  private paused = true;
  private capped = false;
  private explicitStop = false;
  private nativeDeadlineMs = 0;
  private stopped: { uri: string; durationMs: number } | null = null;
  constructor(private onAppState?: (state: string) => void) {}
  get nativeUri(): string | undefined { return this.recorder?.uri ?? this.stopped?.uri ?? undefined; }
  async requestPermission() { return mapPermission(await AudioModule.requestRecordingPermissionsAsync()); }
  async getPermission() { return mapPermission(await AudioModule.getRecordingPermissionsAsync()); }
  private async disarm() { await setAudioModeAsync({ allowsRecording: false }); }
  private async guard(isCurrent: () => boolean) {
    if (isCurrent()) return;
    try { this.recorder?.pause(); } finally { this.paused = true; await this.disarm(); }
    throw new Error('voice_cancelled');
  }
  async start(isCurrent: () => boolean = () => true) {
    if (!this.appStateSubscription && this.onAppState) this.appStateSubscription = AppState.addEventListener('change', this.onAppState);
    this.capturedMs = 0; this.capped = false; this.stopped = null; this.explicitStop = false; this.paused = true;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
    if (!isCurrent()) await this.guard(isCurrent);
    const recorder = new AudioModule.AudioRecorder(RECORDING_OPTIONS); this.recorder = recorder;
    this.listener = recorder.addListener('recordingStatusUpdate', event => {
      if (this.recorder !== recorder || this.explicitStop) return;
      if (event.isFinished && !event.hasError) {
        // Expo resets duration before this event and does not distinguish an early finish.
        // Only the armed native deadline can certify the full cap; otherwise retain last measured audio.
        this.capped = !this.paused && performance.now() >= this.nativeDeadlineMs;
        if (this.capped) this.capturedMs = MAX_DURATION_MS;
        this.paused = true;
      }
      if (event.hasError) this.paused = true;
    });
    await recorder.prepareToRecordAsync(); if (!isCurrent()) await this.guard(isCurrent);
    this.nativeDeadlineMs = performance.now() + MAX_DURATION_MS;
    recorder.record({ forDuration: MAX_DURATION_MS / 1000 }); this.paused = false;
  }
  poll() {
    const status = this.recorder?.getStatus();
    if (!this.paused) this.capturedMs = Math.min(MAX_DURATION_MS, Math.max(this.capturedMs, status?.durationMillis ?? 0));
    return { level: normalizeMeter(status?.metering), durationMs: this.capturedMs, interrupted: !this.capped && (this.paused || status?.isRecording === false), capped: this.capped };
  }
  async pause() {
    const recorder = this.recorder;
    if (recorder && !this.stopped) {
      this.poll();
      // Swift setAudioMode(false) stops a still-recording ref. Pause FIRST to preserve it.
      let failure: unknown;
      try { recorder.pause(); } catch (error) { failure = error; } finally { this.paused = true; }
      await this.disarm();
      if (failure) throw failure;
      return;
    }
    await this.disarm();
  }
  async resume(isCurrent: () => boolean = () => true) {
    const recorder = this.recorder;
    if (!recorder || this.stopped || this.capped || this.capturedMs >= MAX_DURATION_MS) throw new Error('no_paused_recording');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: false });
    if (!isCurrent()) await this.guard(isCurrent);
    // prepareToRecordAsync would replace/reset native file and duration.
    this.nativeDeadlineMs = performance.now() + (MAX_DURATION_MS - this.capturedMs);
    recorder.record({ forDuration: (MAX_DURATION_MS - this.capturedMs) / 1000 });
    this.paused = false;
    if (!recorder.getStatus().isRecording || !recorder.isRecording) { await this.pause(); throw new Error('resume_failed'); }
  }
  async stop() {
    const recorder = this.recorder;
    if (!this.stopped) {
      if (!recorder) throw new Error('no_active_recording');
      this.poll(); this.explicitStop = true;
      await recorder.stop();
      this.paused = true; this.stopped = { uri: recorder.uri ?? '', durationMs: this.capturedMs };
    }
    // A failed disarm is retryable without issuing another native stop.
    await this.disarm();
    const result = this.stopped;
    this.listener?.remove(); this.listener = null; this.recorder = null;
    return result;
  }
  async discard() {
    this.explicitStop = true;
    if (this.recorder && !this.stopped) { await this.recorder.stop(); this.paused = true; }
    await this.disarm();
    this.listener?.remove(); this.listener = null; this.recorder = null; this.stopped = null;
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
  const state = getPentacleStreamState(); const transport = voiceTransportSnapshot();
  // An offline/unhydrated deck is not evidence that original questions disappeared.
  if (voiceQuestionSnapshot(id) && state.hasHydrated && transport.ready && transport.inventoryFresh && !transport.authNeeded)
    updateVoiceQuestionLiveKeys(id, selectQuestionDeck(state).map(page => page.key));
}
function ownsCurrentScope(recordingId: string) {
  const take = voiceTakeStore.get(recordingId); const context = voiceTransportSnapshot();
  return !!take && !!context.credentialId && !!context.serverIdentity
    && take.scopeHash === voiceScopeHash({ serverIdentity: context.serverIdentity, credentialId: context.credentialId });
}
export const voiceRecorder = new VoiceRecorder(new ExpoAudioEngine(state => {
  setVoiceLifecycle({ foreground: state === 'active', unlocked: state === 'active' ? lifecycle.unlocked : false });
}), undefined, {
  create: async (streamId, draft) => {
    ensureOriginSubscription();
    await voiceDelivery.initialize();
    const context = voiceTransportSnapshot();
    const origin = context.origins.find(row => row.stream_id === streamId);
    if (!context.credentialId || context.authNeeded) throw new VoiceStorageError('auth_needed');
    if (!origin?.session_generation || voiceOriginStatus(streamId, origin.session_generation) !== 'available') throw new VoiceStorageError('origin_unverifiable');
    if (draft?.originGeneration && draft.originGeneration !== origin.session_generation) throw new VoiceStorageError('origin_unverifiable');
    const captured: RecordingDraft = { originGeneration: origin.session_generation, originLabel: origin.title || draft?.originLabel || streamId,
      textPrefix: draft?.textPrefix ?? '', images: draft?.images.slice() ?? [], operationKind: draft?.operationKind ?? 'voice_chat', questionBinding: draft?.questionBinding };
    const take = await voiceTakeStore.create({ scope: { serverIdentity: context.serverIdentity, credentialId: context.credentialId },
      origin: { streamId, generation: origin.session_generation, label: captured.originLabel }, draft: captured, operationKind: captured.operationKind, questionBinding: captured.questionBinding });
    return { recordingId: take.recordingId, draft: { ...captured, images: voiceTakeStore.images(take) } };
  },
  checkpoint: async (snapshot, nativeUri, questionBinding) => {
    await voiceTakeStore.noteCapture(snapshot.recordingId, { nativeUri, capturedAudioMs: snapshot.capturedAudioMs, phase: snapshot.status === 'recording' ? 'recording' : 'paused', levels: snapshot.levels, questionBinding });
  },
  finalize: async take => {
    refreshQuestionKeys(take.recordingId);
    const frozenAnswers = freezeVoiceQuestionAnswers(take.recordingId, take.capturedAudioMs ?? take.durationS * 1000) ?? take.frozenAnswers;
    take.frozenAnswers = frozenAnswers; take.questionBinding = voiceQuestionSnapshot(take.recordingId);
    await voiceTakeStore.adoptFinalized(take.recordingId, { uri: take.uri, mime: take.mime, capturedAudioMs: take.capturedAudioMs ?? take.durationS * 1000, levels: take.levels, frozenAnswers, questionBinding: take.questionBinding });
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
