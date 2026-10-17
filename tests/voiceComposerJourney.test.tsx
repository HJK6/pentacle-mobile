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
import { voiceTakeStore } from '../src/services/voiceTakeStore';
import HeaderVoiceMic from '../src/components/voice/HeaderVoiceMic';
import VoiceRecordingOverlay from '../src/components/voice/VoiceRecordingOverlay';
import PersonalHome from '../src/components/personal/PersonalHome';
import CalendarView from '../src/components/personal/CalendarView';
import QuestionsScreen from '../src/components/questions/QuestionsScreen';
import { twoItemQuestion } from './questions/fixtures';
import { resetVoicePresentationForTests } from '../src/services/voicePresentation';
import { ASSISTANT_STREAM_ID } from '../src/services/assistantIdentity';
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
let mockPermissionPromise: Promise<{ granted: boolean; canAskAgain?: boolean }> | null = null;
let mockNativeStarts = 0;
let mockCapturedMs = 3000;
let mockPathname = '/personal';
jest.mock('../src/services/pentacleStream', () => ({
  ...require('./questions/voiceHarness').makeVoiceTransportMock(() => mockState, (...args: unknown[]) => mockTranscribe(...args), (...args: unknown[]) => mockSend(...args)),
  usePentacleStreamSelector: (selector: (state: unknown) => unknown) => selector(mockState),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('expo-file-system/legacy', () => require('./questions/voiceHarness').makeVoiceCaptureFsMock((...args: unknown[]) => mockDelete(...args)));
jest.mock('../modules/pentacle-voice-capture', () => {
  let next = 0; let admission = 0;
  let status: any = { state: 'idle', reason: null, recordingId: null, pauseEpoch: 0, capturedMs: 0, uri: null, metering: -20 };
  const contract = { contract: 'pentacle-voice-capture', revision: 1, nativeBuild: '101' };
  const native = {
    getCaptureContract: () => contract, getStatus: () => ({ ...status, capturedMs: mockCapturedMs }),
    getAdmission: () => admission, revokeAdmissions: () => { admission++; },
    getPermission: async () => mockPermissionPromise ?? ({ granted: true, canAskAgain: true }), requestPermission: async () => ({ granted: true, canAskAgain: true }),
    start: async (id: string, token: number) => {
      mockNativeStarts++;
      if (token !== admission) throw new Error('cancelled');
      const uri = `file:///cache/voice-${++next}.m4a`;
      const box = (kind: string, payload: string) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(kind, 4); b.write(payload, 8); return b; };
      require('expo-file-system/legacy').__files.set(uri, Buffer.concat([box('ftyp', 'M4A \0\0\0\0'), box('moov', 'synthetic'), box('mdat', 'audio')]));
      status = { state: 'recording', reason: null, recordingId: id, pauseEpoch: 0, capturedMs: 3000, uri, metering: -20 }; return { ...status };
    },
    pause: async () => { if (status.state === 'recording') { status.state = 'paused'; status.pauseEpoch++; } return { ...status }; },
    resume: async (_id: string, epoch: number, token: number) => { if (token !== admission || epoch !== status.pauseEpoch) throw new Error('cancelled'); status.state = 'recording'; return { ...status }; },
    stop: async () => { status.state = 'stopped'; return { ...status, capturedMs: mockCapturedMs }; }, discard: async () => { status.state = 'discarded'; },
  };
  return { ACCEPTED_CAPTURE_REVISION: 1, getCaptureContract: () => contract, nativeVoiceCapture: () => native };
});
jest.mock('../src/config/appIdentity', () => ({ getAppIdentity: () => ({ version: '1', buildNumber: '101' }) }));
jest.mock('expo-router', () => ({ ...require('./helpers/mocks/expoRouter').makeMock(), usePathname: () => mockPathname, useFocusEffect: jest.fn() }));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

let resolveTranscript: (value: any) => void;
let telemetry: TelemetryPayload[];
let fixtureId = 0;
beforeEach(() => {
  resetVoicePresentationForTests();
  mockPermissionPromise = null;
  mockNativeStarts = 0;
  mockCapturedMs = 3000;
  mockPathname = '/personal';
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
  expect(view.getByTestId('voice-recording-strip')).toBeTruthy();
  expect(view.queryByTestId('composer-input')).toBeNull();
  expect(voiceRecorder.activeStreamId()).toBe('hosta:origin');
  await act(async () => fireEvent.press(view.getByLabelText('Stop and send')));
  expect(voiceDelivery.snapshot().takes[0].streamId).toBe('hosta:origin');
  await act(async () => { resolveTranscript({ text: 'Hello Juniper', model: 'large-v3', vocabulary_version: 'fleet-v1', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith({ streamId: 'hosta:origin', text: 'Hello Juniper', optimisticId: 'optimistic-voice', originGeneration: 'generation-1', meta: { voice: { duration_s: 3, context_v1: expect.objectContaining({ visits: expect.any(Array) }) } } });
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
  expect(voiceDelivery.snapshot().takes[0].streamId).toBe('hosta:origin');
  await act(async () => { resolveTranscript({ text: 'origin unified', model: 'large-v3', vocabulary_version: 'v1' }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'hosta:origin', text: 'origin unified', meta: { voice: { duration_s: 3, context_v1: expect.any(Object) } } }));
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a take stuck checking delivery leaves the composer, its mic and Remove local copy usable in every chat', async () => {
  const alert = jest.spyOn(require('react-native').Alert, 'alert');
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  await act(async () => fireEvent.press(view.getByLabelText('Stop and send')));
  // Passive progress belongs to the destination transcript; its composer stays usable.
  expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'transcribing' });
  expect(view.getByTestId('composer-input').props.editable).toBe(true);
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
  // The send frame is lost: dispatch proves nothing and the take waits on its receipt.
  mockSend.mockResolvedValueOnce({ delivery: 'unknown' });
  await act(async () => { resolveTranscript({ text: 'lost frame', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
  const take = voiceDelivery.snapshot().takes[0];
  expect(take).toMatchObject({ status: 'checking' });
  for (const streamId of ['hosta:origin', 'hosta:other']) {
    view.rerender(<ComposerBar {...props} streamId={streamId} />);
    expect(view.getByTestId('composer-input').props.editable).toBe(true);
    expect(view.getByTestId('composer-mic-button').props.accessibilityState.disabled).toBe(false);
    expect(view.getByText(/CHECKING DELIVERY/)).toBeTruthy();
    expect(view.getByLabelText('Check delivery again')).toBeTruthy();
    expect(view.getByLabelText('Remove local copy')).toBeTruthy();
  }
  fireEvent.changeText(view.getByTestId('composer-input'), 'typed while waiting');
  expect(view.getByTestId('composer-input').props.value).toBe('typed while waiting');
  fireEvent.changeText(view.getByTestId('composer-input'), '');
  await act(async () => fireEvent.press(view.getByLabelText('Remove local copy')));
  expect(alert).toHaveBeenCalledWith('Remove local copy?', 'Remove local copy; delivery may already have happened', expect.any(Array));
  const remove = (alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find(button => button.text === 'Remove local copy')!;
  await act(async () => { remove.onPress?.(); await voiceDelivery.drain(); });
  expect(voiceDelivery.snapshot().takes.find(t => t.recordingId === take.recordingId)).toBeUndefined();
  expect(mockSend).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

test('when the daemon has no receipt the chat bar offers Send again, which resends the identical take once', async () => {
  const stream = require('../src/services/pentacleStream');
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  try {
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    await act(async () => fireEvent.press(view.getByLabelText('Stop and send')));
    mockSend.mockResolvedValueOnce({ delivery: 'unknown' });
    await act(async () => { resolveTranscript({ text: 'resend me', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
    const take = voiceDelivery.snapshot().takes[0];
    expect(take).toMatchObject({ status: 'checking', receiptAbsent: false });
    expect(view.getByLabelText('Check delivery again')).toBeTruthy();
    stream.setVoiceReceiptAbsentForTests(true);
    await act(async () => fireEvent.press(view.getByLabelText('Check delivery again')));
    await act(async () => { await voiceDelivery.drain(); });
    expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'checking', receiptAbsent: true });
    expect(view.getByText(/NOT RECEIVED/)).toBeTruthy();
    await act(async () => fireEvent.press(view.getByLabelText('Send again')));
    await act(async () => { await voiceDelivery.drain(); });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]).toEqual(mockSend.mock.calls[0]);
    expect(voiceDelivery.snapshot().takes).toHaveLength(0);
  } finally { stream.setVoiceReceiptAbsentForTests(false); }
});

test('a parked checking take does not stop a new recording from the composer', async () => {
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  await act(async () => fireEvent.press(view.getByLabelText('Stop and send')));
  mockSend.mockResolvedValueOnce({ delivery: 'unknown' });
  await act(async () => { resolveTranscript({ text: 'parked', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'checking' });
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceRecorder.snapshot()).toMatchObject({ streamId: 'hosta:origin', status: 'recording' });
  expect(view.getByTestId('voice-recording-strip')).toBeTruthy();
});

test('mic without a selected destination is disabled', () => {
  const view = render(<ComposerBar {...props} />);
  expect(view.getByTestId('composer-mic-button').props.accessibilityState.disabled).toBe(true);
});

test('header freezes draft and generation before permission; cross-chat handoff preserves the visible draft and measured slot', async () => {
  let permit!: (permission: { granted: boolean; canAskAgain?: boolean }) => void;
  mockPermissionPromise = new Promise(resolve => { permit = resolve; });
  const tree = (streamId: string) => <><HeaderVoiceMic testID="chat-header-mic" /><ComposerBar {...props} streamId={streamId} /></>;
  const view = render(tree('hosta:origin'));
  fireEvent.changeText(view.getByTestId('composer-input'), 'Captured original draft');
  fireEvent(view.getByTestId('composer-draft-layout'), 'layout', { nativeEvent: { layout: { width: 374, height: 96, x: 0, y: 0 } } });
  await act(async () => fireEvent.press(view.getByTestId('chat-header-mic')));
  expect(voiceRecorder.snapshot()).toBeNull();
  expect(mockNativeStarts).toBe(0);
  view.rerender(tree('hosta:other'));
  fireEvent.changeText(view.getByTestId('composer-input'), 'Other chat draft stays');
  await act(async () => { permit({ granted: true, canAskAgain: true }); });
  expect(voiceRecorder.snapshot()).toMatchObject({ streamId: 'hosta:origin', originLabel: 'Origin', status: 'recording' });
  expect(mockNativeStarts).toBe(1);
  expect(view.getAllByTestId('global-voice-bar')).toHaveLength(1);
  expect(require('react-native').StyleSheet.flatten(view.getByTestId('composer-bar').props.style).height).toBe(96);
  expect(view.queryByTestId('voice-bar-drag-region')).toBeNull();
  expect(view.queryByTestId('composer-input')).toBeNull();
  await act(async () => fireEvent.press(view.getByTestId('chat-header-mic')));
  await act(async () => { resolveTranscript({ text: 'Spoken addition', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'hosta:origin', originGeneration: 'generation-1', text: 'Captured original draft\nSpoken addition' }));
  await act(async () => jest.advanceTimersByTime(2800));
  expect(view.getByTestId('composer-input').props.value).toBe('Other chat draft stays');
  view.rerender(tree('hosta:origin'));
  expect(view.getByTestId('composer-input').props.value).toBe('');
  view.rerender(tree('hosta:other'));
  fireEvent.changeText(view.getByTestId('composer-input'), '');
});

test('real Personal, Calendar and Questions ownership produces exact captured-clock visits through next/back and paused chat handoff', async () => {
  mockState.sessions.push({ stream_id: ASSISTANT_STREAM_ID, host: 'hosta', session_name: 'assistant', provider: 'codex', title: 'Guide', last_event_at: '2026-10-12T00:00:00Z', online: true });
  mockState.notifications = [twoItemQuestion('hosta:origin', 'example', { a: { question_id: 'q-example-1' }, b: { question_id: 'q-example-2' } })] as any;
  mockCapturedMs = 0;
  const tree = (page: 'personal' | 'calendar' | 'questions' | 'chat') => <><VoiceRecordingOverlay />
    {page === 'personal' ? <PersonalHome /> : page === 'calendar' ? <CalendarView /> : page === 'questions' ? <QuestionsScreen /> : <ComposerBar {...props} streamId="hosta:other" />}
  </>;
  const view = render(tree('personal'));
  try {
    await act(async () => fireEvent.press(view.getByTestId('header-voice-mic')));
    const recordingId = voiceRecorder.snapshot()!.recordingId;
    expect(voiceRecorder.snapshot()?.streamId).toBe(ASSISTANT_STREAM_ID);
    mockCapturedMs = 3100; mockPathname = '/personal/calendar';
    view.rerender(tree('calendar'));
    mockCapturedMs = 7200;
    view.rerender(tree('questions'));
    mockCapturedMs = 11000;
    fireEvent.press(view.getByTestId('questions-next'));
    const fourVisits = [
      { offset_ms: 0, page_id: 'personal', title: 'Personal' },
      { offset_ms: 3100, page_id: 'calendar', title: 'Calendar' },
      { offset_ms: 7200, page_id: 'questions', title: 'Questions', question_id: 'q-example-1' },
      { offset_ms: 11000, page_id: 'questions', title: 'Questions', question_id: 'q-example-2' },
    ];
    expect(voiceRecorder.snapshot()?.context_v1).toEqual({ visits: fourVisits });
    expect(Buffer.byteLength(JSON.stringify({ visits: fourVisits }), 'utf8')).toBe(306);
    mockCapturedMs = 12000;
    await act(async () => voiceRecorder.pause('background'));
    view.rerender(tree('chat'));
    await act(async () => jest.advanceTimersByTime(30000));
    expect(voiceRecorder.snapshot()?.context_v1).toEqual({ visits: fourVisits });
    expect(view.getAllByTestId('global-voice-bar')).toHaveLength(1);
    expect(view.queryByTestId('voice-bar-drag-region')).toBeNull();
    view.rerender(tree('questions'));
    fireEvent.press(view.getByTestId('questions-next'));
    await act(async () => voiceRecorder.resume());
    expect(voiceRecorder.snapshot()?.context_v1).toEqual({ visits: fourVisits });
    mockCapturedMs = 14000;
    fireEvent.press(view.getByTestId('questions-back'));
    const expected = { visits: [...fourVisits, { offset_ms: 14000, page_id: 'questions', title: 'Questions', question_id: 'q-example-1' }] };
    expect(voiceRecorder.snapshot()?.context_v1).toEqual(expected);
    expect(voiceRecorder.snapshot()).toMatchObject({ recordingId, streamId: ASSISTANT_STREAM_ID });
    expect(mockNativeStarts).toBe(1);
    mockCapturedMs = 15000;
    await act(async () => fireEvent.press(view.getByTestId('questions-voice-mic')));
    await act(async () => { resolveTranscript({ text: 'One plain voice message', model: 'synthetic', duration_s: 15 }); await voiceDelivery.drain(); });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ streamId: ASSISTANT_STREAM_ID, originGeneration: 'generation-1', meta: { voice: { duration_s: 15, context_v1: expected } } }));
    expect(mockSend.mock.calls[0][0].meta.voice_answers).toBeUndefined();
  } finally {
    mockState.sessions.pop(); mockState.notifications = [];
  }
});

test('untitled chat capture never copies a host/device display fallback into context or the recipient label', async () => {
  mockState.sessions.push({ stream_id: 'hosta:untitled', host: 'synthetic-private-device', session_name: 'untitled', provider: 'codex', title: '', last_event_at: '2026-10-12T00:00:00Z', online: true });
  const view = render(<ComposerBar {...props} host="synthetic-private-device" streamId="hosta:untitled" />);
  try {
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    expect(voiceRecorder.snapshot()).toMatchObject({ originLabel: 'Chat', context_v1: { visits: [{ offset_ms: 0, page_id: 'chat', title: 'Chat', entity_id: 'hosta:untitled' }] } });
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    await act(async () => { resolveTranscript({ text: 'Private-host-safe message', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
    expect(JSON.stringify(mockSend.mock.calls[0][0].meta)).not.toContain('synthetic-private-device');
  } finally { mockState.sessions.pop(); }
});

test('cold chat handoff measures the retained multiline draft, hides every draft control, and follows later layout changes', async () => {
  const saved = render(<ComposerBar {...props} streamId="hosta:other" />);
  fireEvent.changeText(saved.getByTestId('composer-input'), 'A saved\nmultiline\ndraft');
  saved.unmount();
  const origin = render(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(origin.getByTestId('composer-mic-button')));
  const id = voiceRecorder.snapshot()!.recordingId;
  origin.unmount();
  const cold = render(<ComposerBar {...props} streamId="hosta:other" />);
  expect(cold.getAllByTestId('global-voice-bar')).toHaveLength(1);
  expect(cold.queryByTestId('composer-input')).toBeNull();
  expect(cold.queryByTestId('composer-send-button')).toBeNull();
  const layout = cold.getByTestId('composer-draft-layout', { includeHiddenElements: true });
  const input = cold.getByTestId('composer-input', { includeHiddenElements: true });
  expect(layout.props).toMatchObject({ pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' });
  expect(input.props).toMatchObject({ editable: false, value: 'A saved\nmultiline\ndraft' });
  expect(require('react-native').StyleSheet.flatten(cold.getByTestId('composer-bar').props.style).height).toBeUndefined();
  for (const height of [125, 94, 75]) {
    fireEvent(layout, 'layout', { nativeEvent: { layout: { width: 374, height, x: 0, y: 0 } } });
    expect(require('react-native').StyleSheet.flatten(cold.getByTestId('composer-bar').props.style).height).toBe(height);
  }
  expect(cold.queryByTestId('voice-bar-drag-region')).toBeNull();
  expect(voiceRecorder.snapshot()).toMatchObject({ recordingId: id, streamId: 'hosta:origin' });
  expect(mockNativeStarts).toBe(1);
  await act(async () => voiceRecorder.discard());
  expect(cold.getByTestId('composer-input').props.value).toBe('A saved\nmultiline\ndraft');
  fireEvent.changeText(cold.getByTestId('composer-input'), '');
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
  const view = render(<><HeaderVoiceMic testID="queued-start-mic" /><ComposerBar {...props} streamId="hosta:origin" /></>);
  fireEvent.changeText(view.getByTestId('composer-input'), '');
  await act(async () => fireEvent.press(view.getByTestId('queued-start-mic')));
  const first = voiceRecorder.snapshot()!.recordingId;
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  expect(voiceDelivery.snapshot().takes.find(take => take.recordingId === first)?.status).toBe('transcribing');
  const firstTranscript = resolveTranscript;
  await act(async () => fireEvent.press(view.getByTestId('queued-start-mic')));
  expect(voiceRecorder.snapshot()).toMatchObject({ streamId: 'hosta:origin', status: 'recording' });
  expect(voiceRecorder.snapshot()!.recordingId).not.toBe(first);
  expect(mockSend).not.toHaveBeenCalled();
  await act(async () => { await voiceRecorder.discard(); firstTranscript({ text: 'First take', model: 'test', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(mockSend).toHaveBeenCalledTimes(1);
});


test('ordinary header capture uses the visible summary title rather than display_name', async () => {
  const original = { ...mockState.sessions[0] };
  try {
    Object.assign(mockState.sessions[0], { title: 'Design review', display_name: 'Analysis session' });
    const view = render(<><HeaderVoiceMic testID="title-header-mic" /><ComposerBar {...props} streamId="hosta:origin" /></>);
    await act(async () => fireEvent.press(view.getByTestId('title-header-mic')));
    const capture = voiceRecorder.snapshot()!;
    expect(capture).toMatchObject({ streamId: 'hosta:origin', originLabel: 'Design review', status: 'recording' });
    expect(voiceTakeStore.get(capture.recordingId)?.origin.label).toBe('Design review');
    expect(mockNativeStarts).toBe(1);
  } finally { mockState.sessions[0] = original; }
});

test('visible detail label freezes before permission and remains frozen after a later rename', async () => {
  const original = { ...mockState.sessions[0] };
  let permit!: (permission: { granted: boolean; canAskAgain?: boolean }) => void;
  mockPermissionPromise = new Promise(resolve => { permit = resolve; });
  try {
    Object.assign(mockState.sessions[0], { title: 'Summary title', display_name: 'Default session name' });
    const tree = (streamId: string, visibleLabel: string) => <><HeaderVoiceMic testID="title-header-mic" /><ComposerBar {...{ ...props, voiceOriginLabel: visibleLabel }} streamId={streamId} /></>;
    const view = render(tree('hosta:origin', 'Hydrated visible title'));
    fireEvent.changeText(view.getByTestId('composer-input'), 'Original nonempty draft');
    await act(async () => fireEvent.press(view.getByTestId('title-header-mic')));
    expect(voiceRecorder.snapshot()).toBeNull();
    expect(mockNativeStarts).toBe(0);
    Object.assign(mockState.sessions[0], { title: 'Renamed during permission' });
    view.rerender(tree('hosta:other', 'Other visible title'));
    fireEvent.changeText(view.getByTestId('composer-input'), 'Untouched other-chat draft');
    await act(async () => { permit({ granted: true, canAskAgain: true }); });
    const capture = voiceRecorder.snapshot()!;
    expect(capture).toMatchObject({ streamId: 'hosta:origin', originLabel: 'Hydrated visible title', status: 'recording' });
    expect(voiceTakeStore.get(capture.recordingId)).toMatchObject({ origin: { streamId: 'hosta:origin', generation: 'generation-1', label: 'Hydrated visible title' }, draft: { textPrefix: 'Original nonempty draft' } });
    view.rerender(tree('hosta:other', 'Renamed after capture'));
    expect(voiceRecorder.snapshot()).toMatchObject({ recordingId: capture.recordingId, originLabel: 'Hydrated visible title' });
    expect(voiceTakeStore.get(capture.recordingId)?.origin.label).toBe('Hydrated visible title');
    expect(mockNativeStarts).toBe(1);
    await act(async () => voiceRecorder.discard());
    expect(view.getByTestId('composer-input').props.value).toBe('Untouched other-chat draft');
  } finally { mockState.sessions[0] = original; }
});

test('a docked bar beside the live composer never duplicates composer test IDs or shows an inert mic', async () => {
  const view = render(<ComposerBar {...props} streamId="hosta:origin" />);
  await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
  await act(async () => fireEvent.press(view.getByLabelText('Stop and send')));
  mockSend.mockResolvedValueOnce({ delivery: 'unknown' });
  await act(async () => { resolveTranscript({ text: 'docked', model: 'synthetic', duration_s: 3 }); await voiceDelivery.drain(); });
  expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ status: 'checking' });
  expect(view.getAllByTestId('composer-mic-button')).toHaveLength(1);
  expect(view.getAllByTestId('composer-capsule')).toHaveLength(1);
  expect(view.getByTestId('global-voice-field')).toBeTruthy();
});
