// Stage 5b unit tests — pentacleEventUtils.mergeProgressiveUpdate.
// Spec: docs/public-test-spec.md
// (Regression: progressive duplicate-sequence handling).
import { mergeProgressiveUpdate } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

type Evt = { daemon_seq: number; text: string; raw?: Record<string, unknown> };

function evt(overrides: Partial<Evt> = {}): Evt {
  return { daemon_seq: 42, text: 'hello', ...overrides };
}

test('prefix-extension at the same seq returns a merged event with incoming text', () => {
  const prior = evt({ daemon_seq: 7, text: 'hello' });
  const incoming = evt({ daemon_seq: 7, text: 'hello, world' });
  const merged = mergeProgressiveUpdate(prior, incoming);
  expect(merged).not.toBeNull();
  expect(merged).not.toBe(prior);
  expect(merged?.daemon_seq).toBe(7);
  expect(merged?.text).toBe('hello, world');
});

test('non-prefix text at the same seq returns null (true duplicate, drop)', () => {
  const prior = evt({ daemon_seq: 7, text: 'hello' });
  const incoming = evt({ daemon_seq: 7, text: 'completely different' });
  expect(mergeProgressiveUpdate(prior, incoming)).toBeNull();
});

test('different daemon_seq returns null (caller appends as a fresh event)', () => {
  const prior = evt({ daemon_seq: 7, text: 'hello' });
  const incoming = evt({ daemon_seq: 8, text: 'hello, world' });
  expect(mergeProgressiveUpdate(prior, incoming)).toBeNull();
});

test('identical text at the same seq is a no-op (returns prior reference)', () => {
  const prior = evt({ daemon_seq: 7, text: 'hello' });
  const incoming = evt({ daemon_seq: 7, text: 'hello' });
  expect(mergeProgressiveUpdate(prior, incoming)).toBe(prior);
});

test('non-finite daemon_seq on either side returns null', () => {
  const prior = evt({ daemon_seq: Number.NaN, text: 'hello' });
  const incoming = evt({ daemon_seq: Number.NaN, text: 'hello, world' });
  expect(mergeProgressiveUpdate(prior, incoming)).toBeNull();
});

test('merged event carries incoming raw when present, else prior raw', () => {
  const priorRaw = { source: 'claude-jsonl', kind: 'old' };
  const incomingRaw = { source: 'claude-jsonl', kind: 'updated' };
  const prior = evt({ daemon_seq: 7, text: 'hello', raw: priorRaw });
  const merged = mergeProgressiveUpdate(prior, evt({ daemon_seq: 7, text: 'hello, world', raw: incomingRaw }));
  expect(merged?.raw).toBe(incomingRaw);
  const mergedNoIncomingRaw = mergeProgressiveUpdate(
    prior,
    { daemon_seq: 7, text: 'hello, world' },
  );
  expect(mergedNoIncomingRaw?.raw).toBe(priorRaw);
});
