import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockInputFocus = jest.fn();
const mockInputBlur = jest.fn();
const mockInputClear = jest.fn();
const mockAlert = jest.fn();
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};

jest.mock('react-native', () => {
  const ReactForMock = require('react');
  const actual = jest.requireActual('react-native');
  const MockTextInput = ReactForMock.forwardRef((props: any, ref: any) => {
    ReactForMock.useImperativeHandle(ref, () => ({
      focus: mockInputFocus,
      blur: mockInputBlur,
      clear: mockInputClear,
    }));
    return ReactForMock.createElement(actual.TextInput, props);
  });
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
      if (prop === 'Alert') return { alert: mockAlert };
      if (prop === 'InteractionManager') {
        return {
          runAfterInteractions: (callback: () => void) => {
            callback();
            return { cancel: jest.fn() };
          },
        };
      }
      if (prop === 'TextInput') return MockTextInput;
      return target[prop as keyof typeof target];
    },
  });
});
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
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
      workingState: state.workingStates?.[streamId],
      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
      sending: core.getSessionSendingState(state, streamId).sending,
      sendingImmediate: core.getSessionSendingState(state, streamId).immediate,
    };
  }),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
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
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    title: 'Composer',
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'codex',
    session_id: 'hostc:codex:one',
    session_name: 'one',
    stream_id: 'hostc:codex:one',
    timestamp: '2026-05-13T12:00:00.000Z',
    kind: 'ASSIST_TEXT',
    text: 'server event',
    ...overrides,
  };
}

function resetState() {
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    notifications: [],
    workingStates: {},
    optimisticSends: {},
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  delete process.env.EXPO_PUBLIC_HARNESS;
  resetState();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockActions.sendMessage.mockReturnValue(new Promise(() => undefined));
  // The composer calls actions.sendTurn, which synchronously appends the
  // optimistic USER event and sets phase=pending.
  mockActions.sendTurn.mockImplementation((streamId: string, text: string) => {
    const optimisticId = 'optimistic_hostc_codex_one_1';
    mockState = {
      ...mockState,
      events: [
        ...mockState.events,
        event({
          daemon_seq: Number.NaN,
          kind: 'USER',
          text,
          client_origin: true,
          optimistic_id: optimisticId,
          pending: true,
          created_at: Date.now(),
        }),
      ],
      workingByStream: {
        ...(mockState.workingByStream ?? {}),
        [streamId]: { phase: 'pending', optimisticId, sentAt: Date.now() },
      },
      optimisticSends: {
        ...(mockState.optimisticSends ?? {}),
        [optimisticId]: {
          optimistic_id: optimisticId,
          request_id: 'req_optimistic_1',
          stream_id: streamId,
          text,
          status: 'dispatched',
          created_at: Date.now() - 1_000,
          dispatched_at: Date.now() - 500,
          window_started_at: Date.now() - 500,
          reconnect_count: 0,
        },
      },
    };
    return optimisticId;
  });
  mockInputFocus.mockClear();
  mockInputBlur.mockClear();
  mockKeyboardDismiss.mockClear();
  mockAlert.mockClear();
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});

test('pressing Send clears immediately, inserts an optimistic bubble, and keeps composer editable', async () => {
  const rendered = render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'hello optimistic');
  act(() => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(screen.getByTestId('composer-input').props.value).toBe('');
  expect(screen.getByTestId('composer-input').props.editable).toBe(true);
  expect(mockKeyboardDismiss).toHaveBeenCalled();
  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:codex:one', 'hello optimistic');
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: 'hello optimistic',
  });

  rendered.rerender(<SessionScreen />);
  expect(await screen.findByText('hello optimistic')).toBeTruthy();
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();
});

// A controlled `value` going to ''
// is not enough on iOS — pending marked text (predictive input, dictation,
// third-party keyboards) commits into the native view when the keyboard
// resigns, leaving the sent text on screen. The send path must clear the
// native view imperatively on both sides of the keyboard dismissal.
test('pressing Send clears the native input imperatively around the keyboard dismissal', () => {
  mockInputClear.mockClear();
  mockKeyboardDismiss.mockClear();
  render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'teh autocorrected');
  act(() => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(screen.getByTestId('composer-input').props.value).toBe('');
  expect(mockInputClear).toHaveBeenCalledTimes(2);
  const [clearBefore, clearAfter] = mockInputClear.mock.invocationCallOrder;
  const [dismiss] = mockKeyboardDismiss.mock.invocationCallOrder;
  expect(clearBefore).toBeLessThan(dismiss);
  expect(clearAfter).toBeGreaterThan(dismiss);
  expect(mockActions.sendMessage).toHaveBeenCalledWith({ host: 'hostc', sessionName: 'one', text: 'teh autocorrected' });
});

test('a second non-empty tap surfaces feedback, retains its draft, and can send after settlement', async () => {
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  mockActions.sendMessage.mockReset();
  mockActions.sendMessage.mockReturnValueOnce(first).mockResolvedValue(true);
  const rendered = render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  const sendButton = screen.getByTestId('composer-send-button');

  fireEvent.changeText(input, 'first message');
  act(() => {
    fireEvent.press(sendButton);
  });
  fireEvent.changeText(input, 'second message');
  act(() => {
    fireEvent.press(sendButton);
  });

  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(input.props.value).toBe('second message');
  expect(mockAlert).toHaveBeenCalledWith('Pentacle', 'A message is already sending. Please wait.');

  await act(async () => {
    resolveFirst();
    await first;
  });
  mockState = {
    ...mockState,
    workingByStream: {
      ...(mockState.workingByStream ?? {}),
      'hostc:codex:one': { phase: 'idle' },
    },
  };
  rendered.rerender(<SessionScreen />);
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(2);
  expect(mockActions.sendMessage).toHaveBeenLastCalledWith({
    host: 'hostc',
    sessionName: 'one',
    text: 'second message',
  });
});

test('the in-flight modal is suppressed and the feedback outcome is recorded', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const rendered = render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  const sendButton = screen.getByTestId('composer-send-button');

  fireEvent.changeText(input, 'first message');
  act(() => {
    fireEvent.press(sendButton);
  });
  fireEvent.changeText(input, 'second message');
  act(() => {
    fireEvent.press(sendButton);
  });

  expect(mockAlert).not.toHaveBeenCalled();
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: core.TELEMETRY_EVENTS.HARNESS_SEND_ERROR_SUPPRESSED,
      data: expect.objectContaining({
        message: 'A message is already sending. Please wait.',
      }),
    }),
  ]));
  core.setTelemetrySink(null);
  rendered.unmount();
});
