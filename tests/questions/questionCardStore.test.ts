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
