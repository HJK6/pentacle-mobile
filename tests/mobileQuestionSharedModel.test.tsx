import React, { useMemo, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { PentacleNotification, PentacleQuestion } from 'pentacle-chat-core';

import {
  mobileQuestionAnswered,
  mobileQuestionItems,
  MobileQuestionOne,
  QuestionCardSurface,
  serializeMobileQuestionAnswer,
  useMobileQuestionFlow,
  type MobileQuestionDraft,
  type MobileQuestionEntry,
} from '../src/components/MobileQuestions';
import {
  buildDurableQuestionResolution,
  durableQuestionCardModel,
  filterUpdatesNotifications,
  isOpenAgentQuestionNotification,
} from '../src/services/agentQuestionNotifications';
import { buildNotificationResolvePayload } from '../src/services/pentacleStream';

const emptyDraft = (): MobileQuestionDraft => ({
  selectedIndices: [],
  note: '',
  customText: '',
  text: '',
  customOpen: false,
});

function choiceQuestion(overrides: Record<string, unknown> = {}): PentacleQuestion {
  return {
    header: 'Deploy lane',
    prompt: 'Which lane should run?',
    options: [
      { index: 1, label: 'Lane A', description: 'Safer rollout.' },
      { index: 2, label: 'Lane B' },
    ],
    ...overrides,
  } as PentacleQuestion;
}

function OneHarness({ question }: { question: PentacleQuestion }) {
  const [draft, setDraft] = useState(emptyDraft);
  const item = mobileQuestionItems(question)[0];
  return (
    <MobileQuestionOne
      entry={{ key: 'one', question: item, source: null }}
      draft={draft}
      accent="#3dff66"
      onChange={setDraft}
    />
  );
}

function FlowHarness({ question }: { question: PentacleQuestion }) {
  const entries = useMemo<MobileQuestionEntry[]>(() => mobileQuestionItems(question).map((item, index) => ({
    key: `q-${index}`,
    question: item,
    source: null,
  })), [question]);
  const [activeIndex, setActiveIndex] = useState(0);
  const flow = useMobileQuestionFlow(entries);
  return (
    <QuestionCardSurface
      entries={entries}
      activeIndex={activeIndex}
      flow={flow}
      accent="#3dff66"
      onIndexChange={setActiveIndex}
      onSend={jest.fn()}
    />
  );
}

test('renders label plus optional description and nests notes inside the selected option', () => {
  render(<OneHarness question={choiceQuestion()} />);

  expect(screen.getByTestId('question-option-description-1')).toHaveTextContent('Safer rollout.');
  expect(screen.queryByTestId('question-option-description-2')).toBeNull();
  expect(screen.queryByTestId('question-note-0')).toBeNull();

  fireEvent.press(screen.getByTestId('question-option-1'));
  const note = screen.getByTestId('question-note-0');
  expect(note).toBeTruthy();
  expect(within(screen.getByTestId('question-option-container-1')).getByTestId('question-note-0')).toBe(note);
  expect(screen.queryByText('Deploy lane')).toBeNull();
});

test('choice questions without allow_custom hide Custom and a note alone is not an answer', () => {
  render(<OneHarness question={choiceQuestion()} />);
  const item = mobileQuestionItems(choiceQuestion())[0];
  const noteOnly = { ...emptyDraft(), note: 'context only' };

  expect(screen.queryByTestId('question-custom-toggle')).toBeNull();
  expect(mobileQuestionAnswered(item, noteOnly)).toBe(false);
  expect(serializeMobileQuestionAnswer(item, noteOnly)).toEqual({ note: 'context only' });
});

test('Custom is exclusive with predefined choices in the shared UI', () => {
  render(<OneHarness question={choiceQuestion({ allow_custom: true })} />);

  fireEvent.press(screen.getByTestId('question-option-1'));
  expect(screen.getByTestId('question-option-1').props.accessibilityState.checked).toBe(true);
  fireEvent.press(screen.getByTestId('question-custom-toggle'));
  expect(screen.getByTestId('question-option-1').props.accessibilityState.checked).toBe(false);
  expect(screen.getByTestId('question-custom-toggle').props.accessibilityState.checked).toBe(true);
  expect(screen.queryByTestId('question-note-0')).toBeNull();
  fireEvent.changeText(screen.getByTestId('question-custom-answer'), 'Another lane');
  fireEvent.press(screen.getByTestId('question-option-2'));
  expect(screen.getByTestId('question-option-2').props.accessibilityState.checked).toBe(true);
  expect(screen.getByTestId('question-custom-toggle').props.accessibilityState.checked).toBe(false);
  expect(screen.queryByTestId('question-custom-answer')).toBeNull();
});

test('custom serializes exclusively and never carries the redundant note', () => {
  const item = mobileQuestionItems(choiceQuestion({ allow_custom: true }))[0];
  const customOnly = { ...emptyDraft(), customOpen: true, customText: 'Another lane', note: 'operator choice' };
  const combined = { ...customOnly, selectedIndices: [2] };

  expect(mobileQuestionAnswered(item, customOnly)).toBe(true);
  expect(serializeMobileQuestionAnswer(item, customOnly)).toEqual({
    customText: 'Another lane',
  });
  expect(serializeMobileQuestionAnswer(item, combined)).toEqual({
    customText: 'Another lane',
  });
});

test('plain free-text questions serialize text rather than customText', () => {
  const item = mobileQuestionItems({
    prompt: 'What should happen?',
    options: [],
    free_text: true,
    response_mode: 'free_text',
  } as unknown as PentacleQuestion)[0];
  const draft = { ...emptyDraft(), text: 'Ship after QA', note: 'not urgent' };

  expect(serializeMobileQuestionAnswer(item, draft)).toEqual({ text: 'Ship after QA', note: 'not urgent' });
});

test('shared flow exposes one dot per render item with active and answered state', () => {
  const question = {
    prompt: 'Plan',
    options: [],
    multi: true,
    questions: [
      { index: 0, prompt: 'First?', options: [{ index: 1, label: 'Yes' }] },
      { index: 1, prompt: 'Second?', options: [{ index: 1, label: 'Yes' }] },
    ],
  } as PentacleQuestion;
  render(<FlowHarness question={question} />);

  const firstDot = StyleSheet.flatten(screen.getByTestId('question-dot-0').props.style);
  expect(firstDot).toMatchObject({ width: 9, height: 9, borderWidth: 1.4 });
  expect(screen.getByTestId('question-dot-0').props.accessibilityState).toMatchObject({ selected: true, checked: false });
  expect(screen.getByTestId('question-dot-1').props.accessibilityState).toMatchObject({ selected: false, checked: false });
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  expect(screen.getByTestId('question-dot-0').props.accessibilityState.checked).toBe(true);
  fireEvent.press(screen.getByTestId('question-dot-1'));
  expect(screen.getByTestId('question-dot-1').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(true);
});

test('card footer uses compact navigation and SEND ALL without an unanswered text button', () => {
  const question = {
    prompt: 'Plan',
    options: [],
    multi: true,
    questions: [
      { index: 0, prompt: 'First?', options: [{ index: 1, label: 'Yes' }] },
      { index: 1, prompt: 'Second?', options: [{ index: 1, label: 'Yes' }] },
    ],
  } as PentacleQuestion;
  render(<FlowHarness question={question} />);

  expect(screen.getByTestId('smart-question-previous')).toBeTruthy();
  expect(screen.getByTestId('smart-question-next')).toBeTruthy();
  expect(screen.getByTestId('smart-question-submit-all').props.accessibilityState.disabled).toBe(true);
  expect(StyleSheet.flatten(screen.getByTestId('smart-question-submit-all').props.style)).toMatchObject({ width: 44, opacity: 0.5 });
  expect(StyleSheet.flatten(screen.getByTestId('smart-question-next').props.style)).toMatchObject({ width: 38, backgroundColor: 'transparent' });
  expect(screen.queryByText(/unanswered/i)).toBeNull();

  fireEvent.press(screen.getByTestId('smart-question-next'));
  expect(screen.getByTestId('smart-question-submit')).toHaveTextContent('SEND ALL');
  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(true);
});

test('durable normalization preserves description and allow_custom with title-only fallback', () => {
  const notification = {
    notification_id: 'n-1',
    producer: 'agent_question.v1',
    title: 'Choose',
    body: 'Pick a lane',
    state: 'open',
    actions: [{ kind: 'ack' }],
    question: {
      question_id: 'q-1',
      producer_stream_id: 'hostc:codex:test',
      response_mode: 'single_choice',
      allow_custom: true,
      options: [
        { label: 'A', value: 'a', description: 'Primary' },
        { label: 'B', value: 'b' },
      ],
      state: 'open',
      answer: null,
    },
  } as unknown as PentacleNotification;
  const model = durableQuestionCardModel(notification);

  expect(model?.allowCustom).toBe(true);
  expect(model?.question.options).toEqual([
    { index: 1, label: 'A', description: 'Primary', meta: false },
    { index: 2, label: 'B', meta: false },
  ]);
});

test('notification.resolve custom-only payload carries text as the answer, never as an option note', () => {
  expect(buildNotificationResolvePayload({
    notification_id: 'n-1',
    action_kind: 'ack',
    question_id: 'q-1',
    custom_text: 'with a staged rollout',
  })).toEqual({
    type: 'notification.resolve',
    notification_id: 'n-1',
    action_kind: 'ack',
    question_id: 'q-1',
    custom_text: 'with a staged rollout',
  });
});

test('durable resolver rejects injected Custom text unless the item explicitly allows it', () => {
  const notification = {
    notification_id: 'n-default-off',
    producer: 'agent_question.v1',
    title: 'Choose',
    body: 'Pick a lane',
    state: 'open',
    actions: [{ kind: 'ack' }],
    question: {
      question_id: 'q-default-off',
      producer_stream_id: 'hostc:codex:test',
      response_mode: 'single_choice',
      options: [{ label: 'A', value: 'a' }],
      state: 'open',
      answer: null,
    },
  } as unknown as PentacleNotification;
  const model = durableQuestionCardModel(notification)!;

  expect(() => buildDurableQuestionResolution(model, model.items[0], {
    customText: 'injected custom answer',
  })).toThrow('Choose an answer before submitting.');
});

test('durable resolver sends allowed Custom text exclusively without a stale note', () => {
  const notification = {
    notification_id: 'n-custom',
    producer: 'agent_question.v1',
    title: 'Choose',
    body: 'Pick a lane',
    state: 'open',
    actions: [{ kind: 'ack' }],
    question: {
      question_id: 'q-custom',
      producer_stream_id: 'hostc:codex:test',
      response_mode: 'single_choice',
      allow_custom: true,
      options: [{ label: 'A', value: 'a' }],
      state: 'open',
      answer: null,
    },
  } as unknown as PentacleNotification;
  const model = durableQuestionCardModel(notification)!;

  expect(buildDurableQuestionResolution(model, model.items[0], {
    customText: 'staged rollout',
    note: 'must not leak',
  })).toEqual({
    notification_id: 'n-custom',
    action_kind: 'ack',
    question_id: 'q-custom',
    custom_text: 'staged rollout',
  });
});

test('pending resolution stays in Updates and shared selectors so surfaces can preserve retry drafts', () => {
  const pending = {
    notification_id: 'n-pending',
    producer: 'agent_question.v1',
    state: 'open',
    client_resolution_pending: true,
  } as unknown as PentacleNotification;

  expect(filterUpdatesNotifications([pending])).toEqual([pending]);
  expect(isOpenAgentQuestionNotification(pending)).toBe(true);
});
