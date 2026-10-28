import type { TelemetryPayload } from 'pentacle-chat-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Event = { stream_id?: unknown; daemon_seq?: unknown };

const TRIGGER = { chat_list_js_stall_stream_id: 'mock-host:stall-trigger', chat_list_js_stall_seq: '1', chat_list_js_stall_ms: '5000' };

function harness(params: Record<string, string> = TRIGGER, options: { armed?: boolean; action?: boolean; build?: boolean } = {}) {
  jest.resetModules();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const traces: Array<Record<string, unknown>> = [];
  telemetry.setTelemetrySink((payload: TelemetryPayload) => {
    if (String(payload.message) === 'harness:ui_trace') traces.push(payload.data as Record<string, unknown>);
  });
  const listeners = new Set<() => void>();
  let events: Event[] = [];
  let clock = 1_000_000;
  let nowCalls = 0;
  const unsubscribe = actions.subscribeChatListJsStall({
    isHarnessBuild: options.build ?? true,
    isArmed: () => options.armed ?? true,
    hasAction: (name) => (options.action ?? true) && name === 'chat_list_js_stall',
    getParam: (name) => params[name],
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getState: () => ({ events }),
    // Every read advances 7 ms so the synchronous busy-wait terminates under test.
    now: () => { nowCalls += 1; clock += 7; return clock; },
  });
  return {
    traces,
    unsubscribe,
    listeners,
    get nowCalls() { return nowCalls; },
    push(next: Event[]) { events = next; [...listeners].forEach((listener) => listener()); },
  };
}

const stallTraces = (traces: Array<Record<string, unknown>>) =>
  traces.filter((trace) => String(trace.kind).startsWith('chat_list_js_stall'));

test('stalls JS once for the configured duration when the trigger identity reaches the store', () => {
  const h = harness();
  expect(h.unsubscribe).not.toBeNull();
  h.push([{ stream_id: 'mock-host:sample-00', daemon_seq: 1 }]);
  expect(stallTraces(h.traces)).toEqual([]);
  h.push([{ stream_id: 'mock-host:stall-trigger', daemon_seq: 1 }]);
  const [begin, end] = stallTraces(h.traces);
  expect(begin).toMatchObject({ kind: 'chat_list_js_stall_begin', stall_ms: 5000 });
  expect(end).toMatchObject({ kind: 'chat_list_js_stall_end', stall_ms: 5000 });
  expect(Number(end.timestamp_emitter_wall) - Number(begin.timestamp_emitter_wall)).toBeGreaterThanOrEqual(5000);
  expect(h.listeners.size).toBe(0);
  h.push([{ stream_id: 'mock-host:stall-trigger', daemon_seq: 1 }]);
  expect(stallTraces(h.traces)).toHaveLength(2);
});

test('fires when the trigger is already in the store at subscription', () => {
  jest.resetModules();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const kinds: string[] = [];
  telemetry.setTelemetrySink((payload: TelemetryPayload) => kinds.push(String((payload.data as Record<string, unknown>).kind)));
  let clock = 0;
  actions.subscribeChatListJsStall({
    isHarnessBuild: true, isArmed: () => true, hasAction: () => true,
    getParam: (name) => (TRIGGER as Record<string, string>)[name],
    subscribe: () => () => undefined,
    getState: () => ({ events: [{ stream_id: 'mock-host:stall-trigger', daemon_seq: '1' }] }),
    now: () => (clock += 50),
  });
  expect(kinds).toEqual(['chat_list_js_stall_begin', 'chat_list_js_stall_end']);
});

test.each([
  ['not a harness build', { build: false }],
  ['not armed', { armed: false }],
  ['action absent', { action: false }],
])('is inert when %s', (_label, options) => {
  const h = harness(TRIGGER, options);
  expect(h.unsubscribe).toBeNull();
  expect(h.listeners.size).toBe(0);
  expect(h.traces).toEqual([]);
  expect(h.nowCalls).toBe(0);
});

test.each(['499', '8001', '5000.5', 'abc', ''])('rejects stall_ms %p without stalling', (value) => {
  const h = harness({ ...TRIGGER, chat_list_js_stall_ms: value });
  expect(h.unsubscribe).toBeNull();
  expect(stallTraces(h.traces)).toEqual([expect.objectContaining({ kind: 'chat_list_js_stall_rejected', reason: 'invalid_params' })]);
  expect(h.listeners.size).toBe(0);
});

test('rejects a missing trigger identity', () => {
  const h = harness({ chat_list_js_stall_ms: '5000', chat_list_js_stall_seq: '1' });
  expect(h.unsubscribe).toBeNull();
  expect(stallTraces(h.traces)[0]).toMatchObject({ kind: 'chat_list_js_stall_rejected' });
});

test('root layout dispatches the stall only inside the harness-gated block', () => {
  const layout = readFileSync(resolve(__dirname, '../app/_layout.tsx'), 'utf8');
  const gate = layout.indexOf("if (process.env.EXPO_PUBLIC_HARNESS === '1') {");
  const dispatch = layout.indexOf('harnessActions.subscribeChatListJsStall(');
  expect(gate).toBeGreaterThan(-1);
  expect(dispatch).toBeGreaterThan(gate);
  expect(layout.match(/subscribeChatListJsStall\(/g)?.length).toBe(2);
});
