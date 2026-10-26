// Steer now / Queue / Stop on agent chats: the mode control shows only while an
// agent chat works (never on the composite), Steer now sends one urgent message
// directly, and Stop and Steer now share one Escape per working turn.

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen, { TranscriptRow } from '../app/pentacle/session/[streamId]';
import { Spinner } from '../src/components/ArcaneAtoms';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleSessionSummary, PentacleStreamState, TurnState } from 'pentacle-chat-core';

const STREAM_ID = 'hostc:claude:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
let mockState: PentacleStreamState;

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  enqueueTurn: jest.fn(() => 'optimistic_queued_1'),
  canSendQueuedNow: jest.fn(() => true),
  sendQueuedNow: jest.fn().mockResolvedValue({ confirm: 'interrupt_unconfirmed', interrupted: true }),
  dispatchQueuedSendsByOptimisticId: jest.fn(),
  flushQueuedSends: jest.fn(),
  interruptSend: jest.fn((): Promise<unknown> => Promise.resolve(true)),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_test_1'),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});

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
// Host sigils resolve from configured hosts; the stub's default hostOrder
// (['hosta','hostb','hostc']) skins host 'hostc' as its positional machine (mage).
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => {
  const mock = require('./helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' })),
  sameStreamEventsLoadState: jest.fn((a, b) => a.currentGenerationComplete === b.currentGenerationComplete && a.fresh === b.fresh && a.requestStatus === b.requestStatus),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
	  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
	    const core = require('pentacle-chat-core');
	    const returned = (Object.values(state.optimisticSends ?? {}) as any[]).find((send) => (
	      send.stream_id === streamId && send.status === 'returned_to_prompt'
	    ));
	    return {
	      connecting: state.connecting,
	      hasHydrated: state.hasHydrated,
	      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
	      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
	      workingState: state.workingStates?.[streamId],
	      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
	      returnedToPromptDraft: returned
	        ? { optimisticId: returned.optimistic_id, text: returned.text }
	        : undefined,
	    };
	  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => mockState),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    title: 'Chat',
    last_event_at: '2026-06-17T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    session_generation: 'g1',
    ...overrides,
  };
}

function setTurn(turn: TurnState | undefined) {
  const next = { ...(mockState.workingByStream ?? {}) };
  if (turn === undefined) {
    delete next[STREAM_ID];
  } else {
    next[STREAM_ID] = turn;
  }
  mockState = { ...mockState, workingByStream: next };
}

function revealWorkingRow(ms: number = 275) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-06-17T12:00:00.000Z') });
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
  } as unknown as PentacleStreamState;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled: boolean, selector: any) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [false, jest.fn()]);
  mockActions.canSendQueuedNow.mockReturnValue(true);
  mockActions.sendQueuedNow.mockResolvedValue({ confirm: 'interrupt_unconfirmed', interrupted: true });
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.sendTurn.mockReturnValue('optimistic_test_1');
  mockActions.interruptSend.mockReturnValue(Promise.resolve(true));
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});


const WORKING = { phase: 'working', optimisticId: 'opt-1', sentAt: 1000, firstServerEventAt: 1000 } as TurnState;

function renderWorking(overrides: Partial<PentacleSessionSummary> = {}, turn: TurnState = WORKING) {
  mockState = { ...mockState, sessions: [session(overrides)] };
  setTurn(turn);
  const rendered = render(<SessionScreen />);
  revealWorkingRow();
  return rendered;
}

async function send(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
}


function renderTree(node: any): any {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(renderTree);
  const props: Record<string, unknown> = {};
  for (const key of ['testID', 'accessibilityRole', 'accessibilityLabel', 'accessibilityState', 'placeholder', 'value', 'editable', 'disabled', 'selectable']) {
    if (node.props?.[key] !== undefined) props[key] = node.props[key];
  }
  return { type: node.type, ...(Object.keys(props).length ? { props } : {}), children: renderTree(node.children) };
}
function setOptimistic(kind: 'unconfirmed' | 'queued' | 'processing') {
  const core = require('pentacle-chat-core');
  for (const [id, text] of [['row-one', 'first message'], ['row-two', 'second message']]) {
    mockState = core.enqueueOptimisticMessage(mockState, { streamId: STREAM_ID, text, optimisticId: id, requestId: id, createdAt: Date.now(), queuedAt: Date.now() });
    mockState = core.markOptimisticDispatchedByRequestId(mockState, id, Date.now());
    if (kind !== 'unconfirmed') {
      mockState = core.recordOptimisticSendAcceptanceByRequestId(mockState, id, { provider_queued: kind === 'queued' });
      mockState = core.markOptimisticAckedByRequestId(mockState, id, Date.now());
    }
  }
}
const captured: Record<string, unknown> = {};
afterAll(() => {
  const path = process.env.PENTACLE_RENDER_MANIFEST;
  if (path) require('fs').writeFileSync(path, JSON.stringify({ schema: 1, states: captured }, null, 2) + '\n');
});
test.each(['idle', 'working-draft', 'unconfirmed', 'queued', 'processing', 'composite', 'question', 'copy-user', 'copy-assistant'])('rendered manifest %s', async state => {
  if (['unconfirmed', 'queued', 'processing'].includes(state)) setOptimistic(state as any);
  if (state === 'composite') mockState.sessions = [session({ session_kind: 'assistant_composite', provider: 'composite' } as any)];
  if (state === 'question') {
    mockState.sessions = [session({ question: { question_key: 'fixture-question', header: 'Pick', prompt: 'Pick a color.', options: [{ index: 1, label: 'Amber', description: 'Warm', meta: false }, { index: 2, label: 'Violet', description: 'Cool', meta: false }] } } as any)];
  }
  let rendered;
  if (state.startsWith('copy-')) {
    rendered = render(<TranscriptRow item={{ id: state, timestampLabel: '', label: state === 'copy-user' ? 'You' : 'Agent', tone: state === 'copy-user' ? 'user' : 'agent', provider: 'claude', source: 'claude-jsonl', text: 'A 😀 silver amber violet; café silver\namber violet', kind: state === 'copy-user' ? 'USER' : 'ASSIST', isUser: state === 'copy-user', eventCase: state === 'copy-user' ? 'user-message' : 'agent-message', displayRule: state === 'copy-user' ? 'bubble:user' : 'bubble:agent' } as any} chrome={{ header: '#102a4a', accent: '#4da3ff', surface: '#0c1827', border: '#2f6ca5', title: 'Beta' }} />);
  } else {
    if (state === 'working-draft' || state === 'composite') setTurn(WORKING);
    rendered = render(<SessionScreen />);
    revealWorkingRow();
    if (state === 'working-draft') fireEvent.changeText(screen.getByTestId('composer-input'), 'retained draft');
    if (state === 'question') await act(async () => { fireEvent.press(screen.getByTestId('question-fab')); });
  }
  await act(async () => { await Promise.resolve(); });
  captured[state] = renderTree(rendered.toJSON());
  act(() => { rendered.unmount(); });
});
