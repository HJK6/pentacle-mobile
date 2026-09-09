// B1 (send-while-working queue): a message sent while the agent is working renders
// a native-CC-style queued affordance (`❯ Queued`). Receipt captions are
// projected by chat-core onto the latest user row; older queued-origin rows keep
// their B1 affordance. FIFO order is the transcript's render order.

import React from 'react';
import { Text, View } from 'react-native';
import { act, render, type RenderAPI } from '@testing-library/react-native';
import { TranscriptRow } from '../app/pentacle/session/[streamId]';
import type { PentacleTranscriptItem } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

(globalThis as typeof globalThis & { requestAnimationFrame?: (callback: FrameRequestCallback) => number }).requestAnimationFrame = (callback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
(globalThis as typeof globalThis & { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame = (handle) => {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

type TestNode = ReturnType<RenderAPI['UNSAFE_getByType']>;

const chrome = {
  header: '#102a4a',
  accent: '#4da3ff',
  surface: '#0c1827',
  border: '#2f6ca5',
  title: 'Beta',
};

function textOf(node: TestNode): string {
  const children = node.props.children;
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : '')).join('');
  }
  return '';
}

function allTextNodes(renderer: RenderAPI): string[] {
  return renderer.UNSAFE_getAllByType(Text).map((node) => textOf(node));
}

function has(renderer: RenderAPI, testID: string): boolean {
  return renderer.queryAllByTestId(testID).length > 0;
}

function userItem(overrides: Partial<PentacleTranscriptItem> = {}): PentacleTranscriptItem {
  return {
    id: 'user-row-1',
    timestampLabel: '',
    label: 'You',
    tone: 'user',
    provider: 'claude',
    source: 'claude-jsonl',
    text: 'deploy the build to hostc',
    kind: 'USER',
    isUser: true,
    eventCase: 'user-message',
    displayRule: 'bubble:user',
    ...overrides,
  } as PentacleTranscriptItem;
}

test('a queued-while-working row renders the ❯ Queued affordance + body text', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'queued', pending: true })} chrome={chrome} queuedWhileWorking />,
  );
  expect(has(renderer, 'queued-message-row')).toBe(true);
  expect(has(renderer, 'user-send-sent')).toBe(false);
  const texts = allTextNodes(renderer);
  expect(texts).toContain('Queued');
  expect(texts).toContain('❯');
  expect(texts).toContain('deploy the build to hostc');
  act(() => { renderer.unmount(); });
});

test('the in-flight (sending) state still shows Queued — it has not been delivered yet', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'sending', pending: true })} chrome={chrome} queuedWhileWorking />,
  );
  expect(has(renderer, 'queued-message-row')).toBe(true);
  expect(has(renderer, 'user-send-sent')).toBe(false);
  act(() => { renderer.unmount(); });
});

test('a queued row never infers Sent when its optimistic send state clears', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'queued', pending: true })} chrome={chrome} queuedWhileWorking />,
  );
  expect(has(renderer, 'queued-message-row')).toBe(true);
  expect(has(renderer, 'user-send-sent')).toBe(false);

  // Only a receiptCaption may render Sent; clearing the old B1 state does not.
  act(() => {
    renderer.rerender(
      <TranscriptRow item={userItem({ sendState: undefined, pending: undefined })} chrome={chrome} queuedWhileWorking />,
    );
  });
  expect(has(renderer, 'queued-message-row')).toBe(false);
  expect(has(renderer, 'user-send-sent')).toBe(false);
  act(() => { renderer.unmount(); });
});

test('multiple queued rows render FIFO (oldest first) with the queued affordance', () => {
  const renderer = render(
    <View>
      <TranscriptRow item={userItem({ id: 'r1', text: 'first queued', sendState: 'queued', pending: true })} chrome={chrome} queuedWhileWorking />
      <TranscriptRow item={userItem({ id: 'r2', text: 'second queued', sendState: 'queued', pending: true })} chrome={chrome} queuedWhileWorking />
      <TranscriptRow item={userItem({ id: 'r3', text: 'third queued', sendState: 'queued', pending: true })} chrome={chrome} queuedWhileWorking />
    </View>,
  );
  // All three render the queued affordance.
  expect(renderer.queryAllByTestId('queued-message-row').length).toBe(3);
  // FIFO: bodies appear oldest-first in render order.
  const texts = allTextNodes(renderer);
  const i1 = texts.indexOf('first queued');
  const i2 = texts.indexOf('second queued');
  const i3 = texts.indexOf('third queued');
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i1).toBeLessThan(i2);
  expect(i2).toBeLessThan(i3);
  act(() => { renderer.unmount(); });
});

test('an ordinary idle send (not queued-origin) shows neither Queued nor Sent caption', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: undefined })} chrome={chrome} queuedWhileWorking={false} />,
  );
  expect(has(renderer, 'queued-message-row')).toBe(false);
  expect(has(renderer, 'user-send-sent')).toBe(false);
  act(() => { renderer.unmount(); });
});

test('the stamped receipt caption traces Sending → Failed → Sent', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ receiptCaption: 'sending' })} chrome={chrome} queuedWhileWorking={false} />,
  );
  expect(has(renderer, 'user-send-sending')).toBe(true);
  expect(has(renderer, 'user-send-failed')).toBe(false);

  act(() => {
    renderer.rerender(
      <TranscriptRow item={userItem({ receiptCaption: 'failed' })} chrome={chrome} queuedWhileWorking={false} />,
    );
  });
  expect(has(renderer, 'user-send-sending')).toBe(false);
  expect(has(renderer, 'user-send-failed')).toBe(true);

  act(() => {
    renderer.rerender(
      <TranscriptRow item={userItem({ receiptCaption: 'sent' })} chrome={chrome} queuedWhileWorking={false} />,
    );
  });
  expect(has(renderer, 'user-send-failed')).toBe(false);
  expect(has(renderer, 'user-send-sent')).toBe(true);
  act(() => { renderer.unmount(); });
});

test('a terminal failed optimistic state shows the Failed caption (failed-precedence keeps retry reachable)', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'failed' })} chrome={chrome} queuedWhileWorking={false} />,
  );
  // userSendAffordance ([streamId].tsx) gives sendState 'failed' precedence over a
  // stale receipt caption, so a terminal optimistic failure always surfaces the
  // Failed caption and keeps the retry affordance reachable.
  expect(has(renderer, 'user-send-failed')).toBe(true);
  act(() => { renderer.unmount(); });
});

test('a cancelled queued row reads "Canceled" (cancel wins over the queued/sent affordance)', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'cancelled', pending: false })} chrome={chrome} queuedWhileWorking />,
  );
  expect(has(renderer, 'user-send-canceled')).toBe(true);
  expect(has(renderer, 'queued-message-row')).toBe(false);
  expect(has(renderer, 'user-send-sent')).toBe(false);
  act(() => { renderer.unmount(); });
});

