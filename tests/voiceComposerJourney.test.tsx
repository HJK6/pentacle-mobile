jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import React from 'react';
import { Linking } from 'react-native';
import { PermissionDeniedError } from '../src/services/voiceRecording';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ComposerBar, TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import UnifiedScreen from '../app/(tabs)/unified';
import { voiceRecorder, setVoiceLifecycle } from '../src/services/voiceRecordingEngine';
import { uuid } from 'expo-modules-core';
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
const mockSend = jest.fn().mockResolvedValue({ delivery: 'landed' });
const mockTranscribe = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/pentacleStream', () => require('./questions/voiceHarness').makeVoiceTransportMock(() => mockState, (...args: unknown[]) => mockTranscribe(...args), (...args: unknown[]) => mockSend(...args)));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('expo-file-system/legacy', () => require('./questions/voiceHarness').makeVoiceCaptureFsMock((...args: unknown[]) => mockDelete(...args)));
jest.mock('../modules/pentacle-voice-capture', () => {
  let next = 0; let admission = 0;
  let status: any = { state: 'idle', reason: null, recordingId: null, pauseEpoch: 0, capturedMs: 0, uri: null, metering: -20 };
  const contract = { contract: 'pentacle-voice-capture', revision: 1, nativeBuild: '101' };
  const native = {
    getCaptureContract: () => contract, getStatus: () => ({ ...status }),
    getAdmission: () => admission, revokeAdmissions: () => { admission++; },
    getPermission: async () => ({ granted: true, canAskAgain: true }), requestPermission: async () => ({ granted: true, canAskAgain: true }),
    start: async (id: string, token: number) => {
      if (token !== admission) throw new Error('cancelled');
      const uri = `file:///cache/voice-${++next}.m4a`;
      const box = (kind: string, payload: string) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(kind, 4); b.write(payload, 8); return b; };
      require('expo-file-system/legacy').__files.set(uri, Buffer.concat([box('ftyp', 'M4A \0\0\0\0'), box('moov', 'synthetic'), box('mdat', 'audio')]));
      status = { state: 'recording', reason: null, recordingId: id, pauseEpoch: 0, capturedMs: 3000, uri, metering: -20 }; return { ...status };
    },
    pause: async () => { if (status.state === 'recording') { status.state = 'paused'; status.pauseEpoch++; } return { ...status }; },
    resume: async (_id: string, epoch: number, token: number) => { if (token !== admission || epoch !== status.pauseEpoch) throw new Error('cancelled'); status.state = 'recording'; return { ...status }; },
    stop: async () => { status.state = 'stopped'; return { ...status }; }, discard: async () => { status.state = 'discarded'; },
  };
  return { ACCEPTED_CAPTURE_REVISION: 1, getCaptureContract: () => contract, nativeVoiceCapture: () => native };
});
jest.mock('../src/config/appIdentity', () => ({ getAppIdentity: () => ({ version: '1', buildNumber: '101' }) }));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

let resolveTranscript: (value: any) => void;
let telemetry: TelemetryPayload[];
let fixtureId = 0;
beforeEach(() => {
  jest.spyOn(uuid, 'v4').mockImplementation(() => `123e4567-e89b-42d3-a456-${String(++fixtureId).padStart(12, '0')}`);
  setVoiceLifecycle({ foreground: true, unlocked: true });
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
    for (const take of voiceDelivery.snapshot().takes) await voiceDelivery.discard(take.recordingId);
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
  await act(async () => { resolveTranscript({ text: 'Hello Juniper', model: 'large-v3', vocabulary_version: 'fleet-v1', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith({ streamId: 'hosta:origin', text: 'Hello Juniper', optimisticId: 'optimistic-voice', originGeneration: 'generation-1', meta: { voice: { duration_s: 3 } } });
  expect(mockDelete).toHaveBeenCalledWith(expect.stringContaining('audio.m4a'), { idempotent: true });
  expect(telemetry.filter(e => String(e.message) === 'voice_delivery:lifecycle' && e.data.stage === 'receipt').map(e => e.data.state)).toEqual(['landed']);
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
  await act(async () => { resolveTranscript({ text: 'must not send', model: 'large-v3', vocabulary_version: 'v1' }); await voiceDelivery.drain(); });
  expect(mockSend).not.toHaveBeenCalled();
  expect(voiceDelivery.snapshot().takes).toHaveLength(0);
  expect(telemetry.some(e => e.data.state === 'cancelled')).toBe(true);
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
  await act(async () => { resolveTranscript({ text: 'origin unified', model: 'large-v3', vocabulary_version: 'v1' }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'hosta:origin', text: 'origin unified', meta: { voice: { duration_s: 3 } } }));
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

test('chat draft survives composer unmount and restores only in its origin', () => {
  const first = render(<ComposerBar {...props} streamId="hosta:origin" />);
  fireEvent.changeText(first.getByTestId('composer-input'), 'Unsent origin draft');
  first.unmount();
  const other = render(<ComposerBar {...props} streamId="hosta:other" />);
  expect(other.getByTestId('composer-input').props.value).toBe('');
  other.unmount();
  const returned = render(<ComposerBar {...props} streamId="hosta:origin" />);
  expect(returned.getByTestId('composer-input').props.value).toBe('Unsent origin draft');
});

test('draft failure after navigation restores only origin and cannot resurrect a newer cleared edit', async () => {
  let reject!: (error: Error) => void;
  const send = jest.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const view = render(<ComposerBar {...props} onSend={send} streamId="hosta:failed-draft" />);
  fireEvent.changeText(view.getByTestId('composer-input'), 'old');
  fireEvent.press(view.getByTestId('composer-send-button'));
  view.rerender(<ComposerBar {...props} onSend={send} streamId="hosta:other-draft" />);
  fireEvent.changeText(view.getByTestId('composer-input'), 'other');
  await act(async () => reject(new Error('definite failure')));
  expect(view.getByTestId('composer-input').props.value).toBe('other');
  view.rerender(<ComposerBar {...props} onSend={send} streamId="hosta:failed-draft" />);
  expect(view.getByTestId('composer-input').props.value).toBe('old');
  fireEvent.press(view.getByTestId('composer-send-button'));
  fireEvent.changeText(view.getByTestId('composer-input'), 'new');
  fireEvent.changeText(view.getByTestId('composer-input'), '');
  await act(async () => reject(new Error('late failure')));
  expect(view.getByTestId('composer-input').props.value).toBe('');
});

test('a replacement origin generation cannot receive an in-flight voice transcript', async () => {
  const origin = mockState.sessions[0] as typeof mockState.sessions[0] & { session_generation?: string };
  origin.session_generation = 'original';
  try {
    const view = render(<ComposerBar {...props} streamId="hosta:origin-generation-test" />);
    // Use the actual known origin after clearing a prior test's retained draft.
    view.rerender(<ComposerBar {...props} streamId="hosta:origin" />);
    fireEvent.changeText(view.getByTestId('composer-input'), '');
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    origin.session_generation = 'replacement';
    await act(async () => { resolveTranscript({ text: 'must remain retained', model: 'test', vocabulary_version: 'test' }); await voiceDelivery.drain(); });
    expect(mockSend).not.toHaveBeenCalled();
    expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'origin_unavailable', error: 'Original chat unavailable' });
  } finally { delete origin.session_generation; }
});

test('R10 a queued take awaiting ASR does not block a new independently owned capture', async () => {
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  fireEvent.changeText(view.getByTestId('composer-input'), '');
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  const first = voiceRecorder.snapshot()!.recordingId;
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceDelivery.snapshot().takes.find(take => take.recordingId === first)?.status).toBe('transcribing');
  const firstTranscript = resolveTranscript;
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceRecorder.snapshot()).toMatchObject({ streamId: 'hosta:origin', status: 'recording' });
  expect(voiceRecorder.snapshot()!.recordingId).not.toBe(first);
  expect(mockSend).not.toHaveBeenCalled();
  await act(async () => { await voiceRecorder.discard(); firstTranscript({ text: 'First take', model: 'test', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledTimes(1);
});
