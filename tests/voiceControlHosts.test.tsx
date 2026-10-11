import React from 'react';
import { Animated, Modal, StyleSheet } from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { initialPentacleStreamState, type PentacleStreamState } from 'pentacle-chat-core';
import type { RecordingSnapshot } from '../src/services/voiceRecording';
import type { VoiceDeliverySnapshot } from '../src/services/voiceDelivery';
import { resetChatOpenNavigationIntents } from '../src/services/chatOpenNavigationIntent';
import VoiceRecordingOverlay from '../src/components/voice/VoiceRecordingOverlay';
import SummonModal from '../src/components/SummonModal';
import { ImageViewerModal } from '../src/components/ImageViewerModal';
import RenameChatModal from '../src/components/RenameChatModal';
import { AgentThreadHistoryModal } from '../src/components/AgentThreadHistoryModal';
import ChatActionSheet from '../src/components/ChatActionSheet';
import ReportViewerModal from '../src/components/ReportViewerModal';
import ChatsDrawer from '../src/components/bart/ChatsDrawer';
import BartStatusOverlay from '../src/components/bart/BartStatusOverlay';
import UnifiedScreen from '../app/(tabs)/unified';
import QuestionsRoute from '../app/pentacle/questions';
import LanesRoute from '../app/pentacle/lanes';

// This suite tests real control projection, native-modal ownership and navigation.
// Recorder, durable-delivery and authenticated stream snapshots are stable synthetic
// external-store boundaries. No overlay, host, route, Modal or control is mocked.
const RECORDING_ID = '123e4567-e89b-42d3-a456-000000000001';
const ORIGIN = 'hosta:original-chat';
const ORIGIN_LABEL = 'Synthetic original chat';
const OTHER_CHAT = 'hostb:visible-chat';
const mockResume = jest.fn(async () => undefined);
const mockSend = jest.fn(async (_id: string) => undefined);
const mockDiscard = jest.fn(async (_id: string) => undefined);
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
let mockCapture: RecordingSnapshot;
let mockDelivery: VoiceDeliverySnapshot;
let mockLifecycle = { foreground: true, unlocked: true };
let mockScopeMatches = true;
let mockCurrentTransportScopeMatches = true;
let mockFocused = true;
let mockState: PentacleStreamState;
const mockDeliveryListeners = new Set<() => void>();
const mockLifecycleListeners = new Set<() => void>();
const mockCaptureListeners = new Set<(value: RecordingSnapshot) => void>();
const mockSubscribeDelivery = (fn: () => void) => { mockDeliveryListeners.add(fn); return () => { mockDeliveryListeners.delete(fn); }; };
const mockSubscribeLifecycle = (fn: () => void) => { mockLifecycleListeners.add(fn); return () => { mockLifecycleListeners.delete(fn); }; };
const mockSubscribeCapture = (fn: (value: RecordingSnapshot) => void) => { mockCaptureListeners.add(fn); return () => { mockCaptureListeners.delete(fn); }; };
const mockActions = { answerPrompt: jest.fn(async () => undefined) };
const mockReports = [{ asset_id: 'synthetic-report', title: 'Synthetic report', content_type: 'report', body: { schema_version: 1, title: 'Synthetic report', sections: [] } }];

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => ({
  ...require('./helpers/mocks/expoRouter').makeMock(),
  useRouter: () => mockRouter,
  useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@expo/vector-icons', () => ({ FontAwesome: 'FontAwesome', Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockFocused,
  useFocusEffect: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 20, left: 0, right: 0, top: 24 }) }));
jest.mock('../src/hooks/usePentacleToken', () => ({ __esModule: true, default: () => ({ isReady: true }) }));
jest.mock('../src/services/voiceRecordingEngine', () => ({
  voiceRecorder: {
    snapshot: () => mockCapture,
    isOwnedByCurrentScope: () => mockCurrentTransportScopeMatches,
    subscribe: (fn: (value: RecordingSnapshot) => void) => mockSubscribeCapture(fn),
    resume: () => mockResume(),
    discard: () => mockDiscard(RECORDING_ID),
  },
  voiceLifecycleSnapshot: () => mockLifecycle,
  subscribeVoiceLifecycle: (fn: () => void) => mockSubscribeLifecycle(fn),
  sendVoiceTake: (id: string) => mockSend(id),
  discardVoiceTake: (id: string) => mockDiscard(id),
}));
jest.mock('../src/services/voiceTakeStore', () => ({
  ...jest.requireActual('../src/services/voiceTakeStore'),
  voiceTakeStore: { get: () => mockScopeMatches ? { recordingId: RECORDING_ID } : undefined },
}));
jest.mock('../src/services/voiceDelivery', () => ({
  useVoiceDelivery: () => require('react').useSyncExternalStore(mockSubscribeDelivery, () => mockDelivery, () => mockDelivery),
  voiceDelivery: { discardHeld: jest.fn(async () => undefined) },
}));
jest.mock('../src/services/pentacleStream', () => ({
  ...jest.requireActual('../src/services/pentacleStream'),
  getPentacleStreamState: () => mockState,
  usePentacleStreamSelector: (selector: (state: PentacleStreamState) => unknown) => selector(mockState),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: (state: PentacleStreamState) => unknown) => selector(mockState),
  usePentacleStreamActions: () => mockActions,
  requestStreamEvents: jest.fn(async () => []),
}));
jest.mock('../src/services/pentacleAssets', () => ({
  ...jest.requireActual('../src/services/pentacleAssets'),
  useSessionReports: () => mockReports,
  isReportSessionClosed: () => false,
  listReports: jest.fn(async () => mockReports),
  getReport: jest.fn(async () => mockReports[0]),
  listReportComments: jest.fn(async () => []),
  markReportRead: jest.fn(async () => undefined),
}));

const mockChildTarget = {
  parentStreamId: OTHER_CHAT,
  parentGeneration: 'visible-generation',
  child: { stream_id: 'hostb:child', session_generation: 'child-generation', display_name: 'Synthetic child', objective: 'Synthetic fixture' },
} as React.ComponentProps<typeof AgentThreadHistoryModal>['target'];
const mockReadThread = jest.fn(async () => ({
  parent_stream_id: OTHER_CHAT, parent_generation: 'visible-generation',
  child_stream_id: 'hostb:child', child_generation: 'child-generation', rows: [], next_cursor: null,
}));
const noop = () => undefined;
type NativeHost = {
  name: string;
  component: (open: boolean, close: () => void) => React.ReactNode;
  open?: (view: ReturnType<typeof render>) => void;
};
const NATIVE_HOSTS: NativeHost[] = [
  { name: 'summon', component: (open, close) => <SummonModal visible={open} onClose={close} machines={[]} catalog={null} catalogLoading={false} catalogError={null} submitting={false} submitError={null} onRetryCatalog={noop} onPick={noop} /> },
  { name: 'image-viewer', component: (open, close) => <ImageViewerModal uri={open ? 'file:///synthetic/image.jpg' : null} onClose={close} /> },
  { name: 'rename-chat', component: (open, close) => <RenameChatModal visible={open} initialName="Visible chat" onSubmit={noop} onClose={close} /> },
  { name: 'thread-history', component: (open, close) => <AgentThreadHistoryModal target={open ? mockChildTarget : null} connected={false} readThread={mockReadThread} onClose={close} /> },
  { name: 'chat-actions', component: (open, close) => <ChatActionSheet visible={open} onClose={close} onRename={noop} /> },
  { name: 'report-viewer', component: (open, close) => <ReportViewerModal visible={open} streamId={OTHER_CHAT} onClose={close} /> },
  { name: 'chats-drawer', component: (open, close) => <ChatsDrawer open={open} groups={[]} canStart={false} onClose={close} onNewSession={noop} /> },
  { name: 'assistant-status', component: (open, close) => open ? <BartStatusOverlay onClose={close} /> : null },
  { name: 'unified-questions', component: () => <UnifiedScreen />, open: view => fireEvent.press(view.getByTestId('unified-question-badge')) },
];
const ACTIONS = ['Return to original chat', 'Resume recording', 'Send recording', 'Discard recording'];

beforeEach(() => {
  jest.useFakeTimers();
  resetChatOpenNavigationIntents();
  mockScopeMatches = true;
  mockCurrentTransportScopeMatches = true;
  mockFocused = true;
  mockLifecycle = { foreground: true, unlocked: true };
  mockCapture = {
    recordingId: RECORDING_ID, streamId: ORIGIN, originLabel: ORIGIN_LABEL,
    levels: [-20], displayLevels: [-20], durationS: 65, capturedAudioMs: 65000,
    status: 'paused', pauseReason: 'background',
  };
  mockDelivery = { takes: [], last: null, heldCount: 0, recoveryFailures: [] };
  mockState = {
    ...initialPentacleStreamState,
    connected: false,
    hasHydrated: true,
    sessions: [],
    notifications: [{
      notification_id: 'synthetic-question', created_at: '2026-10-10T12:00:00.000Z', updated_at: '2026-10-10T12:00:00.000Z',
      producer: 'agent_question.v1', answer_to_stream_id: OTHER_CHAT, severity: 'info', title: 'Visible chat question',
      body: 'Choose a synthetic path', dedup_key: 'question:synthetic', state: 'open',
      actions: [{ kind: 'yes_no', action_id: 'synthetic-action' }],
      question: { question_id: 'synthetic-question', producer_stream_id: OTHER_CHAT, response_mode: 'single_choice', options: [{ label: 'Path A', value: 'a' }], state: 'open', answer: null },
      resolution: null, ttl_seconds: 3600, expires_at: '2026-10-10T13:00:00.000Z', resolved_at: null,
    }],
  } as PentacleStreamState;
});
afterEach(() => {
  cleanup();
  resetChatOpenNavigationIntents();
  expect(mockCaptureListeners.size).toBe(0);
  expect(mockLifecycleListeners.size).toBe(0);
  expect(mockDeliveryListeners.size).toBe(0);
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(400);
  });
}
async function mountHost(host: NativeHost) {
  const closed = jest.fn();
  function Harness() {
    const [open, setOpen] = React.useState(true);
    const close = () => { closed(); setOpen(false); };
    return <><VoiceRecordingOverlay />{host.component(open, close)}</>;
  }
  const view = render(<Harness />);
  host.open?.(view);
  await settle();
  return { view, closed };
}
function assertControlSet(view: ReturnType<typeof render>, host: string) {
  // Include hidden elements in the count: native accessibility filtering must not
  // disguise a duplicate root copy under the covering modal.
  expect(view.getAllByTestId('voice-recording-overlay', { includeHiddenElements: true })).toHaveLength(1);
  expect(view.getByLabelText(`Recording controls, ${host}`)).toBeTruthy();
  expect(view.getByText(ORIGIN_LABEL)).toBeTruthy();
  expect(view.getByText('Paused · 1:05')).toBeTruthy();
  for (const name of ACTIONS) {
    expect(view.getAllByRole('button', { name, includeHiddenElements: true })).toHaveLength(1);
    const button = view.getByRole('button', { name });
    expect(button.props.accessibilityState.disabled).toBe(false);
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  }
}
function coveringModal(view: ReturnType<typeof render>) {
  const overlay = view.getByTestId('voice-recording-overlay');
  const modals = view.UNSAFE_getAllByType(Modal);
  const owner = modals.find(modal => modal.findAll(node => node === overlay).length > 0);
  expect(owner).toBeDefined();
  expect(owner!.props.visible).toBe(true);
  return owner!;
}

// Inventory deliberately enumerates real owners; a test cannot pass merely by
// mounting an artificial wrapper around VoiceRecordingOverlay.
describe.each(NATIVE_HOSTS)('native shared host: $name', host => {
  test('owns one reachable paused control set inside its native modal and Return closes to the immutable origin', async () => {
    const { view, closed } = await mountHost(host);
    assertControlSet(view, host.name);
    coveringModal(view);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
    fireEvent.press(view.getByRole('button', { name: 'Return to original chat' }));
    await settle();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith(`/pentacle/session/${encodeURIComponent(ORIGIN)}`);
    if (host.name !== 'unified-questions') expect(closed).toHaveBeenCalledTimes(1);
    expect(view.queryByLabelText(`Recording controls, ${host.name}`)).toBeNull();
    assertControlSet(view, 'root');
    expect(mockCapture.streamId).toBe(ORIGIN);
    expect(mockCapture.capturedAudioMs).toBe(65000);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });
  test('dismissal restores root without changing the capture or dispatching voice', async () => {
    const { view } = await mountHost(host);
    const modal = coveringModal(view);
    act(() => modal.props.onRequestClose());
    await settle();
    assertControlSet(view, 'root');
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });
  test('Resume, Send and Discard invoke only the shared take commands', async () => {
    const { view } = await mountHost(host);
    fireEvent.press(view.getByRole('button', { name: 'Resume recording' }));
    fireEvent.press(view.getByRole('button', { name: 'Send recording' }));
    fireEvent.press(view.getByRole('button', { name: 'Discard recording' }));
    await settle();
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(RECORDING_ID);
    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(mockDiscard).toHaveBeenCalledWith(RECORDING_ID);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockCapture.streamId).toBe(ORIGIN);
  });
  test('locked and background states hide all take controls and the origin label', async () => {
    const { view } = await mountHost(host);
    for (const lifecycle of [{ foreground: true, unlocked: false }, { foreground: false, unlocked: true }]) {
      act(() => { mockLifecycle = lifecycle; mockLifecycleListeners.forEach(fn => fn()); });
      expect(view.queryByTestId('voice-recording-overlay', { includeHiddenElements: true })).toBeNull();
      expect(view.queryByText(ORIGIN_LABEL, { includeHiddenElements: true })).toBeNull();
      ACTIONS.forEach(name => expect(view.queryByLabelText(name, { includeHiddenElements: true })).toBeNull());
    }
    act(() => { mockLifecycle = { foreground: true, unlocked: true }; mockLifecycleListeners.forEach(fn => fn()); });
    assertControlSet(view, host.name);
    expect(mockResume).not.toHaveBeenCalled();
  });
  test('transport scope changes hide the old capture before the take-store snapshot catches up', async () => {
    const { view } = await mountHost(host);
    assertControlSet(view, host.name);
    act(() => {
      mockCurrentTransportScopeMatches = false;
      // Transport ownership changed, but the old take still exists in the lagging
      // store snapshot and its delivery snapshot has not published heldCount yet.
      mockCapture = { ...mockCapture };
      mockCaptureListeners.forEach(fn => fn(mockCapture));
    });
    expect(mockScopeMatches).toBe(true);
    expect(require('../src/services/voiceTakeStore').voiceTakeStore.get(RECORDING_ID)).toEqual({ recordingId: RECORDING_ID });
    expect(mockDelivery.heldCount).toBe(0);
    expect(view.getAllByTestId('voice-recording-overlay', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.getByLabelText(`Recording controls, ${host.name}`)).toBeTruthy();
    expect(view.getByText('1 held recording')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Discard held recordings' })).toBeTruthy();
    expect(view.queryByText(ORIGIN_LABEL, { includeHiddenElements: true })).toBeNull();
    expect(view.queryByText(ORIGIN, { includeHiddenElements: true })).toBeNull();
    ACTIONS.forEach(name => expect(view.queryByLabelText(name, { includeHiddenElements: true })).toBeNull());
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });
  test('a held scope exposes only a generic count and deliberate discard', async () => {
    const { view } = await mountHost(host);
    act(() => {
      mockScopeMatches = false;
      mockCurrentTransportScopeMatches = false;
      mockDelivery = { ...mockDelivery, heldCount: 1 };
      mockDeliveryListeners.forEach(fn => fn());
    });
    expect(view.getAllByTestId('voice-recording-overlay', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.getByText('1 held recording')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Discard held recordings' })).toBeTruthy();
    expect(view.queryByText(ORIGIN_LABEL, { includeHiddenElements: true })).toBeNull();
    expect(view.queryByText(ORIGIN, { includeHiddenElements: true })).toBeNull();
    ACTIONS.forEach(name => expect(view.queryByLabelText(name, { includeHiddenElements: true })).toBeNull());
  });
});

describe.each([{ name: 'questions', Component: QuestionsRoute }, { name: 'lanes', Component: LanesRoute }])('covering route: $name', ({ name, Component }) => {
  test('route focus owns one reachable control set and losing focus restores the root', async () => {
    const tree = () => <><VoiceRecordingOverlay /><Component /></>;
    const view = render(tree());
    await settle();
    assertControlSet(view, name);
    fireEvent.press(view.getByRole('button', { name: 'Return to original chat' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/pentacle/session/${encodeURIComponent(ORIGIN)}`);
    mockFocused = false;
    view.rerender(tree());
    await settle();
    assertControlSet(view, 'root');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDiscard).not.toHaveBeenCalled();
  });
});


test('native modal priority beats a later route host and latest covering modal restores the previous host', async () => {
  const tree = (image: boolean, rename: boolean) => <>
    <VoiceRecordingOverlay />
    <ImageViewerModal uri={image ? 'file:///synthetic/image.jpg' : null} onClose={noop} />
    <LanesRoute />
    <RenameChatModal visible={rename} initialName="Visible chat" onSubmit={noop} onClose={noop} />
  </>;
  const view = render(tree(true, false));
  await settle();
  assertControlSet(view, 'image-viewer');
  view.rerender(tree(true, true));
  await settle();
  assertControlSet(view, 'rename-chat');
  view.rerender(tree(true, false));
  await settle();
  assertControlSet(view, 'image-viewer');
  view.rerender(tree(false, false));
  await settle();
  assertControlSet(view, 'lanes');
  mockFocused = false;
  view.rerender(tree(false, false));
  await settle();
  assertControlSet(view, 'root');
  expect(mockResume).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDiscard).not.toHaveBeenCalled();
});

test('ChatsDrawer retains reachable controls until native closing animation completes', async () => {
  // Only native animation completion is controlled. The drawer still owns its real
  // mounted/open state, pointer suppression, modal host and dismissal lifecycle.
  const completions: Array<((result: { finished: boolean }) => void) | undefined> = [];
  const animation = jest.spyOn(Animated, 'parallel').mockImplementation(() => ({
    start: callback => { completions.push(callback); }, stop: jest.fn(), reset: jest.fn(),
  }));
  try {
    const { view } = await mountHost(NATIVE_HOSTS.find(host => host.name === 'chats-drawer')!);
    fireEvent.press(view.getByRole('button', { name: 'Close sessions' }));
    assertControlSet(view, 'chats-drawer');
    expect(coveringModal(view).props.visible).toBe(true);
    const panelAncestors = [];
    for (let node = view.getByTestId('bart-drawer-panel').parent; node; node = node.parent) panelAncestors.push(node);
    expect(panelAncestors.some(node => node.props.pointerEvents === 'none')).toBe(true);
    const send = view.getByRole('button', { name: 'Send recording' });
    for (let node = send.parent; node; node = node.parent) expect(node.props.pointerEvents).not.toBe('none');
    fireEvent.press(send);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(RECORDING_ID);
    act(() => completions.at(-1)?.({ finished: true }));
    await settle();
    assertControlSet(view, 'root');
  } finally {
    animation.mockRestore();
  }
});
