import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, type RenderAPI } from '@testing-library/react-native';
import { sessionQuestionProjectionItem, TranscriptRow } from '../app/pentacle/session/[streamId]';
import { buildDurableQuestionAnswerText } from '../src/services/agentQuestionNotifications';
import { buildPentacleQuestionAnswerText } from 'pentacle-chat-core';
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

function userItem(text: string): PentacleTranscriptItem {
  return {
    id: 'user-row-1',
    timestampLabel: '',
    label: 'You',
    tone: 'user',
    provider: 'claude',
    source: 'claude-jsonl',
    text,
    kind: 'USER',
    isUser: true,
    eventCase: 'user-message',
    displayRule: 'bubble:user',
  } as PentacleTranscriptItem;
}

function questionActivityItem(overrides: Partial<PentacleTranscriptItem> = {}): PentacleTranscriptItem {
  return {
    id: 'question-row-1',
    timestampLabel: '',
    label: 'Question',
    tone: 'system',
    provider: 'claude',
    source: 'claude-jsonl',
    text: 'Operator answered: hostc',
    kind: 'USER',
    isUser: false,
    eventCase: 'agent-question-answer',
    displayRule: 'activity:question',
    ...overrides,
  } as PentacleTranscriptItem;
}

function hasAnswerBubble(renderer: RenderAPI): boolean {
  return renderer.UNSAFE_queryAllByProps({ testID: 'answer-bubble' }).length > 0;
}

test('renders a single-select answer + note as a structured block (not raw grammar)', () => {
  const text = buildPentacleQuestionAnswerText({
    question: {
      header: 'Deploy',
      prompt: 'Choose a deployment target:',
      options: [{ index: 1, label: 'hostc' }, { index: 2, label: 'hosta' }],
    },
    answers: [{ selectedOptionLabel: 'hostc', note: 'Use the controller.' }],
  });
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem(text)} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  expect(hasAnswerBubble(rendered)).toBe(true);
  const texts = allTextNodes(rendered);
  expect(texts).toContain('Deploy');
  expect(texts).toContain('hostc');
  expect(texts).toContain('Use the controller.');
  // The raw AI-targeted grammar must NOT appear as a rendered line.
  expect(texts.some((value) => value.includes('Answering your question:'))).toBe(false);
  expect(texts.some((value) => value.includes('Q1 ('))).toBe(false);
  expect(texts.some((value) => value.includes('note (Q1):'))).toBe(false);

  act(() => { rendered.unmount(); });
});

test('renders a multi-select answer as one bullet per selected label', () => {
  const text = buildPentacleQuestionAnswerText({
    question: {
      header: 'Toppings',
      prompt: 'Which toppings?',
      multiSelect: true,
      options: [{ index: 1, label: 'Cheese' }, { index: 2, label: 'Mushrooms' }],
    },
    answers: [{ selectedOptionLabels: ['Cheese', 'Mushrooms'] }],
  });
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem(text)} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  expect(hasAnswerBubble(rendered)).toBe(true);
  const texts = allTextNodes(rendered);
  expect(texts).toContain('Toppings');
  expect(texts).toContain('Cheese');
  expect(texts).toContain('Mushrooms');
  expect(texts.filter((value) => value === '•').length).toBe(2);

  act(() => { rendered.unmount(); });
});

test('renders a free-text answer body verbatim inside the structured block', () => {
  const body = 'I need a machine\nthat can run tests.';
  const text = buildPentacleQuestionAnswerText({
    question: { header: 'Use case', prompt: 'Describe your use case:', options: [] },
    answers: [{ text: body }],
  });
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem(text)} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  expect(hasAnswerBubble(rendered)).toBe(true);
  const texts = allTextNodes(rendered);
  expect(texts).toContain('Use case');
  expect(texts).toContain(body);
  expect(texts.some((value) => value.includes('Answering your question:'))).toBe(false);

  act(() => { rendered.unmount(); });
});

test('renders a normal user message as a plain bubble with no false-positive answer block', () => {
  const text = 'hey can you deploy the build to hostc?';
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem(text)} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  expect(hasAnswerBubble(rendered)).toBe(false);
  expect(allTextNodes(rendered)).toContain(text);

  act(() => { rendered.unmount(); });
});

test('a Cancel-only (empty text) user row produces no answer bubble', () => {
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem('')} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  expect(hasAnswerBubble(rendered)).toBe(false);

  act(() => { rendered.unmount(); });
});

test('long-press copying an answer row yields the unchanged on-wire text (presentation only)', () => {
  const text = buildPentacleQuestionAnswerText({
    question: {
      header: 'Deploy',
      prompt: 'Choose a deployment target:',
      options: [{ index: 1, label: 'hostc' }],
    },
    answers: [{ selectedOptionLabel: 'hostc', note: 'Use the controller.' }],
  });
  const onCopy = jest.fn();
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={userItem(text)} chrome={chrome} onCopy={onCopy} />);
  const rendered = renderer as RenderAPI;

  expect(rendered.queryAllByTestId(/^copy-/)).toHaveLength(0);
  const messageBubble = rendered.getByTestId('message-bubble-user-row-1');
  act(() => { fireEvent(messageBubble, 'longPress'); });

  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(onCopy.mock.calls[0][0].text).toBe(text);

  act(() => { rendered.unmount(); });
});

test('renders a question-tool choice answer activity row with its note', () => {
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={questionActivityItem({ text: 'Operator answered: hostc\nNote: Use the controller.' })} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  const texts = allTextNodes(rendered);
  expect(texts).toContain('Operator answered: hostc');
  expect(texts).toContain('Note: Use the controller.');
  expect(texts.some((value) => value.includes('notification.answer'))).toBe(false);

  act(() => { rendered.unmount(); });
});

test('renders a question-tool free-text answer activity row', () => {
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={questionActivityItem({ text: 'Operator answered: Use the hosta workspace.' })} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  const texts = allTextNodes(rendered);
  expect(texts).toContain('Operator answered: Use the hosta workspace.');

  act(() => { rendered.unmount(); });
});

test('durable optimistic projection is a formatted question activity row, never raw JSON', () => {
  const item = sessionQuestionProjectionItem({
    key: 'durable:n-optimistic:q-optimistic',
    pending: true,
    text: buildDurableQuestionAnswerText({
      notificationId: 'n-optimistic',
      questionId: 'q-optimistic',
      actionKind: 'yes_no',
      selections: ['Lane B'],
    }),
  });

  expect(item.eventCase).toBe('agent-question-answer');
  expect(item.displayRule).toBe('activity:question');
  expect(item.text).toContain('Operator answered: Lane B');
  expect(item.text).not.toContain('notification.answer');
});

test('renders a question-tool prompt result as a question activity row', () => {
  let renderer: RenderAPI | undefined;
  renderer = render(<TranscriptRow item={questionActivityItem({
    kind: 'TOOL_RESULT',
    eventCase: 'agent-question-ask',
    text: 'Asked: Choose a host (q-19bccfa3)',
  })} chrome={chrome} />);
  const rendered = renderer as RenderAPI;

  const texts = allTextNodes(rendered);
  expect(texts).toContain('Asked: Choose a host (q-19bccfa3)');
  expect(texts).not.toContain('⎿');

  act(() => { rendered.unmount(); });
});
