import React from 'react';
import { Text } from 'react-native';
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

function hasCanceledIndicator(renderer: RenderAPI): boolean {
  return renderer.UNSAFE_queryAllByProps({ testID: 'user-send-canceled' }).length > 0;
}

test('a canceled send renders an explicit Canceled indicator (not a plain sent bubble)', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'cancelled', pending: false })} chrome={chrome} />,
  );

  expect(hasCanceledIndicator(renderer)).toBe(true);
  expect(allTextNodes(renderer)).toContain('Canceled');
  // The message body still renders; the row is canceled, not dropped.
  expect(allTextNodes(renderer)).toContain('deploy the build to hostc');

  act(() => { renderer.unmount(); });
});

test('a confirmed (sent) send shows no Canceled indicator', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: undefined })} chrome={chrome} />,
  );

  expect(hasCanceledIndicator(renderer)).toBe(false);
  expect(allTextNodes(renderer)).not.toContain('Canceled');

  act(() => { renderer.unmount(); });
});

test('a failed send shows no Canceled indicator (failed is distinct from canceled)', () => {
  const renderer = render(
    <TranscriptRow item={userItem({ sendState: 'failed', pending: false })} chrome={chrome} />,
  );

  expect(hasCanceledIndicator(renderer)).toBe(false);

  act(() => { renderer.unmount(); });
});

