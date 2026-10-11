import { useSyncExternalStore } from 'react';
import type { PentacleTranscriptItem, ChatAttachment } from 'pentacle-chat-core';
import {
  runVoiceUploadTranscribe,
  voiceTranscribeFailureMessage,
  NOTHING_RECOGNIZED_MESSAGE,
} from './voiceSendUnit';
import { readAttachmentBase64 } from './attachmentUpload';
import type { ProcessedAsset } from './imageCapture';
import type { VoiceUploadTranscribeResult } from './voiceSendUnit';
import type { FinishedRecording } from './voiceRecording';
import * as stream from './pentacleStream';
import {
  voiceTakeStore,
  VoiceTakeStore,
  VoiceStorageError,
  voiceLifecycle,
  voiceScopeHash,
  type VoiceTakeManifest,
  type VoiceDeliveryPhase,
} from './voiceTakeStore';
import {
  installVoiceAnswersCarrier,
  releaseVoiceAnswersBinding,
  completeVoiceQuestionSession,
  type VoiceAnswersItem,
} from '../components/questions/voice/voiceAnswersBinding';

installVoiceAnswersCarrier();
export type VoiceTake = FinishedRecording & {
  status: VoiceDeliveryPhase;
  transcribeRequestId: string;
  createdAt: number;
  capturedAudioMs: number;
  sendRequestedAt: number | null;
  error?: string;
  transcription?: VoiceUploadTranscribeResult;
  attachments?: ChatAttachment[];
  manifest: VoiceTakeManifest;
};
export type VoiceDeliverySnapshot = {
  takes: VoiceTake[];
  last: null;
  heldCount: number;
  recoveryFailures: readonly {
    id: string;
    scopeHash: string;
    error: 'recovery_failed';
  }[];
  storageError?: string;
};
type TransportSnapshot = ReturnType<typeof stream.voiceTransportSnapshot>;
export interface VoiceDeliveryIO {
  transcribe: typeof runVoiceUploadTranscribe;
  uploadImages?: (
    assets: ProcessedAsset[],
    context: {
      isCancelled: () => boolean;
      scope: {
        serverIdentity: string;
        credentialId: string;
        scopeGeneration: number;
        socketGeneration: number;
      };
    },
  ) => Promise<ChatAttachment[]>;
  prepare: typeof stream.prepareVoiceDispatchIntent;
  hydrate: typeof stream.hydrateVoiceDispatchIntent;
  dispatch: typeof stream.dispatchVoiceDispatchIntent;
  query: typeof stream.queryVoiceDispatchReceipt;
  forget: typeof stream.forgetVoiceDispatchIntent;
  transport: () => TransportSnapshot;
  origin: typeof stream.voiceOriginStatus;
  subscribeTransport?: typeof stream.subscribeVoiceTransport;
  subscribeEvidence?: typeof stream.subscribeVoiceSendEvidence;
  now?: () => number;
  setTimer?: (fn: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}
const DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
/** Persisted with phase auth_needed when only the transport's auth state blocked the take. */
const TRANSPORT_AUTH_NEEDED = 'transport_auth_needed';
const DELIVERY_ERROR_CODES = new Set([
  'invalid_request',
  'upload_forbidden',
  'upload_conflict',
  'offset_mismatch',
  'digest_mismatch',
  'upload_expired',
  'upload_quota',
  'upload_blob_disk_full',
  'server_update_required',
  'invalid_upload_ack',
  'audio_changed',
  'audio_unavailable',
  'upload_failed',
  'backend_unavailable',
  'too_long',
  'mime_unsupported',
  'blob_unknown',
  'transcribe_failed',
  'transcribe_timeout',
  'auth_needed',
  'origin_unavailable',
  'origin_unverifiable',
  'attempt_limit',
  'storage_full',
  'storage_write_failed',
  'interrupted_recording',
  'no_answers',
  'no_speech',
  'image_upload_unavailable',
  'voice_failed',
]);
const errorCode = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.message
      : 'voice_failed';
const transportFailure = (error: unknown): boolean =>
  /disconnected|not connected|timed out|offline|socket|connection|voice_suspended|readiness|voice_transport_not_ready|voice_origin_unverified|origin_unverifiable/i.test(
    errorCode(error),
  );
const authFailure = (error: unknown): boolean =>
  /upload_forbidden|auth_needed|credential|revoked|unauthenticated/i.test(errorCode(error));
function errorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === 'server_update_required') return 'Server update required';
  if (
    code === 'origin_unavailable' ||
    code === 'origin_unverifiable' ||
    code === 'voice_origin_unavailable'
  )
    return 'Original chat unavailable';
  if (code === 'attempt_limit')
    return 'Retry limit reached. Remove the local copy or check delivery.';
  if (code === 'storage_full' || code === 'storage_write_failed')
    return 'Could not save the recording. Free storage and retry.';
  if (code === 'interrupted_recording' || code === 'audio_unavailable')
    return 'Interrupted recording could not be recovered. Discard this take.';
  if (code === 'no_answers') return 'No answers were covered.';
  if (code === 'no_speech' || code === NOTHING_RECOGNIZED_MESSAGE)
    return NOTHING_RECOGNIZED_MESSAGE;
  if (code === 'transcribe_timeout') return 'Transcription timed out. Retry when you’re ready.';
  if (code === 'auth_needed' || code === TRANSPORT_AUTH_NEEDED) return 'Sign in again to send this recording.';
  return voiceTranscribeFailureMessage(error);
}

/** One serial scheduler. Only the durable store owns state, identity, or asset deletion. */
export class VoiceDelivery {
  private state: VoiceDeliverySnapshot = {
    takes: [],
    last: null,
    heldCount: 0,
    recoveryFailures: [],
  };
  private listeners = new Set<() => void>();
  private foreground = false;
  private unlocked = false;
  private runtimeEpoch = 0;
  private wakeEpoch = 0;
  private drainWork: Promise<void> | null = null;
  private redrain = false;
  private retrying = new Set<string>();
  private timer: unknown = null;
  private disposed = false;
  private stopSubscriptions: Array<() => void> = [];
  private subscriptionsStarted = false;
  private seenReconciliation = new Set<string>();
  private scope: string | null = null;
  private lastReady = false;
  private authReadyKey = '';
  private readyEpoch = 0;
  private configuration: Promise<void> = Promise.resolve();
  private proofWrites = new Map<string, Promise<void>>();
  constructor(
    private readonly io: VoiceDeliveryIO,
    readonly store: VoiceTakeStore = voiceTakeStore,
  ) {
    this.stopSubscriptions.push(store.subscribe(() => this.project()));
    this.project();
  }
  private ensureSubscriptions() {
    if (this.subscriptionsStarted || this.disposed) return;
    this.subscriptionsStarted = true;
    if (this.io.subscribeTransport)
      this.stopSubscriptions.push(
        this.io.subscribeTransport(() => {
          void this.synchronizeTransport();
        }),
      );
    if (this.io.subscribeEvidence)
      this.stopSubscriptions.push(
        this.io.subscribeEvidence((evidence) => {
          void this.applyEvidence(evidence);
        }),
      );
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  clearLast = () => {};
  private project() {
    const snapshot = this.store.snapshot();
    this.state = {
      ...this.state,
      last: null,
      heldCount: snapshot.heldCount,
      recoveryFailures: snapshot.recoveryFailures,
      takes: snapshot.takes
        .filter((t) => !['recording', 'paused'].includes(t.storage))
        .map((t) => ({
          recordingId: t.recordingId,
          streamId: t.origin.streamId,
          uri: t.audio ? this.store.audioUri(t) : (t.nativeUri ?? ''),
          mime: t.audio?.mime ?? 'audio/mp4',
          durationS: t.capturedAudioMs / 1000,
          capturedAudioMs: t.capturedAudioMs,
          bytes: t.audio?.bytes,
          levels: t.levels.slice(),
          interrupted: t.storage === 'interrupted',
          draft: {
            originGeneration: t.origin.generation,
            originLabel: t.origin.label,
            textPrefix: t.draft.textPrefix,
            images: this.store.images(t),
          },
          status: t.delivery.phase,
          createdAt: t.createdAt,
          sendRequestedAt: t.sendRequestedAt,
          transcribeRequestId: `transcribe-${t.recordingId}`,
          error: t.delivery.error
            ? errorMessage(
                Object.assign(new Error(t.delivery.error), {
                  code: t.delivery.error,
                }),
              )
            : undefined,
          transcription: t.transcription
            ? {
                blobSha: t.transcription.blobSha,
                transcript: t.transcription.result,
              }
            : undefined,
          attachments: t.attachments,
          manifest: t,
        })),
    };
    for (const fn of this.listeners) fn();
  }
  private clearStorageFailure() {
    if (!this.state.storageError) return;
    this.state = { ...this.state, storageError: undefined };
    for (const fn of this.listeners) fn();
  }
  private storageFailure(error: unknown) {
    this.state = {
      ...this.state,
      storageError: 'Could not save or clean up a retained recording. Free storage and retry.',
    };
    for (const fn of this.listeners) fn();
  }
  private now() {
    return this.io.now?.() ?? Date.now();
  }
  private stopTimer() {
    if (this.timer !== null) {
      (this.io.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
  }
  private enabled() {
    const transport = this.io.transport();
    return (
      !this.disposed && this.foreground && this.unlocked && transport.ready && !transport.authNeeded
    );
  }
  setLifecycle(value: { foreground: boolean; unlocked: boolean }) {
    this.ensureSubscriptions();
    if (value.foreground === this.foreground && value.unlocked === this.unlocked) return;
    this.foreground = value.foreground;
    this.unlocked = value.unlocked;
    this.runtimeEpoch++;
    this.wakeEpoch++;
    this.stopTimer();
    if (this.foreground && this.unlocked) void this.synchronizeTransport();
  }
  async initialize(): Promise<void> {
    this.ensureSubscriptions();
    await this.synchronizeTransport();
  }
  private synchronizeTransport(): Promise<void> {
    const snapshot = this.io.transport();
    const scope =
      snapshot.credentialId && snapshot.serverIdentity
        ? {
            serverIdentity: snapshot.serverIdentity,
            credentialId: snapshot.credentialId,
          }
        : null;
    const hash = scope ? voiceScopeHash(scope) : null;
    const effectiveReady = snapshot.ready && !snapshot.authNeeded;
    if (effectiveReady && !this.lastReady) this.readyEpoch++;
    if (hash !== this.scope || effectiveReady !== this.lastReady) {
      this.runtimeEpoch++;
      this.stopTimer();
    }
    this.scope = hash;
    this.lastReady = effectiveReady;
    this.configuration = this.configuration
      .catch(() => undefined)
      .then(async () => {
        // Superseded scope configuration never makes an old identity current again.
        const current = this.io.transport();
        const next =
          current.credentialId && current.serverIdentity
            ? {
                serverIdentity: current.serverIdentity,
                credentialId: current.credentialId,
              }
            : null;
        await this.store.setScope(next);
        this.clearStorageFailure();
        if (current.authNeeded) {
          for (const t of this.store.snapshot().takes)
            if (
              t.sendRequestedAt !== null &&
              !t.dispatchIntent &&
              t.delivery.phase !== 'auth_needed'
            ) {
              // The durable error records that only the transport's auth state blocked this
              // take, so any later process can requeue it once the credential is current.
              await this.store.setDelivery(t.recordingId, {
                phase: 'auth_needed',
                retryAt: null,
                error: TRANSPORT_AUTH_NEEDED,
              });
            }
        } else if (current.credentialId) {
          // Relaunch can report authNeeded before the stored credential is current. Once it is,
          // the take is queued again even while offline; it is not a sign-in problem. A server
          // credential rejection keeps auth_needed until a renewed ready epoch.
          for (const t of this.store.snapshot().takes)
            if (t.delivery.phase === 'auth_needed' && t.delivery.error === TRANSPORT_AUTH_NEEDED)
              await this.store.setDelivery(t.recordingId, {
                phase: 'queued',
                retryAt: null,
                error: undefined,
              });
        }
        if (!this.enabled()) return;
        const authKey = `${current.scopeGeneration}:${current.socketGeneration}:${this.readyEpoch}`;
        if (authKey !== this.authReadyKey) {
          this.authReadyKey = authKey;
          for (const t of this.store.snapshot().takes)
            if (t.delivery.phase === 'auth_needed')
              await this.store.setDelivery(t.recordingId, {
                phase: 'queued',
                retryAt: null,
                error: undefined,
              });
        }
        void this.drain();
      })
      .catch((error) => this.storageFailure(error));
    return this.configuration;
  }
  /** Accept is retention only. Capture, pause, cap and restart never imply Send. */
  accept = async (recording: FinishedRecording): Promise<void> => {
    const take = this.store.get(recording.recordingId);
    if (!take) throw new VoiceStorageError('recording_ownership_missing');
    if (!take.audio || !['finalized', 'interrupted'].includes(take.storage))
      await this.store.adoptFinalized(recording.recordingId, {
        uri: recording.uri,
        mime: recording.mime,
        capturedAudioMs:
          'capturedAudioMs' in recording && typeof recording.capturedAudioMs === 'number'
            ? recording.capturedAudioMs
            : recording.durationS * 1000,
        levels: recording.levels,
      });
    this.project();
  };
  enqueue = async (
    id: string,
    options: { frozenAnswers?: VoiceAnswersItem[] } = {},
  ): Promise<void> => {
    await this.store.requestSend(id, options);
    this.clearStorageFailure();
    voiceLifecycle(id, 'delivery', 'queued');
    void this.drain();
  };
  send = async (
    id: string,
    options: { frozenAnswers?: VoiceAnswersItem[] } = {},
  ): Promise<void> => {
    await this.store.requestSend(id, options);
    this.clearStorageFailure();
    voiceLifecycle(id, 'delivery', 'queued');
    await this.drain();
  };
  retry = async (id: string): Promise<void> => {
    if (this.retrying.has(id)) return;
    this.retrying.add(id);
    try {
      const t = this.store.get(id);
      if (!t) return;
      if (t.dispatchIntent) {
        if (t.delivery.phase !== 'not_landed') {
          await this.checkAgain(id);
          return;
        }
        if (!this.enabled()) return;
        if (t.sequence >= 1000) {
          await this.store.setDelivery(id, {
            phase: 'failed',
            error: 'attempt_limit',
            retryAt: null,
          });
          return;
        }
        const epoch = this.store.epoch(id),
          runtime = this.runtimeEpoch;
        try {
          this.requireOrigin(t);
          const intent = this.io.prepare({
            recordingId: id,
            sequence: t.sequence + 1,
            streamId: t.origin.streamId,
            originGeneration: t.origin.generation,
            text: this.intentText(t.dispatchIntent),
            operationId: id,
            previousIntent: t.dispatchIntent,
          });
          await this.store.replaceRetryIntent(id, intent);
          this.guard(id, epoch, runtime);
          this.io.hydrate(intent);
          const evidence = await this.io.dispatch(intent);
          this.guard(id, epoch, runtime);
          await this.applyEvidence(evidence);
        } catch (error) {
          await this.handleFailure(id, error, true);
        }
        return;
      }
      if (t.sendRequestedAt === null) {
        await this.send(id);
        return;
      }
      await this.store.setDelivery(id, {
        phase: 'queued',
        retryAt: null,
        error: undefined,
        retryCount: 0,
      });
      this.clearStorageFailure();
      voiceLifecycle(id, 'delivery', 'retried');
      await this.drain();
    } finally {
      await this.proofWrites.get(id);
      this.retrying.delete(id);
    }
  };
  checkAgain = async (id: string): Promise<void> => {
    const t = this.store.get(id);
    if (!t?.dispatchIntent) return;
    this.seenReconciliation.delete(this.reconcileKey(t));
    await this.store.setDelivery(id, {
      phase: 'checking',
      retryAt: null,
      error: undefined,
    });
    this.clearStorageFailure();
    await this.drain();
  };
  discard = async (id: string, options: { nativeUri?: string } = {}): Promise<void> => {
    const t = this.store.get(id);
    if (!t) return;
    const work = this.store.discard(id, options); // Invalidates the operation epoch synchronously.
    releaseVoiceAnswersBinding(id);
    if (t.dispatchIntent) this.io.forget(t.dispatchIntent);
    try {
      await work;
      this.clearStorageFailure();
      voiceLifecycle(id, 'delivery', 'cancelled');
    } catch (error) {
      this.storageFailure(error);
      throw error;
    }
    void this.drain();
  };
  discardHeld = async () => {
    await this.store.discardHeld((id) => {
      completeVoiceQuestionSession(id, 'discarded');
      releaseVoiceAnswersBinding(id);
    });
  };
  removeRecoveryFailure = async (id: string) => {
    await this.store.removeRecoveryFailure(id);
  };
  private guard(id: string, epoch: number, runtime: number) {
    if (!this.store.isCurrent(id, epoch)) throw new VoiceStorageError('voice_cancelled');
    if (!this.enabled() || runtime !== this.runtimeEpoch)
      throw new VoiceStorageError('voice_suspended');
  }
  private requireOrigin(t: VoiceTakeManifest) {
    const status = this.io.origin(t.origin.streamId, t.origin.generation);
    if (status === 'unavailable') throw new VoiceStorageError('origin_unavailable');
    if (status !== 'available') throw new VoiceStorageError('origin_unverifiable');
    if (!this.io.transport().inventoryFresh) throw new VoiceStorageError('voice_suspended');
  }
  private reconcileKey(t: VoiceTakeManifest): string {
    const s = this.io.transport();
    return `${t.recordingId}:${t.dispatchIntent?.requestId}:${s.scopeGeneration}:${s.socketGeneration}:${this.wakeEpoch}`;
  }
  drain = (): Promise<void> => {
    if (this.drainWork) {
      this.redrain = true;
      return this.drainWork;
    }
    if (!this.enabled()) return Promise.resolve();
    this.stopTimer();
    this.drainWork = this.runDrain()
      .catch((error) => this.storageFailure(error))
      .finally(() => {
        this.drainWork = null;
        this.scheduleRetry();
        if (this.redrain) {
          this.redrain = false;
          void this.drain();
        }
      });
    return this.drainWork;
  };
  private async runDrain() {
    const attempted = new Set<string>();
    while (this.enabled()) {
      const t = this.store.snapshot().takes.find((t) => {
        if (attempted.has(t.recordingId) || t.sendRequestedAt === null || !t.audio) return false;
        if (t.dispatchIntent)
          return (
            t.delivery.phase === 'checking' && !this.seenReconciliation.has(this.reconcileKey(t))
          );
        return (
          ['queued', 'uploading', 'transcribing'].includes(t.delivery.phase) &&
          (t.delivery.retryAt === null || t.delivery.retryAt <= this.now())
        );
      });
      if (!t) break;
      attempted.add(t.recordingId);
      const status = this.io.origin(t.origin.streamId, t.origin.generation);
      if (!t.dispatchIntent && status === 'unavailable') {
        await this.store.setDelivery(t.recordingId, {
          phase: 'origin_unavailable',
          retryAt: null,
          error: 'origin_unavailable',
        });
        continue;
      }
      if (!t.dispatchIntent && status !== 'available') continue;
      await this.run(t);
    }
  }
  private async run(initial: VoiceTakeManifest) {
    const id = initial.recordingId,
      epoch = this.store.epoch(id),
      runtime = this.runtimeEpoch;
    const guard = () => this.guard(id, epoch, runtime);
    try {
      guard();
      if (initial.dispatchIntent) {
        this.seenReconciliation.add(this.reconcileKey(initial));
        this.io.hydrate(initial.dispatchIntent);
        const evidence = await this.io.query(initial.dispatchIntent);
        guard();
        await this.applyEvidence(evidence);
        return;
      }
      this.requireOrigin(initial);
      let take = this.store.get(id)!;
      if (!take.transcription) {
        await this.store.setDelivery(id, {
          phase: 'uploading',
          error: undefined,
          retryAt: null,
        });
        guard();
        const result = await this.io.transcribe({
          recording: {
            uri: this.store.audioUri(take),
            mime: take.audio!.mime,
            durationS: take.capturedAudioMs / 1000,
            bytes: take.audio!.bytes,
          },
          transcribeRequestId: `transcribe-${id}`,
          tags: { stream_id: take.origin.streamId, recording_id: id },
          take,
          store: this.store,
          isCancelled: () =>
            !this.store.isCurrent(id, epoch) || runtime !== this.runtimeEpoch || !this.enabled(),
          onStage: async (stage: 'uploading' | 'transcribing') => {
            guard();
            await this.store.setDelivery(id, { phase: stage });
            guard();
          },
        });
        guard();
        if (!result.transcript.text.trim()) throw new Error(NOTHING_RECOGNIZED_MESSAGE);
        await this.store.saveTranscription(id, {
          blobSha: result.blobSha,
          requestId: `transcribe-${id}`,
          result: result.transcript,
        });
        guard();
        take = this.store.get(id)!;
      }
      if (!take.transcription!.result.text.trim()) throw new Error(NOTHING_RECOGNIZED_MESSAGE);
      if (take.draft.images.length && !take.attachments) {
        if (!this.io.uploadImages) throw new VoiceStorageError('image_upload_unavailable');
        const images = this.store.images(take);
        const transport = this.io.transport();
        if (!transport.credentialId) throw new VoiceStorageError('auth_needed');
        if (
          voiceScopeHash({
            serverIdentity: transport.serverIdentity,
            credentialId: transport.credentialId,
          }) !== take.scopeHash
        )
          throw new VoiceStorageError('voice_suspended');
        const uploaded = await this.io.uploadImages(images, {
          isCancelled: () => {
            try {
              guard();
              return false;
            } catch {
              return true;
            }
          },
          scope: {
            serverIdentity: transport.serverIdentity,
            credentialId: transport.credentialId,
            scopeGeneration: transport.scopeGeneration,
            socketGeneration: transport.socketGeneration,
          },
        });
        guard();
        // Persist only wire attachment references. Owned image URIs stay local to the take projection.
        await this.store.saveAttachments(
          id,
          uploaded.map((a) => ({
            key: a.key,
            mime: a.mime,
            ...(a.width !== undefined ? { width: a.width } : {}),
            ...(a.height !== undefined ? { height: a.height } : {}),
            ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
          })),
        );
        guard();
        take = this.store.get(id)!;
      }
      this.requireOrigin(take);
      guard();
      const text = [take.draft.textPrefix, take.transcription!.result.text.trim()]
        .filter(Boolean)
        .join('\n');
      const meta = {
        voice: { duration_s: take.capturedAudioMs / 1000 },
        ...(take.operation.operation_kind === 'voice_answer'
          ? {
              voice_answers: {
                version: 1,
                recording_id: id,
                blob_sha: take.transcription!.blobSha,
                duration_s: take.capturedAudioMs / 1000,
                items: take.frozenAnswers ?? [],
              },
            }
          : {}),
      };
      if (take.operation.operation_kind === 'voice_answer' && !take.frozenAnswers?.length)
        throw new VoiceStorageError('no_answers');
      const intent = this.io.prepare({
        recordingId: id,
        sequence: take.sequence,
        streamId: take.origin.streamId,
        originGeneration: take.origin.generation,
        text,
        operationId: id,
        meta,
        ...(take.attachments?.length ? { attachments: take.attachments } : {}),
      });
      await this.store.saveDispatchIntent(id, intent);
      guard();
      this.io.hydrate(intent);
      guard();
      const evidence = await this.io.dispatch(intent);
      guard();
      await this.applyEvidence(evidence);
    } catch (error) {
      await this.handleFailure(id, error, !!this.store.get(id)?.dispatchIntent);
    } finally {
      await this.proofWrites.get(id);
    }
  }
  private async handleFailure(id: string, error: unknown, hasIntent: boolean) {
    const t = this.store.get(id);
    if (!t || errorCode(error) === 'voice_cancelled') return;
    try {
      if (hasIntent) {
        // Persisted intent is an ambiguity boundary even when dispatch threw synchronously.
        await this.store.setDelivery(id, {
          phase: 'checking',
          retryAt: null,
          error: undefined,
        });
        voiceLifecycle(id, 'receipt', 'stalled');
        return;
      }
      if (authFailure(error)) {
        await this.store.setDelivery(id, {
          phase: 'auth_needed',
          retryAt: null,
          error: 'auth_needed',
        });
        voiceLifecycle(id, 'delivery', 'stalled', { error: 'auth_needed' });
        return;
      }
      if (t.delivery.phase === 'transcribing' && /timed out|timeout/i.test(errorCode(error))) {
        await this.store.setDelivery(id, {
          phase: 'failed',
          retryAt: null,
          error: 'transcribe_timeout',
        });
        voiceLifecycle(id, 'transcribe', 'failed', {
          error: 'transcribe_timeout',
        });
        return;
      }
      if (transportFailure(error)) {
        const retryCount = t.delivery.retryCount + 1;
        const retryAt = this.now() + DELAYS[Math.min(retryCount - 1, DELAYS.length - 1)];
        await this.store.setDelivery(id, {
          phase: 'queued',
          retryCount,
          retryAt,
          error: undefined,
        });
        voiceLifecycle(id, 'delivery', 'queued', { retry_state: retryCount });
        return;
      }
      const origin =
        errorCode(error) === 'origin_unavailable' ||
        errorCode(error) === 'origin_unverifiable' ||
        errorCode(error) === 'voice_origin_unavailable';
      const code = origin
        ? 'origin_unavailable'
        : errorCode(error) === NOTHING_RECOGNIZED_MESSAGE
          ? 'no_speech'
          : DELIVERY_ERROR_CODES.has(errorCode(error))
            ? errorCode(error)
            : 'voice_failed';
      await this.store.setDelivery(id, {
        phase: origin ? 'origin_unavailable' : 'failed',
        retryAt: null,
        error: code,
      });
      voiceLifecycle(id, 'delivery', 'failed', { error: code });
    } catch (storageError) {
      this.storageFailure(storageError);
      voiceLifecycle(id, 'storage', 'failed', {
        error: 'storage_write_failed',
      });
    }
  }
  private applyEvidence(evidence: stream.VoiceSendEvidence): Promise<void> {
    const previous = this.proofWrites.get(evidence.recordingId) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(async () => {
        const t = this.store.get(evidence.recordingId),
          intent = t?.dispatchIntent;
        if (
          !t ||
          !intent ||
          evidence.requestId !== intent.requestId ||
          evidence.streamId !== t.origin.streamId ||
          evidence.generation !== t.origin.generation
        )
          return;
        if (evidence.msgId && intent.msgId && evidence.msgId !== intent.msgId) return;
        if (evidence.state === 'landed') {
          await this.store.landed(t.recordingId);
          this.clearStorageFailure();
          releaseVoiceAnswersBinding(t.recordingId);
          this.io.forget(intent);
          voiceLifecycle(t.recordingId, 'receipt', 'landed');
        } else if (evidence.state === 'not_landed') {
          await this.store.setDelivery(t.recordingId, {
            phase: 'not_landed',
            retryAt: null,
            error: undefined,
          });
          voiceLifecycle(t.recordingId, 'receipt', 'not_landed');
        } else if (t.delivery.phase !== 'not_landed') {
          await this.store.setDelivery(t.recordingId, {
            phase: 'checking',
            retryAt: null,
            error: undefined,
          });
          voiceLifecycle(t.recordingId, 'receipt', 'stalled');
        }
      })
      .catch((error) => this.storageFailure(error));
    this.proofWrites.set(evidence.recordingId, work);
    return work;
  }
  private scheduleRetry() {
    if (!this.enabled()) return;
    const times = this.store
      .snapshot()
      .takes.filter(
        (t) =>
          !t.dispatchIntent &&
          t.sendRequestedAt !== null &&
          t.delivery.phase === 'queued' &&
          this.io.origin(t.origin.streamId, t.origin.generation) === 'available' &&
          t.delivery.retryAt !== null,
      )
      .map((t) => t.delivery.retryAt!);
    if (!times.length) return;
    const delay = Math.max(1, Math.min(...times) - this.now());
    this.timer = (this.io.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }
  private intentText(intent: stream.VoiceDispatchIntent): string {
    return String(intent.payload.text ?? intent.payload.message ?? '');
  }
  dispose() {
    this.disposed = true;
    this.runtimeEpoch++;
    this.stopTimer();
    for (const stop of this.stopSubscriptions) stop();
    this.stopSubscriptions = [];
  }
}
const defaultIO: VoiceDeliveryIO = {
  transcribe: runVoiceUploadTranscribe,
  uploadImages: async (assets, context) => {
    const attachments: ChatAttachment[] = [];
    const guard = () => {
      if (context.isCancelled()) throw new VoiceStorageError('voice_cancelled');
    };
    for (const asset of assets) {
      guard();
      const dataBase64 = await readAttachmentBase64(asset.uri);
      guard();
      const uploaded = await stream.uploadVoiceImageBase64(dataBase64, asset.bytes, context);
      guard();
      attachments.push({
        key: uploaded.blob_sha,
        mime: asset.mimeType,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        bytes: asset.bytes,
      });
    }
    return attachments;
  },
  prepare: (...args) => stream.prepareVoiceDispatchIntent(...args),
  hydrate: (...args) => stream.hydrateVoiceDispatchIntent(...args),
  dispatch: (...args) => stream.dispatchVoiceDispatchIntent(...args),
  query: (...args) => stream.queryVoiceDispatchReceipt(...args),
  forget: (...args) => stream.forgetVoiceDispatchIntent(...args),
  transport: () => stream.voiceTransportSnapshot(),
  origin: (...args) => stream.voiceOriginStatus(...args),
  subscribeTransport: (fn) => stream.subscribeVoiceTransport(fn),
  subscribeEvidence: (fn) => stream.subscribeVoiceSendEvidence(fn),
};
export const voiceDelivery = new VoiceDelivery(defaultIO);
export function useVoiceDelivery() {
  return useSyncExternalStore(
    voiceDelivery.subscribe,
    voiceDelivery.snapshot,
    voiceDelivery.snapshot,
  );
}
export function voiceTakeRow(take: VoiceTake): PentacleTranscriptItem {
  return {
    id: `voice:${take.recordingId}`,
    timestampLabel: new Date(take.createdAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    label: 'You',
    tone: 'user',
    provider: '',
    source: 'voice',
    text: '',
    kind: 'USER',
    isUser: true,
    eventCase: 'USER',
    displayRule: 'bubble:user',
    voice: { duration_s: take.durationS },
  };
}
/** Generic timeline Retry cannot rotate voice request IDs or retranscribe retained work. */
export async function retryVoiceMessage(
  id: string,
  retry: (id: string) => Promise<boolean>,
): Promise<boolean> {
  const take = voiceTakeStore.snapshot().takes.find((t) => t.dispatchIntent?.optimisticId === id);
  if (!take) return retry(id);
  await voiceDelivery.retry(take.recordingId);
  return !voiceTakeStore.get(take.recordingId);
}
