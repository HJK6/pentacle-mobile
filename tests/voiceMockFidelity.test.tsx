// Voice-mode fidelity to the operator's Claude Design mock (project b5cb34c4,
// "Pentacle Chats.html" → pentacle-proto-screens.jsx `Composer`, `VoiceBubble`,
// user-row caption). Each test pins one element of the mock's visual contract;
// spec: pentacle-mobile__voice_mockup_ui_fidelity_2026_09 § Discrepancies.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ComposerBar, TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import RecordingStrip from '../src/components/voice/RecordingStrip';
import RecordingPill from '../src/components/voice/RecordingPill';
import VoiceBubble from '../src/components/voice/VoiceBubble';
import Bevel from '../src/components/Bevel';
import { voiceRecorder } from '../src/services/voiceRecordingEngine';
import { voiceDelivery, voiceTakeRow } from '../src/services/voiceDelivery';
import { initialPentacleStreamState } from 'pentacle-chat-core';
import { Tokens } from '../constants/Colors';

const G = Tokens.palette.green;
const mockState = { ...initialPentacleStreamState, connected: true, hasHydrated: true,
  sessions: [{ stream_id: 'hoste:origin', host: 'hoste', session_name: 'origin', provider: 'codex', title: 'Origin', last_event_at: '2026-09-26T08:00:00Z', online: true }],
  events: [] };
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => mockState,
  appendOptimisticUserMessage: jest.fn(() => 'optimistic-voice'),
  sendPentacleMessage: jest.fn().mockResolvedValue(true),
  uploadBlobBase64: jest.fn().mockResolvedValue({ blob_sha: 'voice-sha' }),
  transcribeBlob: jest.fn(() => new Promise(() => {})),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(mockState),
  usePentacleStreamActions: () => ({}),
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('AUDIO'),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

const props = { host: 'hoste', chrome: hostChrome('hoste'), disabled: false, dismissToken: 0, refocusToken: 0, onFocus: jest.fn(), onSend: jest.fn().mockResolvedValue(undefined), onError: jest.fn() };
const flat = (node: any) => StyleSheet.flatten(node.props.style) ?? {};

beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await act(async () => {
    await voiceRecorder.discard();
    for (const take of voiceDelivery.snapshot().takes) voiceDelivery.discard(take.recordingId);
    voiceDelivery.clearLast();
  });
  jest.useRealTimers();
});

describe('composer mic (mock Composer button)', () => {
  test('idle mic uses the mock outline mic glyph, not the solid icon font', () => {
    const view = render(<ComposerBar {...props} streamId="hoste:origin" />);
    const mic = view.getByTestId('composer-mic-button');
    expect(view.getByTestId('voice-mic-glyph')).toBeTruthy();
    expect(mic.findAll((n: any) => n.type === 'FontAwesome')).toHaveLength(0);
  });

  test('recording: round filled stop button with two pulsing rings and an ink glyph', async () => {
    const view = render(<ComposerBar {...props} streamId="hoste:origin" />);
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    const mic = view.getByTestId('composer-mic-button');
    const style = flat(mic);
    expect(style.width).toBe(style.height);
    expect(style.borderRadius).toBe(style.width / 2);
    expect(style.backgroundColor).toBe(G);
    expect(view.getByTestId('voice-record-ring-0')).toBeTruthy();
    expect(view.getByTestId('voice-record-ring-1')).toBeTruthy();
    expect(mic.props.accessibilityLabel).toBe('Stop and send');
  });

  test('recording: the capsule itself takes the recording tint; the strip is not a nested bordered box', async () => {
    const view = render(<ComposerBar {...props} streamId="hoste:origin" />);
    await act(async () => fireEvent.press(view.getByTestId('composer-mic-button')));
    expect(flat(view.getByTestId('composer-capsule')).borderColor).toBe(`${G}66`);
    expect(flat(view.getByTestId('voice-recording-strip')).borderWidth ?? 0).toBe(0);
    expect(view.queryByTestId('composer-plus-button')).toBeNull();
  });
});

describe('RecordingStrip (mock recording strip)', () => {
  test('bars are 2.5 wide, height = level × 26, opacity 0.45 + 0.55 × level', () => {
    const view = render(<RecordingStrip displayLevels={[0.5, 1]} sampleCount={2} durationS={3} onDiscard={() => {}} />);
    const bars = view.getAllByTestId(/^voice-recording-strip-bar-/);
    expect(bars).toHaveLength(2);
    const last = flat(bars[1]);
    expect(last.width).toBe(2.5);
    expect(last.height).toBe(26);
    expect(last.opacity).toBeCloseTo(1);
    expect(flat(bars[0]).height).toBe(13);
  });
});

describe('pending TRANSCRIBING row (mock VoiceBubble + caption)', () => {
  test('voice bubble sits on the user side (right-aligned)', () => {
    const view = render(<VoiceBubble levels={[0.4]} durationS={7} />);
    expect(flat(view.getByTestId('voice-bubble')).alignSelf).toBe('flex-end');
  });

  test('caption is a muted spinner + TRANSCRIBING in 9pt mono, not the amber send indicator', async () => {
    const composer = render(<ComposerBar {...props} streamId="hoste:origin" />);
    await act(async () => fireEvent.press(composer.getByTestId('composer-mic-button')));
    await act(async () => fireEvent.press(composer.getByTestId('composer-mic-button')));
    const pending = voiceDelivery.snapshot().takes[0];
    expect(pending?.status).toBe('transcribing');
    const row = render(<TranscriptRow item={voiceTakeRow(pending)} chrome={props.chrome} />);
    expect(row.getByTestId('voice-transcribing-spinner')).toBeTruthy();
    const label = flat(row.getByText('TRANSCRIBING'));
    expect(label.color).toBe(Tokens.palette.muted);
    expect(label.fontSize).toBe(9);
    expect(label.letterSpacing).toBe(1);
  });
});

describe('transcribed caption (mock "Transcribed from voice")', () => {
  test('green mic glyph + green 9pt duration', () => {
    const row = render(<TranscriptRow item={{ id: 'echo:1', kind: 'USER', isUser: true, text: 'durable transcript', voice: { duration_s: 7 } } as any} chrome={props.chrome} />);
    const caption = row.getByTestId('voice-message-caption');
    expect(caption.findAll((n: any) => n.props?.testID === 'voice-mic-glyph').length).toBeGreaterThan(0);
    const duration = flat(row.getByText('0:07'));
    expect(duration.color).toBe(G);
    expect(duration.fontSize).toBe(9);
  });
});

describe('cross-chat pill (mock visual language)', () => {
  test('beveled chip, not a rounded capsule', () => {
    const view = render(<RecordingPill durationS={5} onReturn={() => {}} />);
    expect(flat(view.getByTestId('voice-recording-pill')).borderRadius ?? 0).toBe(0);
    expect(view.UNSAFE_getAllByType(Bevel)).toHaveLength(1);
  });
});
