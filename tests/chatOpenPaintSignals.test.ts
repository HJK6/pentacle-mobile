import {
  createChatOpenPaintSignals,
  type ChatOpenPaintSignal,
} from '../src/services/chatOpenPaintSignals';

test('correlates all chat-open paint milestones with monotonic and wall timestamps', () => {
  const signals: ChatOpenPaintSignal[] = [];
  let tick = 0;
  const paint = createChatOpenPaintSignals(
    (signal) => signals.push(signal),
    {
      monotonicNow: () => ++tick,
      wallNow: () => 1_700_000_000_000 + tick,
    },
  );

  const correlationId = paint.begin('hostc:codex:alpha');
  paint.routerDispatchReturned(correlationId, 'hostc:codex:alpha');
  paint.shellLayoutCommitted(correlationId, 'hostc:codex:alpha');
  paint.firstAuthoritativeRowMounted(correlationId, 'hostc:codex:alpha');

  expect(signals.map((signal) => signal.phase)).toEqual([
    'tap',
    'router-dispatch-return',
    'shell-layout-commit',
    'first-authoritative-row-mount',
  ]);
  expect(new Set(signals.map((signal) => signal.correlationId))).toEqual(new Set([correlationId]));
  expect(signals.map((signal) => [signal.monotonicMs, signal.wallTimeMs])).toEqual([
    [1, 1_700_000_000_001],
    [2, 1_700_000_000_002],
    [3, 1_700_000_000_003],
    [4, 1_700_000_000_004],
  ]);
});

test('the default no-op sink avoids clock work and exposes no correlation id', () => {
  const monotonicNow = jest.fn(() => 1);
  const wallNow = jest.fn(() => 2);
  const paint = createChatOpenPaintSignals(undefined, { monotonicNow, wallNow });

  expect(paint.begin('hostc:codex:alpha')).toBeNull();
  paint.routerDispatchReturned('ignored', 'hostc:codex:alpha');
  paint.shellLayoutCommitted('ignored', 'hostc:codex:alpha');
  paint.firstAuthoritativeRowMounted('ignored', 'hostc:codex:alpha');

  expect(monotonicNow).not.toHaveBeenCalled();
  expect(wallNow).not.toHaveBeenCalled();
});
