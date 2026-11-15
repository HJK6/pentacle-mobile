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

function memoryStorage() {
  const items = new Map<string, string>();
  return { items, getItem: async (key: string) => items.get(key) ?? null, setItem: async (key: string, value: string) => { items.set(key, value); } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a closed card stays closed after a relaunch; only an unseen question reopens it, on that question', async () => {
  const storage = memoryStorage();
  const first = createQuestionCardStore('card', storage);
  await settle();
  first.observeDeck(['a', 'b']);
  expect(first.getSnapshot()).toEqual({ shown: true, pageKey: 'a' });
  first.hide();
  await settle();

  const relaunched = createQuestionCardStore('card', storage);
  relaunched.observeDeck(['a', 'b']);
  expect(relaunched.getSnapshot().shown).toBe(false);
  await settle();
  expect(relaunched.getSnapshot().shown).toBe(false);
  relaunched.observeDeck(['a', 'b']);
  expect(relaunched.getSnapshot().shown).toBe(false);
  relaunched.observeDeck(['a', 'b', 'c']);
  expect(relaunched.getSnapshot()).toEqual({ shown: true, pageKey: 'c' });
});

test('a card left open stays open after a relaunch, and the question button still toggles it', async () => {
  const storage = memoryStorage();
  const first = createQuestionCardStore('card', storage);
  await settle();
  first.observeDeck(['a']);
  await settle();
  const relaunched = createQuestionCardStore('card', storage);
  await settle();
  relaunched.observeDeck(['a']);
  expect(relaunched.getSnapshot().shown).toBe(true);
  relaunched.toggle(1);
  expect(relaunched.getSnapshot().shown).toBe(false);
  await settle();
  const again = createQuestionCardStore('card', storage);
  await settle();
  again.observeDeck(['a']);
  expect(again.getSnapshot().shown).toBe(false);
  again.toggle(1);
  expect(again.getSnapshot().shown).toBe(true);
});

test('questions that arrive while stored state loads open the card on the first unseen one', async () => {
  const storage = memoryStorage();
  storage.items.set('card', JSON.stringify({ shown: false, seen: ['a'] }));
  const store = createQuestionCardStore('card', storage);
  store.observeDeck(['a', 'b']);
  expect(store.getSnapshot().shown).toBe(false);
  await settle();
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'b' });
});

test('an unreadable stored record counts as none and the cap bounds only settled questions', async () => {
  const storage = memoryStorage();
  storage.items.set('card', '{not json');
  const store = createQuestionCardStore('card', storage);
  await settle();
  const pending = Array.from({ length: 600 }, (_, n) => `k${n}`);
  store.observeDeck(pending);
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'k0' });
  store.hide();
  await settle();
  expect(JSON.parse(storage.items.get('card')!).seen).toHaveLength(600);
  const relaunched = createQuestionCardStore('card', storage);
  relaunched.observeDeck(pending);
  await settle();
  expect(relaunched.getSnapshot().shown).toBe(false);
  relaunched.observeDeck(['fresh']);
  await settle();
  const seen = JSON.parse(storage.items.get('card')!).seen as string[];
  expect(seen).toHaveLength(501);
  expect(seen.slice(-2)).toEqual(['k599', 'fresh']);
  expect(relaunched.getSnapshot()).toEqual({ shown: true, pageKey: 'fresh' });
});

function deferredStorage(initial: Record<string, unknown>) {
  const items = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)] as const));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    items, release,
    getItem: async (key: string) => { await gate; return items.get(key) ?? null; },
    setItem: async (key: string, value: string) => { items.set(key, value); },
  };
}

test('a question still pending is never dropped by the stored cap, however many others settle', async () => {
  const storage = memoryStorage();
  const store = createQuestionCardStore('card', storage);
  await settle();
  store.observeDeck(['old']);
  store.hide();
  for (let n = 0; n < 501; n += 1) {
    store.observeDeck(['old', `new${n}`]);
    store.hide();
    store.observeDeck(['old']);
  }
  await settle();
  const relaunched = createQuestionCardStore('card', storage);
  await settle();
  relaunched.observeDeck(['old']);
  expect(relaunched.getSnapshot().shown).toBe(false);
});

test('opening and closing the card while stored state loads is what the next launch restores', async () => {
  const storage = deferredStorage({ card: { shown: true, seen: ['a'] } });
  const store = createQuestionCardStore('card', storage);
  store.observeDeck(['a']);
  store.toggle(1);
  store.hide();
  storage.release();
  await settle();
  expect(store.getSnapshot().shown).toBe(false);
  const relaunched = createQuestionCardStore('card', storage);
  await settle();
  relaunched.observeDeck(['a']);
  expect(relaunched.getSnapshot().shown).toBe(false);
});

test('a reset while stored state loads wins over the stored record', async () => {
  const storage = deferredStorage({ card: { shown: true, seen: ['a'] } });
  const store = createQuestionCardStore('card', storage);
  store.observeDeck(['a']);
  store.reset();
  storage.release();
  await settle();
  expect(store.getSnapshot().shown).toBe(false);
  expect(JSON.parse(storage.items.get('card')!)).toEqual({ shown: false, seen: [] });
  store.observeDeck(['a']);
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'a' });
});

test('button and close actions made while stored state loads keep their order against arrivals', async () => {
  // While loading the card is hidden, so the header button opens it. Each row: stored record, deck seen
  // before the action, actions, deck after loading, then the expected shown flag now and after a relaunch.
  type Row = [{ shown: boolean; seen: string[] }, string[], ('toggle' | 'hide')[], string[] | null, boolean, boolean];
  const rows: Row[] = [
    [{ shown: false, seen: ['a'] }, ['a', 'b'], ['toggle', 'hide'], null, false, false],
    [{ shown: true, seen: ['a'] }, ['a', 'b'], ['toggle', 'hide'], null, false, false],
    [{ shown: false, seen: [] }, ['a'], ['toggle', 'hide'], null, false, false],
    [{ shown: false, seen: ['a'] }, ['a', 'b'], ['toggle', 'hide'], ['a', 'b', 'c'], true, true],
    [{ shown: false, seen: ['a'] }, ['a'], ['toggle'], null, true, true],
    [{ shown: true, seen: ['a'] }, ['a', 'b'], ['toggle'], null, true, true],
  ];
  for (const [record, before, actions, after, shownNow, shownRelaunched] of rows) {
    const label = JSON.stringify({ record, before, actions, after });
    const storage = deferredStorage({ card: record });
    const store = createQuestionCardStore('card', storage);
    store.observeDeck(before);
    actions.forEach((action) => action === 'toggle' ? store.toggle(before.length) : store.hide());
    storage.release();
    await settle();
    if (after) store.observeDeck(after);
    expect([label, store.getSnapshot().shown]).toEqual([label, shownNow]);
    await settle();
    const relaunched = createQuestionCardStore('card', storage);
    await settle();
    relaunched.observeDeck(after ?? before);
    expect([label, relaunched.getSnapshot().shown]).toEqual([label, shownRelaunched]);
  }
});

test('a question that arrived before a close made while loading does not reopen the card', async () => {
  const storage = deferredStorage({ card: { shown: false, seen: ['a'] } });
  const store = createQuestionCardStore('card', storage);
  store.observeDeck(['a', 'b']);
  store.toggle(2);
  store.hide();
  storage.release();
  await settle();
  expect(store.getSnapshot().shown).toBe(false);
  store.observeDeck(['a', 'b', 'c']);
  expect(store.getSnapshot()).toEqual({ shown: true, pageKey: 'c' });
});
