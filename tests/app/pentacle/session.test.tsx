import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FlatList } from 'react-native';
import { INITIAL_PENTACLE_LIMITS, invalidateSessionDetailCache } from 'pentacle-chat-core';
import SessionScreen from '../../../app/pentacle/session/[streamId]';
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import { requestStreamEvents, usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../../src/services/pentacleStream';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: any;
let mockShowToolActions = false;
let mockIsFocused = true;
const mockUnregisterSendHandler = jest.fn();
const mockRegisterSendHandler = jest.fn((
  _streamId: string,
  _handler: (request: unknown) => Promise<void>,
  _isWorking?: () => boolean,
) => mockUnregisterSendHandler);
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(() => 'optimistic_hostc_codex_one_1'),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_hostc_codex_one_1'),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  readThread: jest.fn(),
};
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});
const mockSetStringAsync = jest.fn<Promise<void>, [string]>(async () => undefined);

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
      if (prop === 'InteractionManager') return { runAfterInteractions: mockRunAfterInteractions };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => {
  const mock = require('../../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('../../../src/services/userPreferences', () => ({
  useUserPreference: (key: string) => [key === 'showToolActions' ? mockShowToolActions : false, jest.fn()],
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/utils/harnessRuntime', () => ({
  getParam: () => null,
  getScenario: jest.fn(() => null),
  hasAction: () => false,
  isArmed: () => false,
  registerCopyHandler: jest.fn(() => jest.fn()),
  registerSendHandler: (
    streamId: string,
    handler: (request: unknown) => Promise<void>,
    isWorking?: () => boolean,
  ) => mockRegisterSendHandler(streamId, handler, isWorking),
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => mockSetStringAsync(text),
}));
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'idle' })),
  sameStreamEventsLoadState: jest.fn((a, b) => (
    a.currentGenerationComplete === b.currentGenerationComplete &&
    a.fresh === b.fresh &&
    a.requestStatus === b.requestStatus
  )),
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
      hasOlderHistoryPage: Boolean(state.hasOlderHistoryPage),
      workingState: state.workingStates?.[streamId],
      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => mockState),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockShowToolActions = false;
  mockIsFocused = true;
  mockRegisterSendHandler.mockClear();
  mockUnregisterSendHandler.mockClear();
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      title: 'Migration plan',
      last_event_at: '2026-05-08T00:00:00Z',
      last_text: 'Previous answer',
      last_kind: 'ASSIST',
      online: true,
    }],
    drafts: {},
    events: [],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (requestStreamEvents as jest.Mock).mockResolvedValue([]);
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.readThread.mockResolvedValue({
    parent_stream_id: 'hostc:codex:one', parent_generation: 'parent-generation',
    child_stream_id: 'hostc:codex-hostc-peer', child_generation: 'child-generation',
    rows: [], next_cursor: null,
  });
  mockActions.sendTurn.mockReturnValue('optimistic_hostc_codex_one_1');
  mockSetStringAsync.mockClear();
});

test('cold renders with streamId param', () => {
  render(<SessionScreen />);

  expect(screen.getByText('Migration plan')).toBeTruthy();
  expect(screen.getByText('Codex')).toBeTruthy();
  expect(screen.getByTestId('status-tag-idle')).toBeTruthy();
  expect(screen.queryByText('Idle')).toBeNull();
});

test('status overlay Back replaces to chats while X returns to the session', () => {
  mockState.sessions[0].status_card = {
    goal: 'Verify status navigation',
    plan: [{ text: 'navigate', status: 'active' }],
    update: 'Ready',
    updates: [{ ts: '2026-05-08T00:00:00Z', text: 'Ready' }],
    updated_at: '2026-05-08T00:00:00Z',
  };
  render(<SessionScreen />);
  fireEvent.press(screen.getByTestId('session-status-overlay-trigger'));
  expect(screen.getByTestId('status-overlay')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Open 1 status updates'));
  expect(screen.getByTestId('status-overlay-close').props.accessibilityLabel).toBe('Back to status card');
  fireEvent.press(screen.getByTestId('status-overlay-close'));
  expect(screen.getByTestId('status-overlay')).toBeTruthy();
  fireEvent.press(screen.getByTestId('status-overlay-close'));
  expect(screen.queryByTestId('status-overlay')).toBeNull();
  fireEvent.press(screen.getByTestId('session-status-overlay-trigger'));
  fireEvent.press(screen.getByTestId('status-overlay-back'));
  expect(require('expo-router').router.replace).toHaveBeenCalledWith('/(tabs)/chats');
  expect(require('expo-router').router.back).not.toHaveBeenCalled();
});

test('a no-card parent status surface exposes its current direct-child roster and history', async () => {
  mockState.sessions[0] = {
    ...mockState.sessions[0], role: 'nexus', session_generation: 'parent-generation', agents: [{
      stream_id: 'hostc:codex-child', session_generation: 'child-generation', display_name: 'Roster child',
      role: 'worker', objective: null, state: 'blocked', model: null, since: null,
    }],
  };
  mockActions.readThread.mockResolvedValueOnce({
    parent_stream_id: 'hostc:codex:one', parent_generation: 'parent-generation', child_stream_id: 'hostc:codex-child',
    child_generation: 'child-generation', rows: [], next_cursor: null,
  });
  const rendered = render(<SessionScreen />);
  fireEvent.press(screen.getByTestId('session-status-overlay-trigger'));
  expect(screen.getByTestId('status-overlay')).toBeTruthy();
  expect(screen.getByText('Roster child')).toBeTruthy();
  fireEvent.press(screen.getByTestId('nexus-status-history-hostc-codex-child'));
  expect(await screen.findByTestId('agent-thread-modal')).toBeTruthy();
  expect(mockActions.readThread).toHaveBeenCalledWith({ parentStreamId: 'hostc:codex:one', childStreamId: 'hostc:codex-child' });
  mockState.sessions[0] = { ...mockState.sessions[0], agents: [] };
  rendered.rerender(<SessionScreen />);
  expect(screen.queryByTestId('agent-thread-modal')).toBeNull();
});

test('renders locked and unenrolled access states', () => {
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: false, token: null });
  const loading = render(<SessionScreen />);
  expect(loading.getByText('Unlocking Pentacle…')).toBeTruthy();
  loading.unmount();

  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: null });
  render(<SessionScreen />);
  expect(screen.getByText('Pentacle access is unavailable on this device.')).toBeTruthy();
});

test('cold renders seeded transcript fixture', async () => {
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: 'Ship Phase B',
  }, {
    daemon_seq: 2,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'Phase B is underway',
  }];

  render(<SessionScreen />);

  expect(await screen.findByText('Ship Phase B')).toBeTruthy();
  expect(screen.getByText('Phase B is underway')).toBeTruthy();
});

test('load-earlier footer distinguishes exact local rows from remote-only history', async () => {
  mockState.events = Array.from({ length: 20 }, (_, index) => ({
    daemon_seq: index + 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: `2026-05-08T00:00:${String(index).padStart(2, '0')}Z`,
    kind: index % 2 === 0 ? 'USER' : 'ASSIST',
    text: `history row ${index + 1}`,
  }));

  const local = render(<SessionScreen />);
  expect(await local.findByText('Load 4 earlier messages')).toBeTruthy();
  local.unmount();

  mockState.events = [];
  mockState.hasOlderHistoryPage = true;
  const remote = render(<SessionScreen />);
  expect(await remote.findByText('Load earlier messages')).toBeTruthy();
  remote.unmount();

  mockState.hasOlderHistoryPage = false;
  const exhausted = render(<SessionScreen />);
  expect(exhausted.queryByText(/Load .*earlier messages/)).toBeNull();
});

test('peer-agent cards preview, expand, collapse, and copy the full message without toggling', async () => {
  const peerText = '[from hostc:claude-hostc-122ad529] [tell:abc-123]\nPeer agent update\nSecond detail\nFinal detail';
  mockState.events = [
    {
      daemon_seq: 1,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:00Z',
      kind: 'USER',
      text: peerText,
    },
    {
      daemon_seq: 2,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:01Z',
      kind: 'USER',
      text: 'a real human message',
    },
  ];

  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('a real human message')).toBeTruthy();
  expect(rendered.getByText('Peer agent update')).toBeTruthy();
  expect(rendered.getByText('… +2 lines')).toBeTruthy();
  expect(rendered.queryByText(/Final detail/)).toBeNull();
  const card = rendered.getByTestId('agent-message-card-1');
  expect(card.props.accessibilityState).toEqual({ expanded: false });
  expect(rendered.queryByTestId('message-bubble-1')).toBeNull();

  fireEvent(card, 'longPress');
  fireEvent.press(card);
  await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('Peer agent update\nSecond detail\nFinal detail'));
  expect(rendered.queryByText(/Final detail/)).toBeNull();

  fireEvent.press(card);
  expect(rendered.getByText(/Final detail/)).toBeTruthy();
  expect(rendered.getByTestId('agent-message-card-1').props.accessibilityState).toEqual({ expanded: true });
  fireEvent.press(rendered.getByTestId('agent-message-card-1'));
  expect(rendered.queryByText(/Final detail/)).toBeNull();
  expect(mockState.events.some((event: { text: string }) => event.text === peerText)).toBe(true);
});

test('single-line peer-agent cards have no expansion affordance', async () => {
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: '[from hostc:codex-hostc-peer] [tell:health]\nAll systems nominal',
  }];

  const rendered = render(<SessionScreen />);
  expect(await rendered.findByText('All systems nominal')).toBeTruthy();
  const card = rendered.getByTestId('agent-message-card-1');
  expect(card.props.accessibilityState.expanded).toBeUndefined();
  fireEvent.press(card);
  expect(rendered.getByText('All systems nominal')).toBeTruthy();
});

test('long single-line peer plumbing collapses to one preview line and expands on tap', async () => {
  const body = `Peer payload ${'x'.repeat(180)} final-marker`;
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: `[from hostc:codex-hostc-peer] [tell:long]\n${body}`,
  }];

  const rendered = render(<SessionScreen />);
  const card = await rendered.findByTestId('agent-message-card-1');
  expect(rendered.queryByText(body)).toBeNull();
  expect(card.props.accessibilityState).toEqual({ expanded: false });
  fireEvent.press(card);
  expect(rendered.getByText(body)).toBeTruthy();
  expect(rendered.getByTestId('agent-message-card-1').props.accessibilityState).toEqual({ expanded: true });
});

test('a collapsed direct-child row opens only the authoritative child history', async () => {
  mockState.sessions[0] = {
    ...mockState.sessions[0], role: 'nexus', session_generation: 'parent-generation', agents: [{
      stream_id: 'hostc:codex-hostc-peer', session_generation: 'child-generation', display_name: 'Peer child',
      role: 'worker', objective: null, state: 'working', model: 'gpt-5.6-luna', since: null,
    }],
  };
  mockState.events = [{
    daemon_seq: 1, stream_id: 'hostc:codex:one', host: 'hostc', provider: 'codex', session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z', kind: 'USER',
    text: '[from hostc:codex-hostc-peer] [tell:history]\nCurrent child status\nMore detail',
  }];
  mockActions.readThread.mockResolvedValueOnce({
    parent_stream_id: 'hostc:codex:one', parent_generation: 'parent-generation',
    child_stream_id: 'hostc:codex-hostc-peer', child_generation: 'child-generation', next_cursor: null,
    rows: [{ row_id: 'tell:row-1', ref_id: 'row-1', ts: '2026-09-08T12:01:00Z', direction: 'child_to_parent', kind: 'tell', text: 'Direct child history', truncated: false }],
  });
  render(<SessionScreen />);
  const action = await screen.findByTestId('direct-child-history-1');
  fireEvent.press(action);
  await waitFor(() => expect(mockActions.readThread).toHaveBeenCalledWith({ parentStreamId: 'hostc:codex:one', childStreamId: 'hostc:codex-hostc-peer' }));
  expect(await screen.findByText('Direct child history')).toBeTruthy();
});

test('notification tells and successful RPC receipts are omitted', async () => {
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: '[from daemon:status-sweep] [tell:nudge]\nCheck session status',
  }, {
    daemon_seq: 2,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'TOOL_RESULT',
    text: '{"type":"status_card.ok","delivery_status":"submitting"}',
    raw: { source: 'claude-jsonl', tool_name: 'Bash' },
  }, {
    daemon_seq: 3,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:02Z',
    kind: 'ASSIST',
    text: 'Durable assistant prose',
  }];

  const rendered = render(<SessionScreen />);
  expect(await rendered.findByText('Durable assistant prose')).toBeTruthy();
  expect(rendered.queryByText('Check session status')).toBeNull();
  expect(rendered.queryByText(/status_card\.ok/)).toBeNull();
});

test('tool blocks collapse, expand, and keep error receipts available', async () => {
  mockShowToolActions = true;
  const multiline = 'Command failed\nFirst diagnostic\nFinal diagnostic';
  const longError = `{"type":"tell.error","error":"${'x'.repeat(180)}"}`;
  const toolUse = 'Bash: npm test\nworking directory: /project';
  mockState.events = [multiline, longError, toolUse].map((text, index) => ({
    daemon_seq: index + 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    timestamp: `2026-05-08T00:00:0${index}Z`,
    kind: index === 2 ? 'TOOL_USE' : 'TOOL_RESULT',
    text,
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Bash',
      is_error: true,
    },
  }));

  const rendered = render(<SessionScreen />);
  const multilineCard = await rendered.findByTestId('tool-result-card-1');
  expect(rendered.queryByText(/Final diagnostic/)).toBeNull();
  fireEvent.press(multilineCard);
  expect(rendered.getByText(/Final diagnostic/)).toBeTruthy();

  const jsonCard = rendered.getByTestId('tool-result-card-2');
  expect(rendered.queryByText(longError)).toBeNull();
  fireEvent.press(jsonCard);
  expect(rendered.getByText(longError)).toBeTruthy();

  const useCard = rendered.getByTestId('tool-result-card-3');
  expect(rendered.queryByText(/working directory: \/project/)).toBeNull();
  fireEvent.press(useCard);
  expect(rendered.getByText(/working directory: \/project/)).toBeTruthy();

});

test('summarized file-tool results retain their exact expansion payload', async () => {
  mockShowToolActions = true;
  const rawWriteResult = 'Saved file\n  exact tool payload';
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'TOOL_RESULT',
    text: rawWriteResult,
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/result.txt' },
      is_error: false,
    },
  }];

  const rendered = render(<SessionScreen />);
  const writeCard = await rendered.findByTestId('tool-result-card-1');
  expect(rendered.queryByText(/exact tool payload/)).toBeNull();
  fireEvent.press(writeCard);
  expect(rendered.getByText(/exact tool payload/)).toBeTruthy();
});

test('normal USER events still render as user bubbles', async () => {
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: 'Ship Phase B',
  }];

  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('Ship Phase B')).toBeTruthy();
  expect(rendered.getByTestId('message-bubble-1')).toBeTruthy();
  expect(rendered.queryByTestId('agent-message-row-1')).toBeNull();
});

test('scroll-to-bottom button appears whenever the user scrolls up, even with no unread messages', async () => {
  mockState.events = [
    {
      daemon_seq: 1,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:00Z',
      kind: 'USER',
      text: 'first message',
    },
    {
      daemon_seq: 2,
      stream_id: 'hostc:codex:one',
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:01Z',
      kind: 'ASSIST',
      text: 'second message',
    },
  ];

  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('first message')).toBeTruthy();
  // At the bottom on open — no scroll affordance.
  expect(rendered.queryByTestId('new-messages-pill')).toBeNull();

  // User scrolls up past the near-bottom threshold (inverted list: offset > 120).
  await act(async () => {
    fireEvent.scroll(rendered.getByTestId('transcript-list'), {
      nativeEvent: {
        contentOffset: { y: 400 },
        contentSize: { height: 2000, width: 320 },
        layoutMeasurement: { height: 800, width: 320 },
      },
    });
  });

  // The one-tap scroll-to-bottom button shows even with zero unread messages,
  // and the unread count is absent until new messages actually arrive.
  expect(rendered.getByTestId('new-messages-pill')).toBeTruthy();
  expect(rendered.queryByTestId('new-messages-count')).toBeNull();
});

test('the 2px bottom boundary follows live append and late row growth', async () => {
  (requestStreamEvents as jest.Mock).mockReturnValue(new Promise(() => undefined));
  mockState.sessions[0].last_text = '';
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: 'first message',
  }];
  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('first message')).toBeTruthy();
  const list = rendered.getByTestId('transcript-list');
  const scrollToOffset = jest.spyOn(rendered.UNSAFE_getByType(FlatList).instance, 'scrollToOffset');
  await act(async () => jest.runOnlyPendingTimers());
  scrollToOffset.mockClear();

  fireEvent.scroll(list, { nativeEvent: {
    contentOffset: { x: 0, y: 2 },
    contentSize: { height: 1200, width: 320 },
    layoutMeasurement: { height: 800, width: 320 },
  } });
  mockState.events = [{
    daemon_seq: 2,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'expanding newest message',
  }, ...mockState.events];
  invalidateSessionDetailCache('hostc:codex:one');
  rendered.rerender(<SessionScreen />);
  await act(async () => jest.runOnlyPendingTimers());
  expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  scrollToOffset.mockClear();

  fireEvent(rendered.getByTestId('transcript-list'), 'contentSizeChange', 320, 1200);
  expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  expect(rendered.queryByTestId('new-messages-pill')).toBeNull();
});

test('a live append at 3px preserves the anchor until jump-to-latest is tapped', async () => {
  (requestStreamEvents as jest.Mock).mockReturnValue(new Promise(() => undefined));
  mockState.sessions[0].last_text = '';
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: 'anchored message',
  }];
  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('anchored message')).toBeTruthy();
  const list = rendered.getByTestId('transcript-list');
  const scrollToOffset = jest.spyOn(rendered.UNSAFE_getByType(FlatList).instance, 'scrollToOffset');
  await act(async () => jest.runOnlyPendingTimers());
  scrollToOffset.mockClear();

  fireEvent.scroll(list, { nativeEvent: {
    contentOffset: { x: 0, y: 3 },
    contentSize: { height: 1200, width: 320 },
    layoutMeasurement: { height: 800, width: 320 },
  } });
  expect(rendered.getByTestId('new-messages-pill')).toBeTruthy();
  mockState.events = [{
    daemon_seq: 2,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'new message while anchored',
  }, ...mockState.events];
  invalidateSessionDetailCache('hostc:codex:one');
  rendered.rerender(<SessionScreen />);
  await act(async () => jest.runOnlyPendingTimers());
  expect(scrollToOffset).not.toHaveBeenCalled();
  expect(rendered.getByTestId('new-messages-count').props.children).toContain(1);

  fireEvent.press(rendered.getByTestId('new-messages-pill'));
  expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  expect(rendered.queryByTestId('new-messages-pill')).toBeNull();
});

test('long-press copies a message while visible copy buttons stay removed', async () => {
  mockState.events = [{
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:00Z',
    kind: 'USER',
    text: 'Ship Phase B',
  }, {
    daemon_seq: 2,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'Phase B is underway',
  }];

  const rendered = render(<SessionScreen />);
  expect(await screen.findByText('Ship Phase B')).toBeTruthy();
  expect(rendered.queryAllByTestId(/^copy-/)).toHaveLength(0);

  const userBubble = rendered
    .UNSAFE_getAllByProps({ delayLongPress: 350 })
    .find((node) => String(node.props.testID || '').startsWith('message-bubble-'));
  expect(userBubble).toBeTruthy();

  await act(async () => {
    fireEvent(userBubble!, 'longPress');
  });

  await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('Ship Phase B'));
  expect(screen.getByTestId('chat-copy-confirmation')).toBeTruthy();
});

test('primary input action sends composer text', async () => {
  render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'hello stream');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  await waitFor(() => expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: 'hello stream',
  }));
  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:codex:one', 'hello stream');
  expect(mockActions.clearDraft).toHaveBeenCalledWith('hostc:codex:one');
});

test('starting preserves the typed draft and waits for exact-stream ready before one send', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockState.sessions = [{
    ...mockState.sessions[0],
    bootstrap_state: 'starting',
    initial_prompt_delivery: { state: 'not_requested' },
  }];
  const rendered = render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  fireEvent.changeText(input, 'held until ready');

  expect(input.props.editable).toBe(true);
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('composer-send-button'));
  expect(mockActions.sendTurn).not.toHaveBeenCalled();
  expect(screen.getByTestId('composer-input').props.value).toBe('held until ready');
  expect(mockRegisterSendHandler).not.toHaveBeenCalled();

  mockState = {
    ...mockState,
    sessions: [{ ...mockState.sessions[0], bootstrap_state: 'ready' }],
  };
  rendered.rerender(<SessionScreen />);

  await waitFor(() => expect(mockRegisterSendHandler).toHaveBeenCalled());
  expect(screen.getByTestId('composer-input').props.value).toBe('held until ready');
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(false);
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
});

test('a stale send handler rechecks current readiness before optimistic insertion', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockState.sessions = [{ ...mockState.sessions[0], bootstrap_state: 'ready' }];
  const rendered = render(<SessionScreen />);
  await waitFor(() => expect(mockRegisterSendHandler).toHaveBeenCalled());
  const staleHandler = mockRegisterSendHandler.mock.calls[0][1] as (request: string) => Promise<void>;

  mockState = {
    ...mockState,
    sessions: [{ ...mockState.sessions[0], bootstrap_state: 'starting' }],
  };
  rendered.rerender(<SessionScreen />);
  await waitFor(() => expect(mockUnregisterSendHandler).toHaveBeenCalled());

  await expect(staleHandler('must not dispatch')).rejects.toThrow('not ready');
  expect(mockActions.sendTurn).not.toHaveBeenCalled();
});

test('focus, stream replacement, and reconnect cannot retain a starting handler', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockState.sessions = [{ ...mockState.sessions[0], bootstrap_state: 'ready' }];
  const rendered = render(<SessionScreen />);
  await waitFor(() => expect(mockRegisterSendHandler).toHaveBeenCalled());

  mockIsFocused = false;
  rendered.rerender(<SessionScreen />);
  await waitFor(() => expect(mockUnregisterSendHandler).toHaveBeenCalled());

  mockIsFocused = true;
  mockParams = { streamId: 'hostc%3Aclaude%3Atwo' };
  mockState = {
    ...mockState,
    connected: false,
    sessions: [{
      ...mockState.sessions[0],
      stream_id: 'hostc:claude:two',
      provider: 'claude',
      session_name: 'two',
      bootstrap_state: 'starting',
    }],
  };
  mockRegisterSendHandler.mockClear();
  rendered.rerender(<SessionScreen />);
  expect(mockRegisterSendHandler).not.toHaveBeenCalled();

  mockState = {
    ...mockState,
    connected: true,
    sessions: [{ ...mockState.sessions[0], bootstrap_state: 'ready' }],
  };
  rendered.rerender(<SessionScreen />);
  await waitFor(() => expect(mockRegisterSendHandler).toHaveBeenCalled());
  rendered.unmount();
  expect(mockUnregisterSendHandler).toHaveBeenCalled();
});

test('renders missing-session error state', () => {
  mockState.sessions = [];

  render(<SessionScreen />);

  expect(screen.getByText('Returning to chats...')).toBeTruthy();
});
