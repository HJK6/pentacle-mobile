jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Feed the chat-core package its hostconfig data source so the moved chat-model
// selectors (getHostOrder/getHostTheme) resolve through mobile's config/local
// exactly as before the move. config/local is `require`d LAZILY inside the
// provider functions (not imported at the top of this setup file) so that each
// suite's per-file `jest.mock('expo-constants', ...)` is in effect by the time
// config/local first reads Expo config — a top-level import here would bind
// config/local to the real expo-constants before any test file's mock applies.
import { setHostConfigProvider } from 'pentacle-chat-core';

setHostConfigProvider({
  getHostOrder: (state) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostOrder(state),
  getHostTheme: (host) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostTheme(host),
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// Mock only the device boundary; recording/delivery state machines remain real.
jest.mock('expo-audio', () => ({
  AudioModule: {
    AudioRecorder: jest.fn().mockImplementation(() => ({
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      record: jest.fn(), stop: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn(() => ({ isRecording: true, durationMillis: 3000, metering: -20 })),
      uri: 'file:///voice-take.m4a',
    })),
    getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}));
