import { createChatOpenNavigationCoordinator } from '../src/services/chatOpenNavigationIntent';

test('keeps only the latest Chats-row target on the route stack', () => {
  jest.useFakeTimers();
  const coordinator = createChatOpenNavigationCoordinator();

  expect(coordinator.open({ streamId: 'stream-a', correlationId: 'a' })).toBe('push');
  expect(coordinator.open({ streamId: 'stream-a', correlationId: 'a-2' })).toBe('noop');
  expect(coordinator.open({ streamId: 'stream-b', correlationId: 'b' })).toBe('replace');
  expect(coordinator.ack('stream-a')).toBe('a');
  expect(coordinator.ack('stream-b')).toBe('b');
  expect(coordinator.pendingTarget()).toBeNull();

  jest.useRealTimers();
});

test('timeout clears only the pending intent and never swallows a later tap', () => {
  jest.useFakeTimers();
  const coordinator = createChatOpenNavigationCoordinator(20);

  expect(coordinator.open({ streamId: 'stream-a', correlationId: 'a' })).toBe('push');
  jest.advanceTimersByTime(20);
  expect(coordinator.pendingTarget()).toBeNull();
  expect(coordinator.open({ streamId: 'stream-b', correlationId: 'b' })).toBe('push');

  jest.useRealTimers();
});
