import { requireOptionalNativeModule } from 'expo-modules-core';

/** Binary-reviewed capture revision. Never inferred from a dependency or permission. */
export const ACCEPTED_CAPTURE_REVISION = 1;
export type CaptureState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'discarded' | 'interrupted' | 'capped';
export type CaptureStatus = {
  state: CaptureState;
  reason: string | null;
  pauseEpoch: number;
  capturedMs: number;
  metering: number | null;
  uri: string | null;
  /** Opaque capture-session ID; not the durable take-store recording ID. */
  recordingId: string | null;
};
export type CapturePermission = { granted: boolean; canAskAgain: boolean };
export type NativeVoiceCapture = {
  getCaptureContract(): unknown;
  getStatus(): CaptureStatus;
  getAdmission(recordingId: string): number;
  revokeAdmissions(recordingId: string): void;
  getPermission(): Promise<CapturePermission>;
  requestPermission(): Promise<CapturePermission>;
  start(recordingId: string, admission: number): Promise<CaptureStatus>;
  resume(recordingId: string, pauseEpoch: number, admission: number): Promise<CaptureStatus>;
  pause(recordingId: string): Promise<CaptureStatus>;
  stop(recordingId: string): Promise<CaptureStatus>;
  discard(recordingId: string): Promise<void>;
};

export function nativeVoiceCapture(): NativeVoiceCapture | null {
  return requireOptionalNativeModule<NativeVoiceCapture>('PentacleVoiceCapture');
}

/** Synchronous and deliberately untrusted until the engine validates every field. */
export function getCaptureContract(): unknown {
  return nativeVoiceCapture()?.getCaptureContract() ?? null;
}
