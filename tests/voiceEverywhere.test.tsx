import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Dimensions, Keyboard, PanResponder, StyleSheet, Text } from 'react-native';
import { initialPentacleStreamState } from 'pentacle-chat-core';
import HeaderVoiceMic from '../src/components/voice/HeaderVoiceMic';
import GlobalVoiceBar from '../src/components/voice/GlobalVoiceBar';
import VoiceRecordingOverlay from '../src/components/voice/VoiceRecordingOverlay';
import RenameChatModal from '../src/components/RenameChatModal';
import {
  clampVoiceDy, resetVoicePresentationForTests, useVoiceSurface, useVoiceChatStart,
  voicePresentationSnapshot, setVoiceBarDy, useVoiceBarVisible, useVoiceBarOccupiesComposer, pressVoiceHeader,
} from '../src/services/voicePresentation';
import { ASSISTANT_STREAM_ID } from '../src/services/assistantIdentity';
import type { RecordingSnapshot } from '../src/services/voiceRecording';

const mockStart = jest.fn(async (..._args: any[]) => 'take-1');
const mockSend = jest.fn(async (_id: string) => undefined);
const mockDiscard = jest.fn(async (_id: string) => undefined);
let mockCapture: RecordingSnapshot | null = null;
const mockCaptureListeners = new Set<(value: RecordingSnapshot | null) => void>();
let mockDelivery: any = { takes: [], heldCount: 0, recoveryFailures: [], last: null };
const mockLandedListeners = new Set<(value: any) => void>();
const mockDeliveryListeners = new Set<() => void>();
let mockLifecycle = { foreground: true, unlocked: true };
const mockLifecycleListeners = new Set<() => void>();
let mockInsets = { top: 24, bottom: 20, left: 0, right: 0 };
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockState = { ...initialPentacleStreamState, sessions: [{ stream_id: ASSISTANT_STREAM_ID, title: 'Guide', session_generation: 'generation-1' }] };
const mockTransport = { ready: true, credentialId: 'credential', serverIdentity: 'synthetic-server', authNeeded: false, inventoryFresh: true, origins: mockState.sessions };
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('../src/services/voiceRecordingEngine', () => ({
  voiceRecorder: { snapshot: () => mockCapture, isActive: () => !!mockCapture, isOwnedByCurrentScope: () => true,
    subscribe: (fn: any) => { mockCaptureListeners.add(fn); fn(mockCapture); return () => mockCaptureListeners.delete(fn); }, start: (...args: any[]) => mockStart(...args), resume: jest.fn() },
  voiceLifecycleSnapshot: () => mockLifecycle,
  subscribeVoiceLifecycle: (fn: any) => { mockLifecycleListeners.add(fn); return () => mockLifecycleListeners.delete(fn); },
  sendVoiceTake: (id: string) => mockSend(id), discardVoiceTake: (id: string) => mockDiscard(id),
}));
jest.mock('../src/services/voiceTakeStore', () => ({ voiceTakeStore: { get: () => ({ recordingId: 'take-1' }) } }));
jest.mock('../src/services/voiceDelivery', () => ({
  voiceDelivery: { subscribeLanded: (fn: any) => { mockLandedListeners.add(fn); return () => mockLandedListeners.delete(fn); } },
  useVoiceDelivery: () => require('react').useSyncExternalStore((fn: any) => { mockDeliveryListeners.add(fn); return () => mockDeliveryListeners.delete(fn); }, () => mockDelivery),
}));
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => mockState, voiceTransportSnapshot: () => mockTransport, voiceOriginStatus: () => 'available', subscribeVoiceTransport: () => () => {},
  usePentacleStreamSelectorWhen: (_active: any, selector: any) => selector(mockState),
}));
const capture = (id = 'take-1', status: RecordingSnapshot['status'] = 'recording'): RecordingSnapshot => ({ recordingId: id, streamId: 'hosta:original', originLabel: 'Original chat', status, durationS: 12, capturedAudioMs: 12000, levels: [0.1,0.5], displayLevels: [0.1,0.5] });
function emitCapture(value: RecordingSnapshot | null) { act(() => { mockCapture = value; mockCaptureListeners.forEach(fn => fn(value)); }); }
function Page({ chat = false, title = 'Personal', priority = 0, entityId, pageId, active = true }: { chat?: boolean; title?: string; priority?: number; entityId?: string; pageId?: string; active?: boolean }) {
  const id = useVoiceSurface({ page_id: pageId ?? (chat ? 'chat' : 'personal'), title, entity_id: entityId }, active, { chat, priority });
  useVoiceChatStart(id, async () => { await mockStart('visible-chat'); }, false);
  const visible = useVoiceBarVisible(id);
  const occupies = useVoiceBarOccupiesComposer(id);
  return <><HeaderVoiceMic />{chat && visible ? <GlobalVoiceBar anchored surfaceId={id} /> : null}{!occupies ? <Text>Draft stays</Text> : null}</>;
}
beforeEach(() => { jest.useFakeTimers(); mockInsets = { top: 24, bottom: 20, left: 0, right: 0 }; resetVoicePresentationForTests(); mockCapture = null; mockDelivery = { takes: [], heldCount: 0, recoveryFailures: [], last: null }; mockLifecycle = { foreground: true, unlocked: true }; });
afterEach(() => { jest.useRealTimers(); });
test('outside header freezes assistant origin and starts an empty ordinary draft', async () => {
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  const mic = view.getByLabelText('Talk to Guide');
  expect(StyleSheet.flatten(mic.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
  expect(StyleSheet.flatten(view.getByTestId('header-voice-mic-face').props.style)).toMatchObject({ width: 34, height: 34 });
  await act(async () => { fireEvent.press(mic); });
  expect(mockStart).toHaveBeenCalledWith(ASSISTANT_STREAM_ID, expect.objectContaining({ originGeneration: 'generation-1', originLabel: 'Guide', textPrefix: '', images: [], operationKind: 'voice_chat' }));
});
test('title-adjacent microphone stops propagation to a surrounding status/header action', async () => {
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  const stopPropagation = jest.fn();
  await act(async () => fireEvent.press(view.getByLabelText('Talk to Guide'), { stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
});
test('ordinary session header microphone has no accessible Pressable ancestor grouping it with status', () => {
  const ts = require('typescript') as typeof import('typescript');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app/pentacle/session/[streamId].tsx'), 'utf8');
  const file = ts.createSourceFile('Session.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = 0;
  const visit = (node: import('typescript').Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'HeaderVoiceMic'
      && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(file) === 'testID' && prop.initializer?.getText(file) === '"session-header-voice-mic"')) {
      found++;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(file) === 'Pressable') {
          throw new Error('The session microphone must remain an independent sibling of status press targets');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file); expect(found).toBe(1);
});
test('focused chat header uses its draft-owning registered start', async () => {
  const view = render(<><VoiceRecordingOverlay /><Page chat /></>);
  await act(async () => { fireEvent.press(view.getByLabelText('Talk to Guide')); });
  expect(mockStart).toHaveBeenCalledWith('visible-chat');
});
test('one bar moves into any active chat and back without starting or changing recipient', () => {
  mockCapture = capture();
  const tree = (chat: boolean) => <><VoiceRecordingOverlay /><Page chat={chat} /></>;
  const view = render(tree(false));
  expect(view.getAllByTestId('global-voice-bar')).toHaveLength(1);
  expect(view.getByText('TO ORIGINAL CHAT')).toBeTruthy();
  act(() => setVoiceBarDy('take-1', 100));
  view.rerender(tree(true));
  expect(view.getAllByTestId('global-voice-bar')).toHaveLength(1);
  expect(view.getByTestId('global-voice-bar').props.accessibilityLabel).toBe('Voice recording in chat');
  expect(view.queryByTestId('voice-bar-drag-region')).toBeNull();
  view.rerender(tree(false));
  expect(voicePresentationSnapshot().dy).toBe(100);
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockCapture?.streamId).toBe('hosta:original');
});
test('drag clamps at header/footer and resets only for a different take', () => {
  expect(clampVoiceDy(900, { base: 86, minBottom: 24, top: 100, height: 874 })).toBe(644);
  expect(clampVoiceDy(-900, { base: 112, minBottom: 24, top: 100, height: 874 })).toBe(-88);
  mockCapture = capture(); const view = render(<><VoiceRecordingOverlay /><Page /></>);
  act(() => setVoiceBarDy('take-1', 42)); expect(voicePresentationSnapshot().dy).toBe(42);
  emitCapture(capture('take-2')); expect(voicePresentationSnapshot().dy).toBe(0);
  expect(view.getAllByTestId('global-voice-bar')).toHaveLength(1);
});
test('paused capture shows truthful interruption, Send and X, with explicit Resume retained', async () => {
  mockCapture = capture('take-1', 'paused'); const view = render(<><VoiceRecordingOverlay /><Page /></>);
  expect(view.getByText('INTERRUPTED · 0:12 KEPT')).toBeTruthy();
  expect(view.getByLabelText('Resume recording')).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByTestId('global-voice-send')); });
  expect(mockSend).toHaveBeenCalledWith('take-1');
});
test('only landed event shows Sent, assistant View clears it, and expiry is 2800ms from proof', () => {
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  expect(view.queryByText(/SENT TO/)).toBeNull();
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'take-1', streamId: ASSISTANT_STREAM_ID, originLabel: 'Guide', landedAt: Date.now() })));
  expect(view.getByText('SENT TO GUIDE')).toBeTruthy();
  act(() => jest.advanceTimersByTime(2799)); expect(view.getByText('SENT TO GUIDE')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1)); expect(view.queryByText('SENT TO GUIDE')).toBeNull();
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'take-2', streamId: ASSISTANT_STREAM_ID, originLabel: 'Guide', landedAt: Date.now() })));
  fireEvent.press(view.getByLabelText('View sent recording'));
  expect(view.queryByText('SENT TO GUIDE')).toBeNull(); expect(mockRouter.push).toHaveBeenCalled();
});
test('a new capture replaces receipt and locked UI exposes no bar', () => {
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'old', streamId: ASSISTANT_STREAM_ID, originLabel: 'Guide', landedAt: Date.now() })));
  emitCapture(capture()); expect(view.queryByText(/SENT TO/)).toBeNull();
  act(() => { mockLifecycle = { foreground: true, unlocked: false }; mockLifecycleListeners.forEach(fn => fn()); });
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
});

test.each(['starting', 'stopping'] as const)('%s is projected truthfully and the busy header cannot send twice', async phase => {
  mockCapture = capture('take-1', phase);
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  expect(view.getByText(phase === 'starting' ? 'STARTING…' : 'SAVING…')).toBeTruthy();
  expect(view.getByLabelText('Send active recording').props.accessibilityState.disabled).toBe(true);
  expect(view.queryByTestId('global-voice-send')).toBeNull();
  await act(async () => { await pressVoiceHeader(); });
  expect(mockSend).not.toHaveBeenCalled();
});
function take(status: string, dispatched = false) {
  return { recordingId: 'take-1', streamId: 'hosta:original', durationS: 12, status,
    draft: { originLabel: 'Original chat' }, manifest: { ...(dispatched ? { dispatchIntent: {} } : {}), audio: { bytes: 100 }, upload: { nextOffset: 50 } } };
}
test.each(['hosta:original', ASSISTANT_STREAM_ID])('destination %s suppresses passive progress and restores the composer on committed navigation', streamId => {
  const pending = { ...take('transcribing'), streamId };
  mockDelivery = { ...mockDelivery, takes: [pending] };
  const tree = (destination: boolean, cover = false) => <><VoiceRecordingOverlay />
    <Page chat={destination} entityId={destination ? streamId : undefined}
      pageId={destination && streamId === ASSISTANT_STREAM_ID ? 'assistant' : undefined} />
    {cover ? <VoiceRecordingOverlay priority={100} hostName="cover" /> : null}</>;
  const view = render(tree(true));
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
  expect(view.queryByTestId('voice-take-controls-take-1')).toBeNull();
  expect(view.queryByLabelText('Return to original chat')).toBeNull();
  expect(view.getByText('Draft stays')).toBeTruthy();
  view.rerender(tree(false));
  expect(view.getByText('TRANSCRIBING…')).toBeTruthy();
  expect(view.getByLabelText('Return to original chat')).toBeTruthy();
  view.rerender(tree(true, true));
  expect(view.getByTestId('global-voice-bar').props.accessibilityLabel).toBe('Floating voice recording');
  view.rerender(tree(true));
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
  expect(view.queryByTestId('voice-take-controls-take-1')).toBeNull();
  expect(mockDelivery.takes[0]).toBe(pending);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDiscard).not.toHaveBeenCalled();
});
test.each(['queued', 'uploading', 'transcribing', 'checking'])('matching passive %s is suppressed per item', status => {
  mockDelivery = { ...mockDelivery, takes: [take(status)] };
  const view = render(<><VoiceRecordingOverlay /><Page chat entityId="hosta:original" /></>);
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
  expect(view.queryByTestId('voice-take-controls-take-1')).toBeNull();
  expect(view.getByText('Draft stays')).toBeTruthy();
});
test.each([
  { pageId: 'chat', entityId: 'hosta:other', chat: true, active: true },
  { pageId: 'chat', chat: true, active: true },
  { pageId: 'assistant', entityId: 'hosta:original', chat: true, active: true },
  { pageId: 'personal', entityId: 'hosta:original', chat: true, active: true },
  { pageId: 'chat', entityId: 'hosta:original', chat: false, active: true },
  { pageId: 'chat', entityId: 'hosta:original', chat: true, active: false },
])('unknown, covered-by-navigation or non-destination surface does not suppress: %j', page => {
  mockDelivery = { ...mockDelivery, takes: [take('transcribing')] };
  const view = render(<><VoiceRecordingOverlay /><Page {...page} title="Original chat" /></>);
  expect(view.getByTestId('global-voice-bar')).toBeTruthy();
  expect(view.getByTestId('voice-take-controls-take-1')).toBeTruthy();
});
test.each(['hosta:original', ASSISTANT_STREAM_ID])('destination %s filters a receipt without consuming or extending its original deadline', streamId => {
  const tree = (destination: boolean, cover = false) => <><VoiceRecordingOverlay /><Page chat={destination}
    entityId={streamId} pageId={destination && streamId === ASSISTANT_STREAM_ID ? 'assistant' : undefined} />
    {cover ? <VoiceRecordingOverlay priority={100} hostName="cover" /> : null}</>;
  const view = render(tree(true));
  const receipt = { recordingId: 'finished', streamId, originLabel: 'Original chat', landedAt: Date.now() };
  act(() => mockLandedListeners.forEach(fn => fn(receipt)));
  expect(view.queryByText(/SENT TO/)).toBeNull();
  expect(view.queryByLabelText('View sent recording')).toBeNull();
  expect(view.getByText('Draft stays')).toBeTruthy();
  expect(voicePresentationSnapshot().receipt).toEqual(receipt);
  act(() => jest.advanceTimersByTime(900));
  view.rerender(tree(false));
  expect(view.getByText('SENT TO ORIGINAL CHAT')).toBeTruthy();
  act(() => jest.advanceTimersByTime(700));
  view.rerender(tree(true));
  expect(view.queryByText(/SENT TO/)).toBeNull();
  view.rerender(tree(true, true));
  expect(view.getByText('SENT TO ORIGINAL CHAT')).toBeTruthy();
  view.rerender(tree(true));
  act(() => jest.advanceTimersByTime(1199));
  view.rerender(tree(false));
  expect(view.getByText('SENT TO ORIGINAL CHAT')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1));
  expect(view.queryByText(/SENT TO/)).toBeNull();
  expect(voicePresentationSnapshot().receipt).toBeNull();
  view.rerender(tree(true)); view.rerender(tree(false));
  expect(view.queryByText(/SENT TO/)).toBeNull();
});
test('a receipt landing away is hidden on entry and expires there without a new receipt', () => {
  const tree = (destination: boolean) => <><VoiceRecordingOverlay /><Page chat={destination} entityId="hosta:original" /></>;
  const view = render(tree(false));
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'finished', streamId: 'hosta:original', originLabel: 'Original chat', landedAt: Date.now() })));
  expect(view.getByText('SENT TO ORIGINAL CHAT')).toBeTruthy();
  view.rerender(tree(true));
  expect(view.queryByText(/SENT TO/)).toBeNull();
  act(() => jest.advanceTimersByTime(2800));
  view.rerender(tree(false));
  expect(view.queryByText(/SENT TO/)).toBeNull();
});
test.each(['unsent', 'failed', 'auth_needed', 'origin_unavailable', 'not_landed', 'checking'])('destination retains actionable %s controls', status => {
  mockDelivery = { ...mockDelivery, takes: [take(status, status === 'checking')] };
  const view = render(<><VoiceRecordingOverlay /><Page chat entityId="hosta:original" /></>);
  expect(view.getByTestId('global-voice-bar')).toBeTruthy();
  expect(view.getByTestId('voice-take-controls-take-1')).toBeTruthy();
  if (status === 'checking') {
    expect(view.getByLabelText('Check recording delivery again')).toBeTruthy();
    expect(view.getByLabelText('Remove local recording copy')).toBeTruthy();
  }
});
test.each(['starting', 'recording', 'stopping', 'paused', 'finalized'] as const)('destination retains %s capture', status => {
  mockCapture = capture('take-1', status);
  const view = render(<><VoiceRecordingOverlay /><Page chat entityId="hosta:original" /></>);
  expect(view.getByTestId('global-voice-bar')).toBeTruthy();
});
test('storage/error recovery and another retained take remain available when passive progress matches', () => {
  mockDelivery = { ...mockDelivery, takes: [take('transcribing'), { ...take('failed'), recordingId: 'other', streamId: 'hosta:other' }] };
  const view = render(<><VoiceRecordingOverlay /><Page chat entityId="hosta:original" /></>);
  expect(view.queryByTestId('global-voice-bar')).toBeNull();
  fireEvent.press(view.getByLabelText('Show retained recordings'));
  expect(view.getByTestId('voice-take-controls-other')).toBeTruthy();
  act(() => { mockDelivery = { ...mockDelivery, storageError: 'Could not save recording' }; mockDeliveryListeners.forEach(fn => fn()); });
  expect(view.getByTestId('global-voice-bar')).toBeTruthy();
  expect(view.getAllByText('Could not save recording').length).toBeGreaterThan(0);
});
test.each([
  ['queued','QUEUED'], ['uploading','UPLOADING…'], ['transcribing','TRANSCRIBING…'], ['checking','CHECKING DELIVERY'],
])('actual %s state is visible; unknown receipts never become Sent', (status, label) => {
  mockDelivery = { ...mockDelivery, takes: [take(status, status === 'checking')] };
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  expect(view.getByText(label)).toBeTruthy();
  expect(view.queryByText(/SENT TO/)).toBeNull();
  if (status === 'checking') {
    expect(view.queryByLabelText('Discard recording')).toBeNull();
    expect(view.getByLabelText('Check recording delivery again')).toBeTruthy();
    expect(view.getByLabelText('Remove local recording copy')).toBeTruthy();
  } else expect(view.getByLabelText('Discard recording')).toBeTruthy();
  // A queued/delivering take does not monopolize capture admission.
  expect(view.getByLabelText('Talk to Guide').props.accessibilityState.disabled).toBe(false);
});
test('a modal owns the single floating bar over a focused chat; dismissal restores the exact anchored owner', () => {
  mockCapture = capture();
  const tree = (modal: boolean) => <><VoiceRecordingOverlay /><Page chat />{modal ? <VoiceRecordingOverlay priority={100} hostName="dialog" /> : null}</>;
  const view = render(tree(false));
  expect(view.getByTestId('global-voice-bar').props.accessibilityLabel).toBe('Voice recording in chat');
  view.rerender(tree(true));
  expect(view.getAllByTestId('global-voice-bar', { includeHiddenElements: true })).toHaveLength(1);
  expect(view.getByTestId('global-voice-bar').props.accessibilityLabel).toBe('Floating voice recording');
  view.rerender(tree(false));
  expect(view.getAllByTestId('global-voice-bar', { includeHiddenElements: true })).toHaveLength(1);
  expect(view.getByTestId('global-voice-bar').props.accessibilityLabel).toBe('Voice recording in chat');
  expect(mockStart).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});
test('landed receipt is shown ahead of other retained takes and does not remove them', () => {
  mockDelivery = { ...mockDelivery, takes: [take('unsent')] };
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'finished', streamId: ASSISTANT_STREAM_ID, originLabel: 'Guide', landedAt: Date.now() })));
  expect(view.getByText('SENT TO GUIDE')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Show retained recordings'));
  expect(view.getByTestId('voice-take-list')).toBeTruthy();
  expect(mockDelivery.takes).toHaveLength(1);
  act(() => jest.advanceTimersByTime(2800));
  expect(view.getByText('UNSENT · 0:12 KEPT')).toBeTruthy();
});


test('only the non-control region owns vertical drag; X and mic taps never change dy', async () => {
  const original = PanResponder.create;
  const configs: Parameters<typeof PanResponder.create>[0][] = [];
  const spy = jest.spyOn(PanResponder, 'create').mockImplementation(config => { configs.push(config); return original(config); });
  mockCapture = capture();
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  const gesture = { dy: -100, dx: 0 } as any;
  const config = configs[0];
  expect(config.onMoveShouldSetPanResponder?.({} as any, gesture)).toBe(true);
  expect(config.onMoveShouldSetPanResponder?.({} as any, { dy: 2, dx: 40 } as any)).toBe(false);
  act(() => { config.onPanResponderGrant?.({} as any, gesture); config.onPanResponderMove?.({} as any, gesture); });
  expect(voicePresentationSnapshot().dy).toBe(100);
  const bar = StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style);
  expect(bar).toMatchObject({ left: 16, right: 16, bottom: 186 });
  const x = view.getByLabelText('Discard recording'); const mic = view.getByTestId('global-voice-send');
  expect(x.props.onMoveShouldSetResponder).toBeUndefined(); expect(mic.props.onMoveShouldSetResponder).toBeUndefined();
  await act(async () => { fireEvent.press(x); fireEvent.press(mic); });
  expect(voicePresentationSnapshot().dy).toBe(100);
  expect(mockDiscard).toHaveBeenCalledWith('take-1'); expect(mockSend).toHaveBeenCalledWith('take-1');
  spy.mockRestore();
});

test.each([3000, 100])('an out-of-order proof %ims older cannot replace or cancel the latest receipt expiry', ageMs => {
  const view = render(<><VoiceRecordingOverlay /><Page /></>);
  const provedAt = Date.now();
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'take-newer', streamId: ASSISTANT_STREAM_ID, originLabel: 'Latest recipient', landedAt: provedAt })));
  act(() => jest.advanceTimersByTime(500));
  act(() => mockLandedListeners.forEach(fn => fn({ recordingId: 'take-older', streamId: ASSISTANT_STREAM_ID, originLabel: 'Older recipient', landedAt: provedAt - ageMs })));
  expect(view.getByText('SENT TO LATEST RECIPIENT')).toBeTruthy();
  expect(view.queryByText('SENT TO OLDER RECIPIENT')).toBeNull();
  act(() => jest.advanceTimersByTime(2299));
  expect(view.getByText('SENT TO LATEST RECIPIENT')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1));
  expect(view.queryByText('SENT TO LATEST RECIPIENT')).toBeNull();
  expect(voicePresentationSnapshot().receipt).toBeNull();
});


function keyboardHarness() {
  const events = new Map<string, Set<(event: any) => void>>();
  const add = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
    const callbacks = events.get(name) ?? new Set(); callbacks.add(callback); events.set(name, callbacks);
    return { remove: () => { callbacks.delete(callback); } } as any;
  });
  const metrics = jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
  const previousWindow = Dimensions.get('window'); const previousScreen = Dimensions.get('screen');
  act(() => Dimensions.set({ window: { ...previousWindow, width: 402, height: 874 }, screen: { ...previousScreen, width: 402, height: 874 } }));
  return {
    alreadyOpen(screenY: number, height: number) { metrics.mockReturnValue({ screenX: 0, screenY, width: 402, height }); },
    emit(name: string, frame?: { screenY: number; height: number }) {
      act(() => events.get(name)?.forEach(callback => callback({ endCoordinates: { screenX: 0, width: 402, ...frame } })));
    },
    resize(height: number) { act(() => Dimensions.set({ window: { ...previousWindow, width: 402, height } })); },
    restore() { add.mockRestore(); metrics.mockRestore(); act(() => Dimensions.set({ window: previousWindow, screen: previousScreen })); },
  };
}
function ModalVoiceSurface({ bottom = 24 }: { bottom?: number }) {
  useVoiceSurface({ page_id: 'other', title: 'Rename chat' }, true, { priority: 2, bottom, top: 100 });
  return <VoiceRecordingOverlay priority={2} hostName="rename-chat" />;
}
test('floating modal controls clear the actual keyboard frame without adding the safe inset twice', () => {
  const keyboard = keyboardHarness(); mockInsets = { ...mockInsets, bottom: 34 }; mockCapture = capture();
  const view = render(<RenameChatModal visible initialName="Synthetic chat" onClose={jest.fn()} onSubmit={jest.fn()} />);
  expect(view.getByTestId('rename-chat-input').props.autoFocus).toBe(true);
  const bottom = () => StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom;
  expect(bottom()).toBe(34);
  keyboard.emit('keyboardWillChangeFrame', { screenY: 554, height: 320 });
  expect(bottom()).toBe(332); // 320 of this window is occluded, plus a12px gap. Safe34 is already in the frame.
  act(() => setVoiceBarDy('take-1', -900)); expect(bottom()).toBe(332);
  act(() => setVoiceBarDy('take-1', 900)); expect(bottom()).toBe(730); // header100 + bar44
  act(() => setVoiceBarDy('take-1', 0));
  keyboard.emit('keyboardWillHide'); expect(bottom()).toBe(34);
  expect(view.getByLabelText('Discard recording')).toBeTruthy(); expect(view.getByTestId('global-voice-send')).toBeTruthy();
  view.unmount(); keyboard.restore();
});
test('resized windows do not apply keyboard occlusion twice and footer bounds remain the minimum', () => {
  const keyboard = keyboardHarness(); mockCapture = capture();
  const view = render(<ModalVoiceSurface bottom={112} />);
  keyboard.emit('keyboardDidShow', { screenY: 554, height: 320 });
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(332);
  keyboard.resize(554);
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(112);
  act(() => setVoiceBarDy('take-1', -900));
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(112);
  keyboard.emit('keyboardDidHide'); view.unmount(); keyboard.restore();
});
test('anchored chat leaves keyboard placement entirely to its existing composer slot', () => {
  const keyboard = keyboardHarness(); mockCapture = capture();
  const view = render(<><VoiceRecordingOverlay /><Page chat /></>);
  act(() => setVoiceBarDy('take-1', 75));
  keyboard.emit('keyboardWillShow', { screenY: 554, height: 320 });
  const style = StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style);
  expect(style.bottom).toBeUndefined(); expect(style.position).toBeUndefined(); expect(style.height).toBe(44);
  expect(voicePresentationSnapshot().dy).toBe(75);
  view.unmount(); keyboard.restore();
});


test('a new modal host starts above an already visible keyboard and restores the take offset on close', () => {
  const keyboard = keyboardHarness(); mockCapture = capture(); keyboard.alreadyOpen(554, 320);
  const view = render(<ModalVoiceSurface />);
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(332);
  act(() => setVoiceBarDy('take-1', 75));
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(407);
  keyboard.emit('keyboardDidHide');
  expect(StyleSheet.flatten(view.getByTestId('global-voice-bar').props.style).bottom).toBe(99);
  expect(voicePresentationSnapshot().dy).toBe(75);
  view.unmount(); keyboard.restore();
});

test.each(['0', '1'])('assistant header recorder origin is gated (harness=%s)', async flag => {
  const previous = process.env.EXPO_PUBLIC_HARNESS;
  process.env.EXPO_PUBLIC_HARNESS = flag;
  const spy = jest.spyOn(require('../src/utils/m1Diagnostic'), 'm1Diagnostic').mockImplementation(() => undefined);
  const view = render(<Page />);
  await act(async () => fireEvent.press(view.getByTestId('header-voice-mic')));
  const origins = spy.mock.calls.map(([, data]) => (data as { origin?: string }).origin);
  for (const origin of ['header', 'header_assistant']) {
    if (flag === '1') expect(origins).toContain(origin); else expect(origins).not.toContain(origin);
  }
  spy.mockRestore(); process.env.EXPO_PUBLIC_HARNESS = previous;
});
