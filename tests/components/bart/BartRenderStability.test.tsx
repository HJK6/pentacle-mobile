import React from 'react';
import { act, render } from '@testing-library/react-native';

import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { BART_STREAM_ID } from '../../../src/components/status/statusSelectors';
import usePentacleToken from '../../../src/hooks/usePentacleToken';

jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('expo-router', () => {
  const mock = require('../../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => ({ streamId: encodeURIComponent('hostc:codex:a') }),
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());

let mockFlatListRenderCount = 0;
let mockPreviousListData: unknown;
let mockFlatListDataChangeCount = 0;
const mockScrollToOffset = jest.fn();

jest.mock('react-native', () => {
  const ReactNative = jest.requireActual('react-native');
  const ReactForMock = require('react');
  const MockFlatList = ReactForMock.forwardRef((props: any, ref: any) => {
    mockFlatListRenderCount += 1;
    if (props.data !== mockPreviousListData) mockFlatListDataChangeCount += 1;
    mockPreviousListData = props.data;
    ReactForMock.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
    const rows = (props.data || []).map((item: any, index: number) => (
      <ReactNative.View key={props.keyExtractor ? props.keyExtractor(item, index) : String(index)}>
        {props.renderItem({ item, index })}
      </ReactNative.View>
    ));
    const footer = typeof props.ListFooterComponent === 'function'
      ? props.ListFooterComponent()
      : props.ListFooterComponent;
    return (
      <ReactNative.View testID={props.testID}>
        {rows}
        {footer}
      </ReactNative.View>
    );
  });
  return new Proxy(ReactNative, {
    get(target, prop) {
      if (prop === 'FlatList') return MockFlatList;
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) };
      if (prop === 'InteractionManager') {
        return { runAfterInteractions: (fn: () => void) => ({ cancel: jest.fn(), __run: fn }) };
      }
      return target[prop as keyof typeof target];
    },
  });
});

type MockSocketEvent = { data?: string };

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MockSocketEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const STREAM_A = BART_STREAM_ID;
const STREAM_B = 'hostc:codex:b';
const STREAM_C = 'hostc:codex:c';

function session(streamId: string) {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-05-27T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function event(streamId: string, daemonSeq: number, text: string, kind = 'ASSIST') {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    daemon_seq: daemonSeq,
    host: 'hostc',
    provider: 'codex',
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp: new Date(Date.now() + daemonSeq).toISOString(),
    kind,
    text,
  };
}

async function flush() {
  await act(async () => {});
}

// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../../../app/(tabs)/bart'));

test('Bart shell preserves the real session transcript isolation from unrelated live events', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  jest.useFakeTimers({ now: Date.parse('2026-05-27T12:00:00.000Z') });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  const telemetry: TelemetryPayload[] = [];
  setTelemetrySink((payload) => telemetry.push(payload));

  const harnessRuntime = require('../../../src/utils/harnessRuntime') as typeof import('../../../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=chat_render_stability&scenario_run_id=run-render-stability');

  const stream = require('../../../src/services/pentacleStream') as typeof import('../../../src/services/pentacleStream');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await flush();
  socket.message({ type: 'session.inventory', sessions: [session(STREAM_A), session(STREAM_B), session(STREAM_C)] });

  const BartScreen = require('../../../app/(tabs)/bart').default;
  const view = render(<BartScreen />);
  await flush();
  act(() => {
    socket.message({ type: 'chat.event', event: event(STREAM_A, 1, 'alpha seed') });
  });
  await flush();
  act(() => {
    jest.advanceTimersByTime(250);
  });
  await flush();

  const baseline = mockFlatListRenderCount;
  const dataBaseline = mockFlatListDataChangeCount;
  act(() => {
    for (let index = 0; index < 5; index += 1) {
      const streamId = index % 2 === 0 ? STREAM_B : STREAM_C;
      socket.message({ type: 'chat.event', event: event(streamId, 20 + index, `unrelated ${index}`) });
    }
  });
  await flush();
  // Bulk rows coalesce into the open batch window; flush so they APPLY — the
  // focused list must still not re-render for the unrelated streams.
  act(() => {
    jest.advanceTimersByTime(250);
  });
  await flush();
  expect(mockFlatListRenderCount).toBe(baseline);
  expect(mockFlatListDataChangeCount).toBe(dataBaseline);

  act(() => {
    socket.message({ type: 'chat.event', event: event(STREAM_A, 40, 'alpha own update') });
  });
  await flush();
  act(() => {
    jest.advanceTimersByTime(250);
  });
  await flush();
  // Characterize both commits: only the first changes transcript data; the
  // follow-up changes non-data props. Unrelated streams still cause neither.
  expect(mockFlatListRenderCount).toBeGreaterThan(baseline);
  expect(mockFlatListDataChangeCount).toBeGreaterThan(dataBaseline);


  view.unmount();
  unsubscribe();
  stream.__resetPentacleStreamForTests();
  setTelemetrySink(null);
  harnessRuntime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});
