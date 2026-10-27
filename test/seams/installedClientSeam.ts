// Explicit capture-required Jest entry. The ordinary unit suite never substitutes
// static frames for this producer/transport/model integration check.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { selectSessionDetail } from 'pentacle-chat-core';

jest.mock('expo-notifications', () => ({}));
jest.mock('expo-constants', () => require('../../tests/helpers/stubs/expoConstants.cjs'));

class CaptureSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: CaptureSocket[] = [];
  readyState = CaptureSocket.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) { CaptureSocket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = CaptureSocket.OPEN; this.onopen?.(); }
  close() { this.readyState = CaptureSocket.CLOSED; this.onclose?.(); }
  message(raw: string) { this.onmessage?.({ data: raw }); }
}

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('same-run candidate daemon wire survives installed mobile transport, history, reconnect and replay', async () => {
  const input = process.env.PENTACLE_CLIENT_SEAM_CAPTURE;
  if (!input || !process.env.PENTACLE_CLIENT_SEAM_CAPTURE_SHA256 || !process.env.PENTACLE_CLIENT_SEAM_PRODUCER_SHA) {
    throw new Error('Capture path, exact SHA256 and producer SHA are required; no fixture fallback');
  }
  const bytes = readFileSync(input);
  expect(digest(bytes)).toBe(process.env.PENTACLE_CLIENT_SEAM_CAPTURE_SHA256);
  const capture = JSON.parse(bytes.toString());
  expect(capture.schema).toBe('pentacle.client-seam.v1');
  expect(capture.producer_sha).toBe(process.env.PENTACLE_CLIENT_SEAM_PRODUCER_SHA);
  expect(capture.stream_id).toBe('local:web-gate-seam');
  const entries: { phase: string; raw: string }[] = capture.frames;
  const frame = (phase: string, type: string) => {
    const value = entries.find(item => item.phase === phase && JSON.parse(item.raw).type === type);
    if (!value) throw new Error(`Missing real ${phase}/${type} capture`);
    return value.raw;
  };
  const initial = JSON.parse(frame('initial', 'snapshot'));
  expect(initial.events || []).toEqual([]);
  expect(initial.sessions.find((row: any) => row.stream_id === capture.stream_id).last_text).toBe(capture.expected.text);
  const listed = JSON.parse(frame('initial', 'list_sessions.ok'));
  expect(listed.active.find((row: any) => row.stream_id === capture.stream_id).last_text).toBe(capture.expected.text);

  jest.useFakeTimers();
  jest.resetModules();
  jest.doMock('../../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://client-seam.example/ws' }));
  global.WebSocket = CaptureSocket as unknown as typeof WebSocket;
  const transport = require('../../src/services/pentacleStream') as typeof import('../../src/services/pentacleStream');
  // Use the core loaded by the transport after resetModules, including its cache.
  const core = require('pentacle-chat-core') as { selectSessionDetail: typeof selectSessionDetail };
  let activeStream = capture.stream_id;
  const detail = () => core.selectSessionDetail(transport.getPentacleStreamState(), activeStream, { visibleCount: 'all' });
  const items = () => (detail()?.transcriptItems || []).map(item => ({ text: item.text, key: item.eventKey }));
  const observations: Record<string, unknown> = {};
  const unsubscribe = transport.subscribePentacleStream(() => {});
  const history = async (socket: CaptureSocket, phase: string) => {
    const response = JSON.parse(frame(phase, 'request_stream_events.ok'));
    if (activeStream !== capture.stream_id) {
      response.stream_id = activeStream;
      response.events = response.events.map((event: any) => ({ ...event, stream_id: activeStream }));
    }
    const pending = transport.requestStreamEvents(activeStream, 20);
    const request = socket.sent.filter(value => value.type === 'request_stream_events').at(-1);
    expect(request?.stream_id).toBe(activeStream);
    // Only the RPC correlation envelope changes for the receiving request.
    // Event/summary payloads remain the captured producer bytes/objects.
    socket.message(JSON.stringify({ ...response, request_id: request.request_id }));
    await pending;
    jest.advanceTimersByTime(100);
  };
  try {
    jest.advanceTimersByTime(0);
    const socket = CaptureSocket.instances.at(-1)!;
    expect(socket).toBeDefined();
    socket.open();
    socket.message(frame('initial', 'snapshot'));
    observations.summary = items();
    expect(items().map(item => item.text)).toEqual([capture.expected.text]);
    expect(items()[0].key).toBe('uncorrelated_fallback');
    await history(socket, 'initial');
    const held = items();
    observations.history = held;
    expect(held.map(item => item.text)).toEqual([capture.expected.text]);
    expect(held[0].key).not.toBe('uncorrelated_fallback');

    const updates = entries.filter(item => item.phase === 'initial' && ['chat.event', 'session.inventory'].includes(JSON.parse(item.raw).type));
    expect(updates.some(item => JSON.parse(item.raw).type === 'chat.event')).toBe(true);
    for (const update of updates) socket.message(update.raw);
    jest.advanceTimersByTime(100);
    const updated = items();
    observations.updated = updated;
    expect(updated.map(item => item.text)).toEqual([capture.expected.text, capture.expected.update]);
    expect(updated[0].key).toBe(held[0].key);

    transport.reconnectPentacleStream();
    const reconnected = CaptureSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(socket);
    reconnected.open();
    reconnected.message(frame('reconnect', 'snapshot'));
    await history(reconnected, 'reconnect');
    const replay = frame('reconnect', 'chat.event');
    reconnected.message(replay);
    reconnected.message(replay);
    jest.advanceTimersByTime(100);
    observations.replayed = items();
    expect(items()).toEqual(updated);

    // Synthetic negative compatibility controls, separately identified from
    // real seam evidence: missing/malformed/legacy optional summary fields.
    for (const mode of ['missing', 'malformed', 'legacy'] as const) {
      transport.reconnectPentacleStream();
      const negativeSocket = CaptureSocket.instances.at(-1)!;
      negativeSocket.open();
      const legacy = JSON.parse(frame('initial', 'snapshot'));
      const row = legacy.sessions.find((value: any) => value.stream_id === capture.stream_id);
      activeStream = `${capture.stream_id}-negative-${mode}`;
      row.stream_id = activeStream;
      legacy.events = [];
      if (mode === 'missing') { delete row.last_text; delete row.last_kind; }
      if (mode === 'malformed') { row.last_text = null; row.last_kind = null; }
      if (mode === 'legacy') row.last_text = row.last_text.replace(/\s+/g, ' ');
      negativeSocket.message(JSON.stringify(legacy));
      if (mode !== 'legacy') expect(items()).toEqual([]);
      else expect(items().map(item => item.text)).toEqual([capture.expected.text.replace(/\s+/g, ' ')]);
      await history(negativeSocket, 'initial');
      expect(items().map(item => item.text)).toEqual([capture.expected.text]);
      observations[mode] = items();
    }
    const output = process.env.PENTACLE_CLIENT_SEAM_RECEIPT;
    if (output) writeFileSync(output, JSON.stringify({
      schema: 'pentacle.mobile-client-seam.v1', passed: true,
      producer_sha: capture.producer_sha, capture_sha256: digest(bytes),
      consumer_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      consumer_sources: Object.fromEntries(['src/services/pentacleStream.ts', 'package-lock.json', 'test/setup.ts',
        'test/seams/installedClientSeam.ts'].map(file => [file, digest(readFileSync(file))])),
      observations, rpc_correlation_rebound: true, native_render_proof: false,
    }, null, 2));
  } finally {
    unsubscribe();
    transport.__resetPentacleStreamForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
