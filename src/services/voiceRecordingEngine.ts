import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { voiceDelivery } from './voiceDelivery';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  type RecordingOptions,
} from 'expo-audio';

import { VoiceRecorder, type RecordingEngine, type VoicePermission } from './voiceRecording';

// Thin expo-audio adapter behind the RecordingEngine interface. The recording
// STATE MACHINE (start/stop/discard/metering/cap) is tested engine-agnostically
// in voiceRecording.test.ts; this file is the device-coupled boundary and is
// validated on the paired phone (acceptance gate C1), not in jest.
//
// Capture profile per § Journey: AAC/M4A, mono, 16 kHz, ~32 kbps (~240 KB/min)
// with metering enabled, so a 5-minute take stays well under the 4 MiB frame and
// 64 MiB blob caps and faster-whisper/MLX decodes the M4A directly.

const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
};

// Normalize expo-audio's dBFS metering (roughly [-60, 0]) into [0, 1].
const METER_FLOOR_DB = -60;
function normalizeMeter(db: number | undefined): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  return (clamped - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

function mapPermission(status: { granted: boolean; canAskAgain?: boolean }): VoicePermission {
  if (status.granted) return 'granted';
  if (status.canAskAgain === false) return 'denied';
  return 'undetermined';
}

class ExpoAudioEngine implements RecordingEngine {
  readonly mime = 'audio/mp4';
  private recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  private appStateSubscription: { remove: () => void } | null = null;

  async requestPermission(): Promise<VoicePermission> {
    return mapPermission(await AudioModule.requestRecordingPermissionsAsync());
  }

  async getPermission(): Promise<VoicePermission> {
    return mapPermission(await AudioModule.getRecordingPermissionsAsync());
  }

  async start(): Promise<void> {
    if (!this.appStateSubscription) {
      this.appStateSubscription = AppState.addEventListener('change', state => {
        if (state !== 'active' && voiceRecorder.snapshot()?.status === 'recording') {
          void voiceRecorder.stop('background').catch(() => undefined);
        }
      });
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const recorder = new AudioModule.AudioRecorder(RECORDING_OPTIONS);
    await recorder.prepareToRecordAsync();
    recorder.record();
    this.recorder = recorder;
  }

  poll(): { level: number; durationMs: number; interrupted?: boolean } {
    const status = this.recorder?.getStatus();
    return {
      level: normalizeMeter(status?.metering),
      durationMs: status?.durationMillis ?? 0,
      interrupted: status?.isRecording === false,
    };
  }

  async stop(): Promise<{ uri: string; durationMs: number; bytes?: number }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('no_active_recording');
    const capturedDurationMs = recorder.getStatus()?.durationMillis ?? 0;
    await recorder.stop();
    const uri = recorder.uri ?? '';
    const durationMs = capturedDurationMs || recorder.getStatus()?.durationMillis || 0;
    this.recorder = null;
    // Release the recording audio mode so playback is unaffected afterwards.
    await setAudioModeAsync({ allowsRecording: false });
    return { uri, durationMs };
  }

  async discard(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      const uri = recorder.uri;
      try {
        await recorder.stop();
      } catch {
        // already stopped / never started — nothing to release
      }
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
    }
    await setAudioModeAsync({ allowsRecording: false });
  }
}

/** App singleton recorder wired to the real expo-audio engine. */
export const voiceRecorder = new VoiceRecorder(new ExpoAudioEngine());

// These subscriptions belong to the app process, never to a screen mount.
voiceRecorder.subscribeStopped(take => { void voiceDelivery.accept(take); });
