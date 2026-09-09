import {
  CHAT_OPEN_LOAD_FIXTURES,
  CHAT_OPEN_NAVIGATION_FIXTURES,
  CHAT_OPEN_TRANSITION_FIXTURES,
} from './helpers/chatOpenContract';
import { createMemoryStackHarness } from './helpers/navigationHarness';
import { makeMock } from './helpers/mocks/expoRouter';

test('load fixtures cover every locked observable transition and retire lane-owned future markers', () => {
  expect(CHAT_OPEN_LOAD_FIXTURES.map((fixture) => fixture.id)).toEqual(expect.arrayContaining([
    'success-empty',
    'failure-with-preview',
    'offline-with-retained-rows',
  ]));
  expect(CHAT_OPEN_TRANSITION_FIXTURES.map((fixture) => fixture.id)).toEqual([
    'success-empty',
    'failure',
    'retry',
    'offline',
    'reconnect',
    'reset',
    'eviction',
    'stale-completion',
  ]);
  for (const fixture of [...CHAT_OPEN_LOAD_FIXTURES.filter((item) => item.id !== 'success-empty'), ...CHAT_OPEN_NAVIGATION_FIXTURES]) {
    expect(fixture.expectedFuture).toEqual([]);
  }
  expect(CHAT_OPEN_LOAD_FIXTURES.find((fixture) => fixture.id === 'success-empty')?.expectedFuture).toEqual(['bucket-coverage']);
  expect(CHAT_OPEN_TRANSITION_FIXTURES.every((fixture) => fixture.expectedFuture.length > 0)).toBe(true);
});

test('memory router exposes the final stack for the A-to-B replacement contract', () => {
  const stack = createMemoryStackHarness();

  stack.router.push({ pathname: '/pentacle/session/[streamId]', params: { streamId: 'stream-a' } });
  stack.router.replace({ pathname: '/pentacle/session/[streamId]', params: { streamId: 'stream-b' } });

  expect(stack.routes()).toEqual([
    { pathname: '/(tabs)/chats', params: {} },
    { pathname: '/pentacle/session/stream-b', params: { streamId: 'stream-b' } },
  ]);
  expect(stack.current().params).toEqual({ streamId: 'stream-b' });
  expect(CHAT_OPEN_NAVIGATION_FIXTURES.find((fixture) => fixture.id === 'tap-different-target')?.expectedAction).toBe('replace');
});

test('Expo Router mock can consume a mutable memory stack rather than only recording calls', () => {
  const stack = createMemoryStackHarness();
  const mock = makeMock({ router: stack.router });

  mock.router.push('/pentacle/session/stream-a');
  mock.router.replace('/pentacle/session/stream-b');

  expect(stack.routes().map((route) => route.pathname)).toEqual(['/(tabs)/chats', '/pentacle/session/stream-b']);
});
