import { DashboardHubClient } from '../../../src/features/dashboards/dashboardHubClient';
import foreclosureEnvelope from '../../../test/e2e/fixtures/dashboard_hub/foreclosure.json';

class MockSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close = jest.fn();
}

test('subscribes, caches snapshots, computes staleness, handles push, and refreshes a batch', () => {
  let now = Date.parse('2026-07-17T08:00:10Z');
  const socket = new MockSocket();
  const createSocket = jest.fn(() => socket);
  const client = new DashboardHubClient({
    createSocket,
    now: () => now,
    random: () => 0,
    setTimer: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
  });
  const listener = jest.fn();
  client.subscribe(listener);
  client.configure({ url: 'ws://hub:7780', deviceToken: 'device-read-token' });
  client.connect();
  expect(createSocket).toHaveBeenCalledWith('ws://hub:7780/live?token=device-read-token');

  socket.onopen?.();
  expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'hello', subscribe: { all: true } });
  socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', dashboards: ['hosta.foreclosure'] }) });
  socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', envelope: foreclosureEnvelope }) });
  expect(client.get('hosta.foreclosure')).toMatchObject({
    default_batch: '2026-07-17',
    _transport_stale: false,
    _data_stale: false,
    _age_sec: 9,
  });

  client.refresh('hosta.foreclosure', { batch: '2026-07-16' });
  expect(socket.close).toHaveBeenCalledWith(4000, 'dashboard refresh');
  expect(createSocket).toHaveBeenCalledTimes(2);
  socket.onopen?.();
  expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'hello', subscribe: { all: true } });

  const pushed = { ...foreclosureEnvelope, updated_at: '2026-07-17T08:00:20Z', server_received_at: '2026-07-17T08:00:21Z' };
  now = Date.parse('2026-07-17T08:01:30Z');
  socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', envelope: pushed }) });
  expect(client.get('hosta.foreclosure')).toMatchObject({ default_batch: '2026-07-17', _data_stale: true });

  socket.onclose?.();
  expect(client.get('hosta.foreclosure')).toMatchObject({ _transport_stale: true });
  expect(listener).toHaveBeenCalled();
  client.disconnect();
});

test('ignores malformed frames and answers Hub pings', () => {
  const socket = new MockSocket();
  const client = new DashboardHubClient({ createSocket: () => socket });
  client.configure({ url: 'ws://hub:7780', deviceToken: 'token with space' });
  client.connect();
  socket.onmessage?.({ data: '{bad json' });
  socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', envelope: { dashboard_id: 'bad' } }) });
  socket.onmessage?.({ data: JSON.stringify({ type: 'ping' }) });
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'pong' });
  expect(client.get('bad')).toBeNull();
  client.disconnect();
});

test('closes half-open and errored sockets and schedules reconnect', () => {
  const socket = new MockSocket();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const setTimer = jest.fn((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  });
  const client = new DashboardHubClient({ createSocket: () => socket, random: () => 0, setTimer });
  client.configure({ url: 'ws://hub:7780', deviceToken: 'device-token' });
  client.connect();
  socket.onopen?.();
  expect(timers.find((timer) => timer.delay === 120000)).toBeDefined();
  timers.find((timer) => timer.delay === 120000)!.callback();
  expect(socket.close).toHaveBeenCalledWith(4001, 'dashboard heartbeat timeout');
  expect(timers.some((timer) => timer.delay === 1000)).toBe(true);

  const errorSocket = new MockSocket();
  const errorClient = new DashboardHubClient({ createSocket: () => errorSocket, random: () => 0, setTimer });
  errorClient.configure({ url: 'ws://hub:7780', deviceToken: 'device-token' });
  errorClient.connect();
  errorSocket.onerror?.();
  expect(errorSocket.close).toHaveBeenCalledWith(4002, 'dashboard socket error');
  expect(errorClient.getState()).toBe('offline');
  client.disconnect();
  errorClient.disconnect();
});
