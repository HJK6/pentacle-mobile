import React from 'react';
import {act, render} from '@testing-library/react-native';
import ApprovalKeySettings from '../src/components/ApprovalKeySettings';
import * as stream from '../src/services/pentacleStream';
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({getDefaultPentacleWsUrl: () => 'ws://default.example/ws'}));
jest.mock('expo-secure-store', () => ({getItemAsync: async () => null, setItemAsync: jest.fn()}));
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromServer(code = 1006, reason = 'network_drop') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }
}


beforeEach(() => {
 jest.useFakeTimers(); MockWebSocket.instances = [];
 global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
 stream.__resetPentacleStreamForTests();
});
afterEach(() => { stream.__resetPentacleStreamForTests(); jest.useRealTimers(); });
function mount() {
 const ui = render(<ApprovalKeySettings />);
 // Subscribe separately to drive the current public client even before the new hook exists.
 const stop = stream.subscribePentacleStream(jest.fn());
 act(() => jest.advanceTimersByTime(0));
 const socket = MockWebSocket.instances.at(-1)!;
 act(() => socket.open());
 return {ui, socket, stop};
}
const supported = {type:'snapshot', capabilities:{consent_enrollment_v1:true}};
test.each([
 ['old host', {type:'snapshot'}],
 ['unsupported', {type:'snapshot', capabilities:{consent_enrollment_v1:false}}],
 ['failed initialization', {type:'snapshot', capabilities:{}}],
 ['nonboolean capability', {type:'snapshot', capabilities:{consent_enrollment_v1:'true'}}],
])('%s fails closed', async (_name, snapshot) => {
 const {ui,socket,stop} = mount();
 await act(async () => {});
 act(() => socket.message(snapshot));
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 expect(ui.getByText('Not active yet')).toBeTruthy(); stop();
});
test('supported host opens only after a current snapshot and closes offline/reconnecting', async () => {
 const {ui,socket,stop} = mount();
 await act(async () => {});
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 act(() => socket.message(supported));
 expect(ui.getByTestId('approval-enrollment-code')).toBeTruthy();
 act(() => socket.closeFromServer());
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 act(() => {jest.advanceTimersByTime(1000); MockWebSocket.instances.at(-1)!.open();});
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 act(() => MockWebSocket.instances.at(-1)!.message(supported));
 expect(ui.getByTestId('approval-enrollment-code')).toBeTruthy(); stop();
});
test('host switch discards old readiness and rejects late old socket snapshots', async () => {
 const {ui,socket,stop} = mount();
 await act(async () => {});
 act(() => socket.message(supported));
 expect(ui.getByTestId('approval-enrollment-code')).toBeTruthy();
 act(() => stream.setPentacleWsUrl('ws://other.example/ws'));
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 act(() => { socket.message(supported); MockWebSocket.instances.at(-1)!.open(); });
 expect(ui.queryByTestId('approval-enrollment-code')).toBeNull();
 act(() => MockWebSocket.instances.at(-1)!.message({type:'snapshot'}));
 expect(ui.getByText('Not active yet')).toBeTruthy(); stop();
});
