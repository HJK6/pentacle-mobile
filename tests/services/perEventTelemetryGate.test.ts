// Gate for the per-event CHAT_EVENT_RECEIVED mirror.
// logChatEventReceived() short-circuits on this predicate; the default sink
// does console.log(JSON.stringify(...)), so a production build must suppress.
import { isPerEventTelemetrySuppressed } from '../../src/services/pentacleStream';

test('production build (not dev, not harness) suppresses per-event telemetry', () => {
  expect(isPerEventTelemetrySuppressed(false, undefined)).toBe(true);
  expect(isPerEventTelemetrySuppressed(false, '0')).toBe(true);
});

test('dev and harness builds keep the per-event mirror', () => {
  expect(isPerEventTelemetrySuppressed(true, undefined)).toBe(false); // dev client
  expect(isPerEventTelemetrySuppressed(false, '1')).toBe(false); // harness build
  expect(isPerEventTelemetrySuppressed(true, '1')).toBe(false);
});
