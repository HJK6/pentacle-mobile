jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import React from 'react';
import { Linking } from 'react-native';
import { PermissionDeniedError } from '../src/services/voiceRecording';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ComposerBar, TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import UnifiedScreen from '../app/(tabs)/unified';
import { voiceRecorder } from '../src/services/voiceRecordingEngine';
import { voiceDelivery, voiceTakeRow } from '../src/services/voiceDelivery';
import { initialPentacleStreamState, setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';

const mockState = { ...initialPentacleStreamState, connected: true, hasHydrated: true,
  sessions: [
    { stream_id: 'hosta:origin', host: 'hosta', session_name: 'origin', provider: 'codex', title: 'Origin', last_event_at: '2026-09-26T08:00:00Z', online: true },
    { stream_id: 'hosta:other', host: 'hosta', session_name: 'other', provider: 'codex', title: 'Other', last_event_at: '2026-09-26T08:00:00Z', online: true },
  ], events: [
    { stream_id: 'hosta:origin', host: 'hosta', session_name: 'origin', provider: 'codex', timestamp: '2026-09-26T08:00:00Z', daemon_seq: 1, kind: 'ASSIST', text: 'Origin reply' },
    { stream_id: 'hosta:other', host: 'hosta', session_name: 'other', provider: 'codex', timestamp: '2026-09-26T08:01:00Z', daemon_seq: 2, kind: 'ASSIST', text: 'Other reply' },
  ],
};
const mockSend = jest.fn().mockResolvedValue(true);
const mockTranscribe = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => mockState,
  appendOptimisticUserMessage: jest.fn(() => 'optimistic-voice'),
  sendPentacleMessage: (...args: unknown[]) => mockSend(...args),
  uploadBlobBase64: jest.fn().mockResolvedValue({ blob_sha: 'voice-sha' }),
  transcribeBlob: (...args: unknown[]) => mockTranscribe(...args),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(mockState),
  usePentacleStreamActions: () => ({}),
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('AUDIO'),
  deleteAsync: (...args: unknown[]) => mockDelete(...args),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

let resolveTranscript: (value: any) => void;
let telemetry: TelemetryPayload[];
beforeEach(() => {
  jest.useFakeTimers();
  mockSend.mockClear();
  mockDelete.mockClear();
  mockTranscribe.mockImplementation(() => new Promise(resolve => { resolveTranscript = resolve; }));
  telemetry = [];
  setTelemetrySink(event => telemetry.push(event));
});
afterEach(async () => {
  await act(async () => {
    await voiceRecorder.discard();
    for (const take of voiceDelivery.snapshot().takes) voiceDelivery.discard(take.recordingId);
    voiceDelivery.clearLast();
  });
  setTelemetrySink(null);
  jest.useRealTimers();
});
const props = { host: 'Host A', chrome: hostChrome('hosta'), disabled: false, dismissToken: 0, refocusToken: 0, onFocus: jest.fn(), onSend: jest.fn().mockResolvedValue(undefined), onError: jest.fn() };

test('shared composer swaps empty draft to mic, records while destination changes, sends only transcript to origin', async () => {
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  expect(view.queryByTestId('composer-send-button')).toBeNull();
  fireEvent.changeText(view.getByTestId('composer-input'), 'draft');
  expect(view.queryByTestId('composer-mic-button')).toBeNull();
  fireEvent.changeText(view.getByTestId('composer-input'), '');
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(view.getByTestId('voice-recording-strip')).toBeTruthy();
  expect(view.queryByTestId('composer-input')).toBeNull();
  view.rerender(<ComposerBar {...props} streamId="hosta:other" />);
  expect(view.queryByTestId('voice-recording-strip')).toBeNull();
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceRecorder.activeStreamId()).toBe('hosta:origin');
  expect(voiceDelivery.snapshot().takes).toHaveLength(0);
  expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('already'));
  view.rerender(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceDelivery.snapshot().takes[0].streamId).toBe('hosta:origin');
  await act(async () => resolveTranscript({ text: 'Hello Juniper', model: 'large-v3', vocabulary_version: 'fleet-v1', duration_s: 3 }));
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith({ host: 'hosta', sessionName: 'origin', text: 'Hello Juniper', optimisticId: 'optimistic-voice', meta: { voice: { duration_s: 3 } } });
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(telemetry.filter(e => e.message === 'chat.voice.send_outcome').map(e => e.data.outcome)).toEqual(['landed']);
});

test('pending row renders waveform, cancellation removes it and prevents late send; durable voice text has caption', async () => {
  const composer = render(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(composer.getByTestId('composer-mic-button')));
  await act(async () => fireEvent.press(composer.getByTestId('composer-mic-button')));
  const take = voiceDelivery.snapshot().takes[0];
  const row = render(<TranscriptRow item={voiceTakeRow(take)} chrome={props.chrome} />);
  expect(row.getByText('TRANSCRIBING')).toBeTruthy();
  expect(row.getByTestId('voice-bubble')).toBeTruthy();
  await act(async () => fireEvent.press(row.getByTestId('voice-transcription-discard')));
  await act(async () => resolveTranscript({ text: 'must not send', model: 'large-v3', vocabulary_version: 'v1' }));
  expect(mockSend).not.toHaveBeenCalled();
  expect(voiceDelivery.snapshot().takes).toHaveLength(0);
  expect(telemetry.filter(e => e.message === 'chat.voice.transcribe_cancelled')).toHaveLength(1);
  row.rerender(<TranscriptRow item={{ ...voiceTakeRow(take), text: 'durable transcript', id: 'echo:1' }} chrome={props.chrome} />);
  expect(row.queryByTestId('voice-bubble')).toBeNull();
  expect(row.getByTestId('voice-message-caption')).toBeTruthy();
  expect(row.getByText('durable transcript')).toBeTruthy();
});

test('unified real composer pins selected destination through closing/reselecting while recording', async () => {
  const view = render(<UnifiedScreen />);
  fireEvent.press(view.getByTestId('unified-reply-hosta:origin'));
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceRecorder.activeStreamId()).toBe('hosta:origin');
  fireEvent.press(view.getByLabelText('Close reply composer'));
  fireEvent.press(view.getByTestId('unified-reply-hosta:other'));
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceRecorder.activeStreamId()).toBe('hosta:origin');
  expect(voiceDelivery.snapshot().takes).toHaveLength(0);
  fireEvent.press(view.getByLabelText('Close reply composer'));
  fireEvent.press(view.getByTestId('unified-reply-hosta:origin'));
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  await act(async () => resolveTranscript({ text: 'origin unified', model: 'large-v3', vocabulary_version: 'v1' }));
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'origin', text: 'origin unified', meta: { voice: { duration_s: 3 } } }));
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('mic without a selected destination is disabled', () => {
  const view = render(<ComposerBar {...props} />);
  expect(view.getByTestId('composer-mic-button').props.accessibilityState.disabled).toBe(true);
});


test('denied microphone permission stays idle and offers OS Settings recovery', async () => {
  const denied = jest.spyOn(voiceRecorder, 'start').mockRejectedValueOnce(new PermissionDeniedError());
  const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  try {
    const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    expect(voiceRecorder.isActive()).toBe(false);
    expect(view.getByText('Microphone permission is denied.')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByLabelText('Open Settings')));
    expect(settings).toHaveBeenCalledTimes(1);
  } finally { denied.mockRestore(); settings.mockRestore(); }
});
