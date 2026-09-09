import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import UnifiedScreen from '../app/(tabs)/unified';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import usePentacleToken from '../src/hooks/usePentacleToken';
import type { PentacleEvent, PentacleNotification, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { initialPentacleStreamState } from 'pentacle-chat-core';

const mockRouterPush = jest.fn();
let mockState: PentacleStreamState;
let mockComposerPayload: null | {
  text: string;
  optimisticAttachments?: any[];
  thumbs?: any[];
  upload?: { staged: any[]; promise: Promise<any[]> };
} = null;

const mockActions = {
  sendMessage: jest.fn().mockResolvedValue(true),
  sendTurn: jest.fn(),
  enqueueTurn: jest.fn(),
  flushQueuedSends: jest.fn(),
  dispatchQueuedSendsByOptimisticId: jest.fn(),
  replaceOptimisticAttachments: jest.fn(),
  markOptimisticFailed: jest.fn(),
  retainUploadForRetry: jest.fn(),
  resolveNotification: jest.fn().mockResolvedValue(true),
  answerPrompt: jest.fn().mockResolvedValue(true),
};

jest.mock('react-native', () => {
  const ReactForMock = require('react');
  const actual = jest.requireActual('react-native');
  const MockFlatList = ReactForMock.forwardRef((props: any, ref: any) => {
    ReactForMock.useImperativeHandle(ref, () => ({ scrollToOffset: jest.fn() }));
    const rows = (props.data || []).map((item: any, index: number) => (
      <actual.View key={props.keyExtractor ? props.keyExtractor(item, index) : String(index)}>
        {props.renderItem({ item, index })}
      </actual.View>
    ));
    const empty = rows.length === 0
      ? (typeof props.ListEmptyComponent === 'function' ? props.ListEmptyComponent() : props.ListEmptyComponent)
      : null;
    return <actual.View testID={props.testID}>{rows}{empty}</actual.View>;
  });
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'FlatList') return MockFlatList;
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
const mockUploadBlobBase64 = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(async (uri: string) => `b64:${uri}`),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('../src/services/pentacleStream', () => ({
  uploadBlobBase64: (...args: unknown[]) => mockUploadBlobBase64(...args),
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
}));
jest.mock('../app/pentacle/session/[streamId]', () => {
  const ReactForMock = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    hostChrome: (host: string) => ({
      header: '#080b0a',
      accent: host === 'hostc' ? '#29d4ff' : host === 'hostb' ? '#ff2e3e' : '#3dff66',
      surface: '#101712',
      border: '#254437',
      title: host === 'hostc' ? 'hostc' : host === 'hostb' ? 'hostb' : 'hosta',
    }),
    withRenderUris: (attachments: unknown) => attachments,
    ComposerBar: ({ onSend }: { onSend: (...args: any[]) => Promise<void> }) => (
      <View testID="mock-composer">
        <Text testID="composer-attachment-strip">images available</Text>
        <Pressable
          testID="mock-composer-send"
          onPress={() => {
            const payload = mockComposerPayload;
            if (payload) {
              // The real ComposerBar owns the rejection (draft restore + alert).
              void onSend(payload.text, payload.optimisticAttachments, payload.thumbs, payload.upload).catch(() => {});
            } else {
              void onSend('reply from unified');
            }
          }}
        >
          <Text>Send</Text>
        </Pressable>
      </View>
    ),
  };
});

function session(overrides: Partial<PentacleSessionSummary>): PentacleSessionSummary {
  return {
    stream_id: overrides.stream_id || `${overrides.host}:session`,
    host: overrides.host || 'hosta',
    provider: overrides.provider || 'codex',
    session_name: overrides.session_name || 'session',
    title: overrides.title || '',
    last_event_at: overrides.last_event_at || '2026-07-03T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    question: overrides.question,
    visibility: overrides.visibility,
  };
}

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: overrides.daemon_seq ?? 1,
    host: overrides.host || 'hosta',
    provider: overrides.provider || 'codex',
    session_id: '',
    session_name: overrides.session_name || 'session',
    stream_id: overrides.stream_id || 'hosta:session',
    timestamp: overrides.timestamp || '2026-07-03T12:00:00.000Z',
    kind: overrides.kind || 'ASSIST',
    text: overrides.text || '',
    client_origin: overrides.client_origin,
    optimistic_id: overrides.optimistic_id,
  };
}

function agentQuestionNotification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: overrides.notification_id || 'unified-question',
    created_at: overrides.created_at || '2026-07-03T12:04:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T12:04:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: 'hostb:question',
    severity: 'info',
    title: 'Pick a path',
    body: 'Which path should I take?',
    dedup_key: 'question:unified',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'action-1' }],
    question: {
      question_id: 'q-unified',
      producer_stream_id: 'hostb:question',
      response_mode: 'single_choice',
      options: [{ label: 'Path A', value: 'path_a' }],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-07-03T13:04:00.000Z',
    resolved_at: null,
    ...overrides,
  } as PentacleNotification;
}

function resetState() {
  mockState = {
    ...initialPentacleStreamState,
    connected: true,
    hasHydrated: true,
    sessions: [
      session({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', title: 'hosta Lane' }),
      session({ stream_id: 'hostc:two', host: 'hostc', session_name: 'two', title: 'hostc Lane' }),
      session({
        stream_id: 'hostb:question',
        host: 'hostb',
        provider: 'claude',
        session_name: 'question',
        title: 'Question Lane',
        last_event_at: '2026-07-03T12:04:00.000Z',
      }),
    ],
    events: [
      event({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', daemon_seq: 1, timestamp: '2026-07-03T12:01:00.000Z', text: 'hosta assistant' }),
      event({ stream_id: 'hostc:two', host: 'hostc', session_name: 'two', daemon_seq: 2, timestamp: '2026-07-03T12:02:00.000Z', text: 'hostc assistant' }),
      event({ stream_id: 'hosta:one', kind: 'TOOL_USE', daemon_seq: 3, timestamp: '2026-07-03T12:03:00.000Z', text: 'hidden tool' }),
      event({ stream_id: 'hosta:one', kind: 'SYSTEM', daemon_seq: 4, timestamp: '2026-07-03T12:04:00.000Z', text: 'hidden system' }),
    ],
    notifications: [agentQuestionNotification()],
  };
}

beforeEach(() => {
  resetState();
  mockComposerPayload = null;
  mockRouterPush.mockClear();
  mockActions.sendMessage.mockClear();
  mockActions.sendTurn.mockClear();
  mockActions.enqueueTurn.mockClear();
  mockActions.flushQueuedSends.mockClear();
  mockActions.dispatchQueuedSendsByOptimisticId.mockClear();
  mockActions.markOptimisticFailed.mockClear();
  mockActions.retainUploadForRetry.mockClear();
  mockUploadBlobBase64.mockReset();
  mockActions.resolveNotification.mockClear();
  mockActions.resolveNotification.mockResolvedValue(true);
  mockActions.answerPrompt.mockClear();
  mockActions.answerPrompt.mockResolvedValue(true);
  mockActions.sendTurn.mockImplementation((streamId: string, text: string) => {
    mockState = {
      ...mockState,
      events: [
        ...mockState.events,
        event({
          stream_id: streamId,
          host: 'hostc',
          session_name: 'two',
          kind: 'USER',
          daemon_seq: Number.NaN,
          timestamp: '2026-07-03T12:05:00.000Z',
          text,
          client_origin: true,
          optimistic_id: 'optimistic-two-1',
        }),
      ],
    };
    return 'optimistic-two-1';
  });
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
});

test('renders delivered assistant messages across chats and filters non-message rows', () => {
  const screen = render(<UnifiedScreen />);

  expect(screen.getByText('hosta assistant')).toBeTruthy();
  expect(screen.getByText('hostc assistant')).toBeTruthy();
  expect(screen.getByText('hosta Lane')).toBeTruthy();
  expect(screen.getByText('hostc Lane')).toBeTruthy();
  expect(screen.queryByText('hidden tool')).toBeNull();
  expect(screen.queryByText('hidden system')).toBeNull();
});

test('shows only default-visible messages but keeps hidden open questions answerable', () => {
  mockState = {
    ...mockState,
    sessions: [
      session({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', title: 'hosta Lane', visibility: 'default' }),
      session({ stream_id: 'hostc:two', host: 'hostc', session_name: 'two', title: 'Hidden Worker', visibility: 'hidden' }),
      session({
        stream_id: 'hostb:question',
        host: 'hostb',
        provider: 'claude',
        session_name: 'question',
        title: 'Hidden Question',
        visibility: 'nested',
        last_event_at: '2026-07-03T12:04:00.000Z',
      }),
    ],
    events: [
      event({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', daemon_seq: 1, timestamp: '2026-07-03T12:01:00.000Z', text: 'visible assistant' }),
      event({ stream_id: 'hostc:two', host: 'hostc', session_name: 'two', daemon_seq: 2, timestamp: '2026-07-03T12:02:00.000Z', text: 'hidden worker assistant' }),
    ],
    notifications: [agentQuestionNotification()],
  };

  const screen = render(<UnifiedScreen />);

  expect(screen.getByText('visible assistant')).toBeTruthy();
  expect(screen.queryByText('hidden worker assistant')).toBeNull();
  expect(screen.queryByText('Hidden Worker')).toBeNull();
  expect(screen.getByTestId('unified-question-badge')).toBeTruthy();
});

test('groups consecutive messages from the same chat under one title with multiple timestamps', () => {
  mockState = {
    ...mockState,
    events: [
      event({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', daemon_seq: 1, timestamp: '2026-07-03T12:01:00.000', text: 'first hosta update' }),
      event({ stream_id: 'hosta:one', host: 'hosta', session_name: 'one', daemon_seq: 2, timestamp: '2026-07-03T12:02:00.000', text: 'second hosta update' }),
      event({ stream_id: 'hostc:two', host: 'hostc', session_name: 'two', daemon_seq: 3, timestamp: '2026-07-03T12:03:00.000', text: 'hostc update' }),
    ],
    notifications: [],
  };

  const screen = render(<UnifiedScreen />);

  expect(screen.getByText('first hosta update')).toBeTruthy();
  expect(screen.getByText('second hosta update')).toBeTruthy();
  expect(screen.getByText('hostc update')).toBeTruthy();
  expect(screen.getAllByText('hosta Lane')).toHaveLength(1);
  expect(screen.getAllByTestId('unified-reply-hosta:one')).toHaveLength(1);
  expect(screen.getByText(/12:01.*12:02/)).toBeTruthy();
});

test('opens chats and routes replies to the selected stream with an attributable sent bubble', async () => {
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-open-hosta:one'));
  expect(mockRouterPush).toHaveBeenCalledWith('/pentacle/session/hosta%3Aone');

  expect(screen.queryByTestId('mock-composer')).toBeNull();
  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  expect(screen.getByTestId('mock-composer')).toBeTruthy();
  expect(screen.getByTestId('composer-attachment-strip')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
  });
	expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:two', 'reply from unified');
	expect(mockActions.sendMessage).toHaveBeenCalledWith({
	    host: 'hostc',
	    sessionName: 'two',
	    text: 'reply from unified',
	  });
  expect(screen.queryByTestId('mock-composer')).toBeNull();

  screen.rerender(<UnifiedScreen />);
  expect(screen.getByText('reply from unified')).toBeTruthy();
  expect(screen.getAllByText('hostc Lane').length).toBeGreaterThanOrEqual(1);
});

test('queues replies when the selected stream is working', async () => {
  mockState = {
    ...mockState,
    workingByStream: {
      'hostc:two': { phase: 'working', updatedAt: 0 } as any,
    },
  };
  mockActions.enqueueTurn.mockReturnValue('queued-two-1');
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
  });

	expect(mockActions.enqueueTurn).toHaveBeenCalledWith('hostc:two', 'reply from unified', undefined);
	expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledWith('hostc:two', 'queued-two-1');
	expect(mockActions.flushQueuedSends).not.toHaveBeenCalled();
	expect(mockActions.sendTurn).not.toHaveBeenCalled();
	expect(mockActions.sendMessage).not.toHaveBeenCalled();
  expect(screen.queryByTestId('mock-composer')).toBeNull();
});

test('passes uploaded attachments through the unified reply path', async () => {
  const optimisticAttachments = [{ key: 'optimistic-image', mime: 'image/png' }];
  const uploadedAttachments = [{ key: 'uploaded-image', mime: 'image/png', blob_ref: 'blob://uploaded' }];
  mockComposerPayload = {
    text: 'reply with image',
    optimisticAttachments,
    thumbs: [{ key: 'optimistic-image', renderUri: 'file://preview.png' }],
    upload: { staged: [], promise: Promise.resolve(uploadedAttachments) },
  };
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
  });

  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:two', 'reply with image', optimisticAttachments);
  expect(mockActions.replaceOptimisticAttachments).toHaveBeenCalledWith('optimistic-two-1', uploadedAttachments);
	expect(mockActions.sendMessage).toHaveBeenCalledWith({
	    host: 'hostc',
	    sessionName: 'two',
	    text: 'reply with image',
	    attachments: uploadedAttachments,
	  });
  expect(screen.queryByTestId('mock-composer')).toBeNull();
});

// optimistic_send_stuck_after_daemon_restart_2026_09: the unified composer shares
// the upload-leg terminal rule — a transport drop before any send is dispatched
// fails the row; it is never kept "sending".
test('a socket drop during the unified upload leg fails the row and dispatches no send', async () => {
  const optimisticAttachments = [{ key: 'local:0:file://preview.png', mime: 'image/png' }];
  const droppedUpload = Promise.reject(new Error('Pentacle stream is not connected'));
  droppedUpload.catch(() => {}); // the screen under test observes it; the fixture must not leak it
  mockComposerPayload = {
    text: 'reply dropped mid-upload',
    optimisticAttachments,
    thumbs: [{ key: 'optimistic-image', renderUri: 'file://preview.png' }],
    upload: { staged: [], promise: droppedUpload },
  };
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
    await Promise.resolve();
  });

  expect(mockActions.sendTurn).toHaveBeenCalledWith('hostc:two', 'reply dropped mid-upload', optimisticAttachments);
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith('optimistic-two-1', 'Pentacle stream is not connected');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
  expect(mockActions.retainUploadForRetry).toHaveBeenCalledWith('optimistic-two-1', expect.any(Function));
});

// SEAM(A2) on the unified surface: the real `beginStagedUpload` →
// `uploadStagedAttachments` runs, only `uploadBlobBase64` is mocked to drop.
test('SEAM(A2): uploadBlobBase64 rejecting fails the unified row through the real upload path', async () => {
  const { beginStagedUpload } = jest.requireActual('../src/services/optimisticSendUnit') as typeof import('../src/services/optimisticSendUnit');
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));
  const staged = [{ uri: 'file:///tmp/seam.jpg', fileName: 'seam.jpg', mimeType: 'image/jpeg', width: 10, height: 10, bytes: 4 }];
  const optimisticAttachments = [{ key: 'local:0:file:///tmp/seam.jpg', mime: 'image/jpeg', bytes: 4 }];
  const upload = beginStagedUpload(staged);
  upload.promise.catch(() => {}); // the screen observes it; the fixture must not leak it
  mockComposerPayload = { text: 'seam drop', optimisticAttachments, thumbs: [{ uri: 'file:///tmp/seam.jpg' }], upload };
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockUploadBlobBase64).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith('optimistic-two-1', 'Pentacle stream disconnected');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});

test('unified: after a good upload, neither a pre-dispatch nor a post-dispatch send drop fails the row (send-leg replay/echo contract)', async () => {
  const uploaded = [{ key: 'a'.repeat(64), mime: 'image/png' }];
  mockComposerPayload = {
    text: 'closed after upload',
    optimisticAttachments: [{ key: 'local:0:x', mime: 'image/png' }],
    thumbs: [],
    upload: { staged: [], promise: Promise.resolve(uploaded) },
  };
  mockActions.sendMessage.mockRejectedValueOnce(new Error('Pentacle stream is not connected'));
  let screen = render(<UnifiedScreen />);
  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
    await Promise.resolve();
  });
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).not.toHaveBeenCalled();
  screen.unmount();

  mockActions.markOptimisticFailed.mockClear();
  mockActions.sendMessage.mockClear();
  mockActions.sendMessage.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));
  mockComposerPayload = { ...mockComposerPayload, upload: { staged: [], promise: Promise.resolve(uploaded) } };
  screen = render(<UnifiedScreen />);
  fireEvent.press(screen.getByTestId('unified-reply-hostc:two'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('mock-composer-send'));
    await Promise.resolve();
  });
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(mockActions.markOptimisticFailed).not.toHaveBeenCalled();
});

test('question badge opens the shared card drawer and submits via prompt.answer', async () => {
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-question-badge'));

  expect(screen.getByText('Which path should I take?')).toBeTruthy();
  expect(screen.queryByTestId('unified-reply-hostb:question')).toBeNull();

  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-option-1'));
  });
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('smart-question-note'), 'drawer note');
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-unified',
    selections: ['path_a'],
    text: 'drawer note',
  });

  fireEvent.press(screen.getByTestId('unified-question-open-hostb:question'));
  expect(mockRouterPush).toHaveBeenCalledWith('/pentacle/session/hostb%3Aquestion');
});

test('question drawer submits an allowed custom answer through the durable wire field', async () => {
  const notification = agentQuestionNotification();
  mockState = {
    ...mockState,
    notifications: [agentQuestionNotification({
      question: { ...notification.question!, allow_custom: true } as unknown as PentacleNotification['question'],
    })],
  };
  const screen = render(<UnifiedScreen />);

  fireEvent.press(screen.getByTestId('unified-question-badge'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-custom-toggle'));
  });
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('smart-question-custom-answer'), 'Take the staged path');
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-unified',
    text: 'Take the staged path',
  });
});

