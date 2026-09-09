// Photo/camera send — compose/preview/remove/limit/payload/bubble/viewer.
// Drives the SessionScreen render path with the picker + upload services
// mocked (no native ImagePicker / no upload service). Covers the public behavior:
// select up to 5 + camera, 5-limit, per-photo remove, type-alongside,
// HEIC→JPEG compress invoked, send payload = text + ChatAttachment[] (FIFO,
// localPath never sent), media bubble render, tap-to-view.

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import type { ProcessedAsset } from '../src/services/imageCapture';
import type { ChatAttachment } from 'pentacle-chat-core';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockState: PentacleStreamState;
const mockKeyboardDismiss = jest.fn();
const mockInputFocus = jest.fn();
const mockInputBlur = jest.fn();
const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(),
  retainUploadForRetry: jest.fn(),
  replaceOptimisticAttachments: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};

jest.mock('react-native', () => {
  const ReactForMock = require('react');
  const actual = jest.requireActual('react-native');
  const MockTextInput = ReactForMock.forwardRef((props: any, ref: any) => {
    ReactForMock.useImperativeHandle(ref, () => ({ focus: mockInputFocus, blur: mockInputBlur, clear: jest.fn() }));
    return ReactForMock.createElement(actual.TextInput, props);
  });
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: jest.fn(() => ({ remove: jest.fn() })) };
      if (prop === 'InteractionManager') {
        return { runAfterInteractions: (cb: () => void) => { cb(); return { cancel: jest.fn() }; } };
      }
      if (prop === 'TextInput') return MockTextInput;
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => {
  const mock = require('./helpers/mocks/expoRouter').makeMock();
  return { ...mock, useLocalSearchParams: () => mockParams };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@expo/vector-icons', () => ({ FontAwesome: 'FontAwesome' }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
const mockUploadBlobBase64 = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(async (uri: string) => `b64:${uri}`),
  writeAsStringAsync: jest.fn(),
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///docs/',
  EncodingType: { Base64: 'base64' },
}));
jest.mock('../src/services/pentacleStream', () => ({
  uploadBlobBase64: (...args: unknown[]) => mockUploadBlobBase64(...args),
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
jest.mock('../src/services/userPreferences', () => ({ useUserPreference: jest.fn() }));

// Picker + compress service — mocked so a button press exercises the wiring
// without the native ImagePicker. `compressForUpload` re-encodes to image/jpeg
// (HEIC→JPEG) — we assert it is invoked before staging.
jest.mock('../src/services/imageCapture', () => ({
  pickImagesFromLibrary: jest.fn(),
  captureImageFromCamera: jest.fn(),
  compressForUpload: jest.fn(),
  MediaTooLargeError: class MediaTooLargeError extends Error {},
}));
// Upload leg — mocked so send produces blob-backed wire keys without daemon I/O.
jest.mock('../src/services/attachmentUpload', () => ({
  uploadStagedAttachments: jest.fn(),
}));

const imageCapture = require('../src/services/imageCapture');
const attachmentUpload = require('../src/services/attachmentUpload');

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

// A library asset as the (mocked) picker returns it, pre-compress.
function libraryAsset(i: number): ProcessedAsset {
  return {
    uri: `file:///tmp/lib-${i}.heic`,
    fileName: `lib-${i}.heic`,
    mimeType: 'image/heic',
    width: 100 + i,
    height: 200 + i,
    bytes: 0,
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

  // compress: stamp image/jpeg + a byte size, keep the uri (the local thumb).
  imageCapture.compressForUpload.mockImplementation(async (a: ProcessedAsset) => ({
    uri: a.uri,
    fileName: a.fileName.replace(/\.[^.]+$/, '.jpg'),
    mimeType: 'image/jpeg',
    width: a.width,
    height: a.height,
    bytes: 1000 + (a.width ?? 0),
  }));
  // library pick: return exactly `selectionLimit` assets (so the cap math shows).
  imageCapture.pickImagesFromLibrary.mockImplementation(async (limit: number) =>
    Array.from({ length: limit }, (_, i) => libraryAsset(i)),
  );
  imageCapture.captureImageFromCamera.mockResolvedValue(libraryAsset(99));
  // upload: echo a deterministic blob sha key per staged asset, FIFO.
  attachmentUpload.uploadStagedAttachments.mockImplementation(async (assets: ProcessedAsset[]) =>
    assets.map((a, i) => ({
      key: `${i}`.repeat(64),
      mime: 'image/jpeg',
      width: a.width ?? undefined,
      height: a.height ?? undefined,
      bytes: a.bytes,
    })) as ChatAttachment[],
  );

  // sendTurn: append the optimistic USER event + flip phase, return its id
  // (mirrors the real reducer enough for the screen to render the bubble).
  mockActions.sendTurn.mockImplementation((streamId: string, text: string, attachments?: ChatAttachment[]) => {
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
          ...(attachments?.length ? { attachments } : {}),
        }),
      ],
      workingByStream: {
        ...(mockState.workingByStream ?? {}),
        [streamId]: { phase: 'pending', optimisticId, sentAt: Date.now() },
      },
    };
    return optimisticId;
  });
  mockActions.replaceOptimisticAttachments.mockImplementation((optimisticId: string, attachments: ChatAttachment[]) => {
    mockState = {
      ...mockState,
      events: mockState.events.map((item) => (
        item.optimistic_id === optimisticId ? { ...item, attachments } : item
      )),
    };
  });
  mockActions.sendMessage.mockResolvedValue(true);
  mockInputFocus.mockClear();
  mockKeyboardDismiss.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

// Expand the more-menu and tap the photo action; await the async pick+compress.
async function stagePhotosViaLibrary() {
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-photo-button'));
  });
}

test('selects up to 5 library photos, previews them, and removes one', async () => {
  render(<SessionScreen />);
  await stagePhotosViaLibrary();

  // Picker launched with the full remaining budget (5).
  expect(imageCapture.pickImagesFromLibrary).toHaveBeenCalledWith(5);
  // Each picked asset is compressed (HEIC→JPEG) before staging.
  expect(imageCapture.compressForUpload).toHaveBeenCalledTimes(5);
  // Five removable thumbs render.
  for (let i = 0; i < 5; i += 1) {
    expect(screen.getByTestId(`composer-attachment-thumb-${i}`)).toBeTruthy();
  }

  // Remove one → four remain.
  act(() => {
    fireEvent.press(screen.getByTestId('composer-attachment-remove-0'));
  });
  expect(screen.queryByTestId('composer-attachment-thumb-4')).toBeNull();
  expect(screen.getByTestId('composer-attachment-thumb-3')).toBeTruthy();
});

test('enforces the 5-photo cap (no overshoot, picker not relaunched at the cap)', async () => {
  render(<SessionScreen />);
  await stagePhotosViaLibrary(); // stages 5
  expect(screen.getByTestId('composer-attachment-thumb-4')).toBeTruthy();

  imageCapture.pickImagesFromLibrary.mockClear();
  // Press photo again at the cap → no pick, surfaces a limit message.
  await stagePhotosViaLibrary();
  expect(imageCapture.pickImagesFromLibrary).not.toHaveBeenCalled();
  // Still exactly 5 — never a 6th.
  expect(screen.queryByTestId('composer-attachment-thumb-5')).toBeNull();
});

test('camera adds one photo, respecting the running cap', async () => {
  render(<SessionScreen />);
  act(() => {
    fireEvent.press(screen.getByTestId('composer-plus-button'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-camera-button'));
  });
  expect(imageCapture.captureImageFromCamera).toHaveBeenCalled();
  expect(imageCapture.compressForUpload).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('composer-attachment-thumb-0')).toBeTruthy();
  expect(screen.queryByTestId('composer-attachment-thumb-1')).toBeNull();
});

test('text is typeable alongside staged photos', async () => {
  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'caption text');
  expect(screen.getByTestId('composer-input').props.value).toBe('caption text');
  // Photos still staged alongside the text.
  expect(screen.getByTestId('composer-attachment-thumb-0')).toBeTruthy();
});

test('send delivers text + ChatAttachment[] together (FIFO, no localPath) and clears the draft', async () => {
  // Stage exactly 2 by limiting the library pick to 2.
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0), libraryAsset(1)]);
  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'look at these');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  // Upload ran over the 2 staged assets (FIFO).
  expect(attachmentUpload.uploadStagedAttachments).toHaveBeenCalledTimes(1);
  const uploadedAssets = attachmentUpload.uploadStagedAttachments.mock.calls[0][0];
  expect(uploadedAssets.map((a: ProcessedAsset) => a.uri)).toEqual([
    'file:///tmp/lib-0.heic',
    'file:///tmp/lib-1.heic',
  ]);

  // The send carries text + the wire ChatAttachment[] in FIFO order.
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  const sendArg = mockActions.sendMessage.mock.calls[0][0];
  expect(sendArg.host).toBe('hostc');
  expect(sendArg.sessionName).toBe('one');
  expect(sendArg.text).toBe('look at these');
  expect(sendArg.attachments.map((a: ChatAttachment) => a.key)).toEqual([
    '0'.repeat(64),
    '1'.repeat(64),
  ]);
  // localPath is daemon-side only — never on the wire.
  expect(JSON.stringify(sendArg.attachments)).not.toContain('localPath');
  // sendTurn also saw the attachments (optimistic path).
  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:codex:one', 'look at these', expect.any(Array));

  // Draft cleared (text + thumb strip gone).
  expect(screen.getByTestId('composer-input').props.value).toBe('');
  expect(screen.queryByTestId('composer-attachment-thumb-0')).toBeNull();
});

test('photo send inserts the optimistic row before upload resolves, then sends blob refs', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  let resolveUpload!: (attachments: ChatAttachment[]) => void;
  const uploadDeferred = new Promise<ChatAttachment[]>((resolve) => {
    resolveUpload = resolve;
  });
  attachmentUpload.uploadStagedAttachments.mockReturnValueOnce(uploadDeferred);

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'slow upload');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  const optimisticAttachments = mockActions.sendTurn.mock.calls[0][2] as Array<ChatAttachment & { uri?: string }>;
  expect(optimisticAttachments[0].key).toContain('local:');
  expect(optimisticAttachments[0].uri).toBe('file:///tmp/lib-0.heic');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();

  await act(async () => {
    resolveUpload([{ key: 'f'.repeat(64), mime: 'image/jpeg', width: 100, height: 200, bytes: 1100 }]);
    await uploadDeferred;
  });

  expect(mockActions.replaceOptimisticAttachments).toHaveBeenCalledWith(
    'optimistic_hostc_codex_one_1',
    [expect.objectContaining({ key: 'f'.repeat(64), uri: 'file:///tmp/lib-0.heic' })],
  );
  expect(mockActions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    attachments: [expect.objectContaining({ key: 'f'.repeat(64) })],
  }));
});

test('photo upload failure marks the already-visible optimistic row failed', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  attachmentUpload.uploadStagedAttachments.mockRejectedValueOnce(new Error('upload_blob_disk_full'));

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'will fail');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
    await Promise.resolve();
  });

  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith(
    'optimistic_hostc_codex_one_1',
    'upload_blob_disk_full',
  );
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});

// A socket drop during the upload leg is not a "keep pending" case — no `send`
// was dispatched, so nothing
// can ever reconcile the row. It must end failed (retryable), never "sending".
test('a socket drop during the upload leg fails the row visibly and dispatches no send', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  attachmentUpload.uploadStagedAttachments.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'dropped mid-upload');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
    await Promise.resolve();
  });

  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith(
    'optimistic_hostc_codex_one_1',
    'Pentacle stream disconnected',
  );
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
  // The staged asset is retained for Retry (re-upload without re-picking).
  expect(mockActions.retainUploadForRetry).toHaveBeenCalledWith(
    'optimistic_hostc_codex_one_1',
    expect.any(Function),
  );
});

// Through the composer + `uploadStagedAttachments`: only
// `uploadBlobBase64` is mocked. The socket drops during the blob upload ⇒ the
// row is failed (retryable), no send RPC is dispatched.
test('a blob upload rejection mid-upload fails the row through the compose path', async () => {
  const actualUpload = jest.requireActual('../src/services/attachmentUpload') as typeof import('../src/services/attachmentUpload');
  attachmentUpload.uploadStagedAttachments.mockImplementation(actualUpload.uploadStagedAttachments);
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'seam drop');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockUploadBlobBase64).toHaveBeenCalledTimes(1);
  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith('optimistic_hostc_codex_one_1', 'Pentacle stream disconnected');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
  expect(mockActions.retainUploadForRetry).toHaveBeenCalledWith('optimistic_hostc_codex_one_1', expect.any(Function));
});

// The send leg after a successful upload keeps the existing contract: a
// pre-dispatch rejection (socket not open) leaves the row queued for the
// once-on-reconnect resubmit (`tests/sessionScreenDisconnectSurvive.test.tsx`),
// a post-dispatch drop stays pending for the stamped echo. Only the UPLOAD leg
// is terminal, because it is the only leg nothing can replay or reconcile.
test('upload ok, then send rejected before dispatch (socket not open) keeps the row for the reconnect resubmit', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  mockActions.sendMessage.mockRejectedValueOnce(new Error('Pentacle stream is not connected'));

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'socket closed after upload');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
    await Promise.resolve();
  });

  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).not.toHaveBeenCalled();
});

test('upload ok, then a drop after the send frame left keeps the row pending (ambiguous)', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  mockActions.sendMessage.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));

  render(<SessionScreen />);
  await stagePhotosViaLibrary();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'dropped after dispatch');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
    await Promise.resolve();
  });

  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).not.toHaveBeenCalled();
});

test('a photo-only message (no text) still sends', async () => {
  imageCapture.pickImagesFromLibrary.mockResolvedValueOnce([libraryAsset(0)]);
  render(<SessionScreen />);
  await stagePhotosViaLibrary();

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  const sendArg = mockActions.sendMessage.mock.calls[0][0];
  expect(sendArg.text).toBe('');
  expect(sendArg.attachments).toHaveLength(1);
});

// Note: the user bubble's media render + tap-to-view are covered deterministically
// at the component level in tests/mediaBubble.test.tsx (TranscriptRow +
// ImageViewerModal) — driving them through the async upload→optimistic→transcript
// path couples the assertion to selectSessionDetail's content-version cache and
// the transcript-ready timer, which is render-timing noise, not the contract.
