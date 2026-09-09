import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockActions = {
  sendMessage: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: mockKeyboardAddListener };
      if (prop === 'InteractionManager') {
        return {
          runAfterInteractions: (callback: () => void) => {
            callback();
            return { cancel: jest.fn() };
          },
        };
      }
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
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
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
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
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
    title: 'Divider count',
    last_event_at: '2026-05-16T12:00:07.000Z',
    last_text: 'Second request',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: 1,
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_id: 'session',
    session_name: 'one',
    timestamp: '2026-05-16T12:00:00.000Z',
    kind: 'SYSTEM',
    text: 'Worked for 1s',
    ...overrides,
  };
}

beforeEach(() => {
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [
      event({ daemon_seq: 1, kind: 'USER', text: 'First request', timestamp: '2026-05-16T12:00:00.000Z' }),
      event({ daemon_seq: 2, kind: 'SYSTEM', text: 'Worked for 1s', timestamp: '2026-05-16T12:00:01.000Z' }),
      event({
        daemon_seq: 3,
        provider: 'claude',
        kind: 'SYSTEM',
        text: '',
        timestamp: '2026-05-16T12:00:02.000Z',
        raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
      }),
      event({ daemon_seq: 4, kind: 'SYSTEM', text: 'Worked for 2s', timestamp: '2026-05-16T12:00:03.000Z' }),
      event({ daemon_seq: 5, kind: 'SYSTEM', text: 'Worked for 3s', timestamp: '2026-05-16T12:00:04.000Z' }),
      event({ daemon_seq: 6, kind: 'USER', text: 'Second request', timestamp: '2026-05-16T12:00:05.000Z' }),
    ],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockReturnValue([true, jest.fn()]);
});

// The direct codex divider regression moved to
// tests/contracts/codex_single_divider_per_turn.test.tsx so the trace is the
// canonical divider case contract. This file keeps the fallback-specific companion case.

test('session-summary fallback and prior divider furniture stay filtered', async () => {
  mockState = {
    ...mockState,
    sessions: [session({
      last_event_at: '2026-05-16T12:00:06.000Z',
      last_text: 'Worked for 4s',
      last_kind: 'SYSTEM',
    })],
    events: [
      event({ daemon_seq: 1, kind: 'USER', text: 'First request', timestamp: '2026-05-16T12:00:00.000Z' }),
      event({ daemon_seq: 2, kind: 'SYSTEM', text: 'Worked for 1s', timestamp: '2026-05-16T12:00:01.000Z' }),
      event({
        daemon_seq: 3,
        provider: 'claude',
        kind: 'SYSTEM',
        text: '',
        timestamp: '2026-05-16T12:00:02.000Z',
        raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
      }),
    ],
  };

  render(<SessionScreen />);

  await waitFor(() => expect(screen.getByTestId('transcript-list')).toBeTruthy());

  expect(screen.getByText('First request')).toBeTruthy();
  expect(screen.queryByText('Worked for 1s')).toBeNull();
  expect(screen.queryByText('Worked for 4s')).toBeNull();
  expect(screen.queryAllByTestId('terminal-divider-row')).toHaveLength(0);
});

