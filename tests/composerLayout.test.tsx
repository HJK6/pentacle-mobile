import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import { MACHINES } from '../constants/Colors';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

// Composer layout foundation — public behavior.
// Pins the redesigned ComposerBar interaction shell: send anchored bottom-right,
// "+" anchored top-right, "+" expands to photo + camera, tap-away collapses.

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockInputFocus = jest.fn();
const mockInputBlur = jest.fn();
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
      clear: jest.fn(),
    }));
    return ReactForMock.createElement(actual.TextInput, props);
  });
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
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
  getPentacleStreamState: jest.fn(() => mockState),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));
// Media actions drive the picker service — mock it so a
// press exercises the wiring without touching the native ImagePicker.
jest.mock('../src/services/imageCapture', () => ({
  pickImagesFromLibrary: jest.fn().mockResolvedValue([]),
  captureImageFromCamera: jest.fn().mockResolvedValue(null),
  compressForUpload: jest.fn(),
  MediaTooLargeError: class MediaTooLargeError extends Error {},
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
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  resetState();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockReturnValue([false, jest.fn()]);
  mockActions.sendMessage.mockReturnValue(new Promise(() => undefined));
  mockActions.sendTurn.mockReturnValue('optimistic_hostc_codex_one_1');
  mockInputFocus.mockClear();
  mockInputBlur.mockClear();
  mockKeyboardDismiss.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test('send button anchors to the bottom-right corner', () => {
  render(<SessionScreen />);
  const sendStyle = StyleSheet.flatten(screen.getByTestId('composer-send-button').props.style);
  expect(sendStyle.position).toBe('absolute');
  expect(typeof sendStyle.bottom).toBe('number');
  expect(typeof sendStyle.right).toBe('number');
  expect(sendStyle.top).toBeUndefined();
});

test('plus button anchors to the top-right corner', () => {
  render(<SessionScreen />);
  const plusStyle = StyleSheet.flatten(screen.getByTestId('composer-plus-button').props.style);
  expect(plusStyle.position).toBe('absolute');
  expect(typeof plusStyle.top).toBe('number');
  expect(typeof plusStyle.right).toBe('number');
  expect(plusStyle.bottom).toBeUndefined();
});

test('composer container renders as a machine-accent glow capsule', () => {
  render(<SessionScreen />);

  const accent = MACHINES.hostc.accent;
  const capsuleStyle = StyleSheet.flatten(screen.getByTestId('composer-capsule').props.style);
  const hairlineStyle = StyleSheet.flatten(screen.getByTestId('composer-capsule-hairline').props.style);

  expect(capsuleStyle.borderRadius).toBe(12);
  expect(capsuleStyle.borderWidth).toBe(1);
  expect(capsuleStyle.borderColor).toBe(`${accent}54`);
  expect(capsuleStyle.backgroundColor).toBe('#0c1410');
  expect(capsuleStyle.shadowColor).toBe(accent);
  expect(capsuleStyle.shadowOpacity).toBe(0.25);
  expect(hairlineStyle.borderColor).toBe(`${accent}0f`);
  expect(capsuleStyle.borderColor).not.toBe(`${MACHINES.hosta.accent}44`);
});

test('expanding hides plus and stacks photo/camera buttons in the right gutter', () => {
  render(<SessionScreen />);
  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();

  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });

  expect(screen.queryByTestId('composer-plus-button')).toBeNull();

  const cameraStyle = StyleSheet.flatten(screen.getByTestId('composer-camera-button').props.style);
  const photoStyle = StyleSheet.flatten(screen.getByTestId('composer-photo-button').props.style);

  expect(cameraStyle.right).toBe(6);
  expect(photoStyle.right).toBe(6);
  expect(photoStyle.top).toBe(cameraStyle.top + 34);
  expect(cameraStyle.left).toBeUndefined();
  expect(photoStyle.left).toBeUndefined();
});

test('pressing the tap-away overlay collapses the expanded menu', () => {
  render(<SessionScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  expect(screen.getByTestId('composer-photo-button')).toBeTruthy();

  act(() => {
    fireEvent.press(screen.getByTestId('composer-tap-away'));
  });

  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();
  expect(screen.queryByTestId('composer-tap-away')).toBeNull();
});

test('focusing the text input collapses the expanded menu', () => {
  render(<SessionScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  expect(screen.getByTestId('composer-camera-button')).toBeTruthy();

  act(() => {
    fireEvent(screen.getByTestId('composer-input'), 'focus');
  });

  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();
});

test('typing in the text input collapses the expanded menu', () => {
  render(<SessionScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  expect(screen.getByTestId('composer-camera-button')).toBeTruthy();

  act(() => {
    fireEvent.changeText(screen.getByTestId('composer-input'), 'hello there');
  });

  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();
  expect(screen.getByTestId('composer-input').props.value).toBe('hello there');
});

test('pressing the text input collapses the expanded menu', () => {
  render(<SessionScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  expect(screen.getByTestId('composer-camera-button')).toBeTruthy();

  act(() => {
    fireEvent(screen.getByTestId('composer-input'), 'pressIn');
  });

  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();
});

test('the more-menu photo/camera actions open the picker and collapse the menu', async () => {
  const { pickImagesFromLibrary, captureImageFromCamera } = require('../src/services/imageCapture');
  render(<SessionScreen />);

  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-photo-button'));
  });
  expect(pickImagesFromLibrary).toHaveBeenCalled();
  // Tapping an action collapses the more-menu.
  expect(screen.queryByTestId('composer-photo-button')).toBeNull();

  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-camera-button'));
  });
  expect(captureImageFromCamera).toHaveBeenCalled();
  expect(screen.queryByTestId('composer-camera-button')).toBeNull();
});

test('sending collapses the menu and still dispatches the message', () => {
  render(<SessionScreen />);
  fireEvent.changeText(screen.getByTestId('composer-input'), 'hello there');
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  expect(screen.getByTestId('composer-photo-button')).toBeTruthy();

  act(() => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(screen.queryByTestId('composer-photo-button')).toBeNull();
  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:codex:one', 'hello there');
  expect(screen.getByTestId('composer-input').props.value).toBe('');
});
