import { createQuestionCardStore } from '../../src/components/questions/questionCardStore';

test('unseen keys show the first unseen page; hiding is sticky until a new key or toggle', () => {
  const store = createQuestionCardStore();
  store.observeDeck(['a', 'b']);
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'a' });
  store.hide();
  store.observeDeck(['a', 'b']);
  expect(store.getSnapshot().shown).toBe(false);
  store.observeDeck(['a', 'b', 'c', 'd']);
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'c' });
  store.toggle(4);
  expect(store.getSnapshot().shown).toBe(false);
  store.toggle(4);
  expect(store.getSnapshot().shown).toBe(true);
});

test('zero-count toggle is a no-op; effective empty deck alone does not settle a send', () => {
  const store = createQuestionCardStore();
  store.toggle(0);
  expect(store.getSnapshot().shown).toBe(false);
  store.observeDeck(['a']);
  store.observeDeck([]);
  expect(store.getSnapshot().shown).toBe(true);
  store.toggle(0);
  expect(store.getSnapshot().shown).toBe(true);
});

test('cold process shows the deck and process fields survive hide/re-show', () => {
  const store = createQuestionCardStore();
  store.field('draft', '');
  store.setField('draft', 'Chosen answer');
  store.observeDeck(['a']);
  store.hide();
  store.toggle(1);
  expect(store.field('draft', '')).toBe('Chosen answer');
  expect(createQuestionCardStore().getSnapshot().shown).toBe(false);
  const cold = createQuestionCardStore();
  cold.observeDeck(['a']);
  expect(cold.getSnapshot().shown).toBe(true);
});

test('lane cards retain drafts independently from the assistant card and other lanes', () => {
  const { laneQuestionCardStore, questionCardStore } = require('../../src/components/questions/questionCardStore');
  const first = laneQuestionCardStore('sample-lane-one');
  const second = laneQuestionCardStore('sample-lane-two');
  first.reset(); second.reset(); questionCardStore.reset();
  first.observeDeck(['question-one']);
  first.field('drafts', {});
  first.setField('drafts', { 'question-one': 'answer' });
  expect(laneQuestionCardStore('sample-lane-one').field('drafts', {})).toEqual({ 'question-one': 'answer' });
  expect(second.getSnapshot().shown).toBe(false);
  first.hide();
  first.show();
  expect(first.getSnapshot().shown).toBe(true);
  expect(questionCardStore.getSnapshot().shown).toBe(false);
});
