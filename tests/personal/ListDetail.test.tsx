import {
  AMBER, MUTED, RED, advance, callsOf, colorOf, flush, mutationCalls, registerOutboundGuard, rpcError,
  rpcTimeout, sameColor, textOf, unknownOutcomeFor,
} from './support';
import { backCalls, fireEvent, isInert, mount, navTargets, resetWorld, screen, store, within } from './screens';
import type { FakeHousehold } from './support';

registerOutboundGuard();

let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const rows = () => screen.queryAllByTestId('list-item-row');
const labels = () => rows().map((r) => textOf(r));
const rowOf = (label: string) => {
  const hit = rows().find((r) => textOf(r).includes(label));
  if (!hit) throw new Error(`no list-item-row containing "${label}"; rows: ${JSON.stringify(labels())}`);
  return hit;
};
const hasRow = (label: string) => rows().some((r) => textOf(r).includes(label));
const tagsIn = (row: ReturnType<typeof rowOf>) => within(row).queryAllByTestId('list-item-tag');
const lampsIn = (row: ReturnType<typeof rowOf>) => within(row).queryAllByTestId('sigil-djinni');
const UNRESOLVED = "Couldn't confirm — checking again";

describe('ListDetail header, rows and copy', () => {
  it('shows the list name, the open count and the rows in priority-then-order order', async () => {
    await mount('ListDetail', { listId: 'tasks' });
    expect(screen.getByText('To-do')).toBeTruthy();
    expect(screen.getByText('6 OPEN')).toBeTruthy();
    expect(rows().length).toBe(6);
    const order = [
      'Reply to Kalshi support', // hi, position 2
      'Book flights for Nov', // hi, position 4
      'Renew domain for altum.ai', // med, position 1
      'Review index summary', // med, position 3
      'Pay invoice', // med, position 6
      'Sweep the garage', // lo
    ];
    order.forEach((label, i) => expect(textOf(rows()[i])).toContain(label));
  });

  it('shows due then priority tags with the right tones', async () => {
    await mount('ListDetail', { listId: 'tasks' });
    const expectTags = (label: string, expected: Array<[string, string]>) => {
      const tags = tagsIn(rowOf(label));
      expect(tags.map((t) => textOf(t))).toEqual(expected.map(([text]) => text));
      tags.forEach((t, i) => expect(sameColor(colorOf(t), expected[i][1])).toBe(true));
    };
    expectTags('Reply to Kalshi support', [['HIGH', AMBER]]);
    expectTags('Book flights for Nov', [['DUE OCT 20', AMBER], ['HIGH', AMBER]]);
    expectTags('Renew domain for altum.ai', [['DUE TODAY', RED]]);
    expectTags('Pay invoice', [['DUE TOMORROW', AMBER]]);
    expectTags('Sweep the garage', [['LOW', MUTED]]);
    expect(tagsIn(rowOf('Review index summary'))).toHaveLength(0);
  });

  it('shows OVERDUE in red on an overdue routine occurrence in Chores', async () => {
    await mount('ListDetail', { listId: 'chores' });
    const tags = tagsIn(rowOf('Change HVAC filter'));
    expect(tags.map((t) => textOf(t))).toEqual(['OVERDUE']);
    expect(sameColor(colorOf(tags[0]), RED)).toBe(true);
  });

  it('shows the Bart lamp only for Bart-created items; a partner-assistant-created shared item with due + hi gets tags but no lamp', async () => {
    await mount('ListDetail', { listId: 'tasks' });
    expect(lampsIn(rowOf('Reply to Kalshi support')).length).toBeGreaterThan(0);
    expect(lampsIn(rowOf('Renew domain for altum.ai')).length).toBeGreaterThan(0);
    const partnerItem = rowOf('Book flights for Nov');
    expect(tagsIn(partnerItem).length).toBe(2);
    expect(lampsIn(partnerItem)).toHaveLength(0);
    expect(lampsIn(rowOf('Pay invoice'))).toHaveLength(0);
    expect(lampsIn(rowOf('Review index summary'))).toHaveLength(0);
  });

  it('shows All clear for an empty list and always the footer hint', async () => {
    await mount('ListDetail', { listId: 'study' });
    expect(screen.getByText('All clear')).toBeTruthy();
    expect(screen.getByText('0 OPEN')).toBeTruthy();
    expect(rows()).toHaveLength(0);
    expect(screen.getByText('CHECKED ITEMS LEAVE AFTER 5s · ✕ REMOVES NOW')).toBeTruthy();
  });

  it('does not show All clear when the list has items', async () => {
    await mount('ListDetail', { listId: 'meals' });
    expect(screen.queryByText('All clear')).toBeNull();
    expect(screen.getByText('3 OPEN')).toBeTruthy();
  });

  it.each([
    ['tasks', 'To-do', 'New task…'],
    ['grocery', 'Grocery', 'Add an item…'],
    ['meals', 'Meals', 'Add a meal…'],
    ['chores', 'Chores', 'Add a chore…'],
    ['study', 'Study plan', 'Add a study block…'],
  ])('%s: title %s and add placeholder %s', async (listId, name, placeholder) => {
    await mount('ListDetail', { listId });
    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByTestId('list-add-input').props.placeholder).toBe(placeholder);
  });

  it('the back chevron navigates away (to the Lists index)', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(screen.getByText('‹'));
    await flush();
    const targets = navTargets();
    expect(backCalls() + targets.length).toBeGreaterThan(0);
    if (targets.length) expect(targets.join(' ')).toContain('personal/lists');
  });
});

describe('ListDetail: Household store unavailable', () => {
  it('shows the unavailable line when the first snapshot fails', async () => {
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await mount('ListDetail', { listId: 'grocery' }, false);
    expect(screen.getByText('Household store unavailable')).toBeTruthy();
  });

  it('keeps the last snapshot on screen when a later refresh is unavailable', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    expect(hasRow('Paneer')).toBe(true);
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await Promise.resolve(store().getState().refresh()).catch(() => undefined);
    await flush();
    expect(screen.getByText('Household store unavailable')).toBeTruthy();
    expect(hasRow('Paneer')).toBe(true);
  });
});

describe('ListDetail: add row', () => {
  it('hides the Add button until the trimmed text is non-empty', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    expect(screen.queryByTestId('list-add-button')).toBeNull();
    fireEvent.changeText(screen.getByTestId('list-add-input'), '   ');
    expect(screen.queryByTestId('list-add-button')).toBeNull();
    fireEvent.changeText(screen.getByTestId('list-add-input'), ' Mint ');
    expect(screen.getByTestId('list-add-button')).toBeTruthy();
  });

  it('Add trims, sends one household.item.add {list, label}, clears the input and shows the row once', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.changeText(screen.getByTestId('list-add-input'), '  Mint leaves ');
    fireEvent.press(screen.getByTestId('list-add-button'));
    await flush();
    expect(mutationCalls()).toEqual([
      { verb: 'household.item.add', fields: { list: 'grocery', label: 'Mint leaves' } },
    ]);
    expect(screen.getByTestId('list-add-input').props.value).toBe('');
    expect(rows().filter((r) => textOf(r).includes('Mint leaves'))).toHaveLength(1);
    expect(screen.getByText('5 OPEN')).toBeTruthy();
  });

  it('Enter submits like the Add button', async () => {
    await mount('ListDetail', { listId: 'meals' });
    fireEvent.changeText(screen.getByTestId('list-add-input'), 'Tacos');
    fireEvent(screen.getByTestId('list-add-input'), 'submitEditing', { nativeEvent: { text: 'Tacos' } });
    await flush();
    expect(mutationCalls()).toEqual([
      { verb: 'household.item.add', fields: { list: 'meals', label: 'Tacos' } },
    ]);
  });

  it('ignores an exact duplicate of an open label but not a different-case label', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.changeText(screen.getByTestId('list-add-input'), 'Paneer');
    fireEvent.press(screen.getByTestId('list-add-button'));
    await flush();
    expect(mutationCalls()).toEqual([]);
    fireEvent.changeText(screen.getByTestId('list-add-input'), 'paneer');
    fireEvent.press(screen.getByTestId('list-add-button'));
    await flush();
    expect(mutationCalls().map((c) => c.fields.label)).toEqual(['paneer']);
  });

  it('a definite failure adds no row and sends no second add', async () => {
    server.override('household.item.add', () => Promise.reject(rpcError('unavailable')));
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.changeText(screen.getByTestId('list-add-input'), 'Mint');
    fireEvent.press(screen.getByTestId('list-add-button'));
    await flush();
    await advance(60000);
    expect(hasRow('Mint')).toBe(false);
    expect(callsOf('household.item.add')).toHaveLength(1);
  });
});

describe('ListDetail: check → 5 s pending → one household.item.done', () => {
  it('shows the pending row with UNDO and no ✕, drops the open count, and hides the tags', async () => {
    await mount('ListDetail', { listId: 'tasks' });
    fireEvent.press(within(rowOf('Reply to Kalshi support')).getByTestId('list-item-check'));
    await flush();
    const row = rowOf('Reply to Kalshi support');
    expect(textOf(within(row).getByTestId('list-item-undo'))).toBe('UNDO · 5s');
    expect(within(row).queryByTestId('list-item-remove')).toBeNull();
    expect(tagsIn(row)).toHaveLength(0);
    expect(screen.getByText('5 OPEN')).toBeTruthy();
    expect(mutationCalls()).toEqual([]);
    fireEvent.press(within(row).getByTestId('list-item-undo')); // leave no pending state behind
  });

  it('counts down and sends nothing until exactly 5000 ms, then one done and the row leaves', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(within(rowOf('Paneer')).getByTestId('list-item-check'));
    await flush();
    await advance(2500);
    expect(textOf(within(rowOf('Paneer')).getByTestId('list-item-undo'))).toBe('UNDO · 3s');
    await advance(2499);
    expect(mutationCalls()).toEqual([]);
    await advance(1);
    expect(mutationCalls()).toEqual([{ verb: 'household.item.done', fields: { item_id: 11 } }]);
    await flush();
    expect(hasRow('Paneer')).toBe(false);
    expect(screen.getByText('3 OPEN')).toBeTruthy();
    await advance(60000);
    expect(callsOf('household.item.done')).toHaveLength(1);
  });

  it('tapping the label starts the pending state too', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(within(rowOf('Coffee beans')).getByText('Coffee beans'));
    await flush();
    expect(within(rowOf('Coffee beans')).getByTestId('list-item-undo')).toBeTruthy();
    fireEvent.press(within(rowOf('Coffee beans')).getByTestId('list-item-undo'));
  });

  it('UNDO before 5 s sends nothing and restores the ✕ and the tags', async () => {
    await mount('ListDetail', { listId: 'tasks' });
    fireEvent.press(within(rowOf('Pay invoice')).getByTestId('list-item-check'));
    await flush();
    await advance(2000);
    fireEvent.press(within(rowOf('Pay invoice')).getByTestId('list-item-undo'));
    await flush();
    await advance(60000);
    expect(mutationCalls()).toEqual([]);
    const row = rowOf('Pay invoice');
    expect(within(row).getByTestId('list-item-remove')).toBeTruthy();
    expect(within(row).queryByTestId('list-item-undo')).toBeNull();
    expect(tagsIn(row).map((t) => textOf(t))).toEqual(['DUE TOMORROW']);
    expect(screen.getByText('6 OPEN')).toBeTruthy();
  });

  it('pressing the checkbox again while pending is an undo and sends nothing', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(within(rowOf('Limes')).getByTestId('list-item-check'));
    await flush();
    await advance(1000);
    fireEvent.press(within(rowOf('Limes')).getByTestId('list-item-check'));
    await flush();
    await advance(60000);
    expect(mutationCalls()).toEqual([]);
    expect(within(rowOf('Limes')).queryByTestId('list-item-undo')).toBeNull();
  });

  it('a pending check survives a snapshot refetch and still sends exactly one done at 5 s', async () => {
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(within(rowOf('Paneer')).getByTestId('list-item-check'));
    await flush();
    await advance(1000);
    await Promise.resolve(store().getState().refresh());
    await flush();
    expect(within(rowOf('Paneer')).getByTestId('list-item-undo')).toBeTruthy();
    await advance(4000);
    expect(callsOf('household.item.done')).toHaveLength(1);
  });

  it('a failed done restores the row (with ✕) and is not retried', async () => {
    server.override('household.item.done', () => Promise.reject(rpcError('unavailable')));
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.press(within(rowOf('Paneer')).getByTestId('list-item-check'));
    await flush();
    await advance(5000);
    await flush();
    const row = rowOf('Paneer');
    expect(within(row).getByTestId('list-item-remove')).toBeTruthy();
    expect(within(row).queryByTestId('list-item-undo')).toBeNull();
    await advance(60000);
    expect(callsOf('household.item.done')).toHaveLength(1);
  });
});

describe('ListDetail: ✕ removes now', () => {
  it('sends one household.item.remove immediately and the row leaves', async () => {
    await mount('ListDetail', { listId: 'meals' });
    fireEvent.press(within(rowOf('Pasta night')).getByTestId('list-item-remove'));
    await flush();
    expect(mutationCalls()).toEqual([{ verb: 'household.item.remove', fields: { item_id: 32 } }]);
    expect(hasRow('Pasta night')).toBe(false);
    expect(screen.getByText('2 OPEN')).toBeTruthy();
  });

  it('a failed remove restores the row and is not retried', async () => {
    server.override('household.item.remove', () => Promise.reject(rpcError('unavailable')));
    await mount('ListDetail', { listId: 'meals' });
    fireEvent.press(within(rowOf('Pasta night')).getByTestId('list-item-remove'));
    await flush();
    await advance(60000);
    expect(hasRow('Pasta night')).toBe(true);
    expect(within(rowOf('Pasta night')).getByTestId('list-item-remove')).toBeTruthy();
    expect(callsOf('household.item.remove')).toHaveLength(1);
  });
});

const UNKNOWN: Array<[string, () => Error]> = [
  ['errorCode unknown_outcome', () => rpcError('unknown_outcome')],
  ['RPC timeout (no errorCode)', rpcTimeout],
];

describe('ListDetail: unknown outcomes (spec Target 6) are reconciled by readback, never resubmitted', () => {
  describe.each(UNKNOWN)('add with %s', (_name, makeError) => {
    it('keeps the draft, disables Add, then shows the row when the late commit appears at the 6 s readback', async () => {
      server.override('household.item.add', unknownOutcomeFor('household.item.add', 3000, makeError));
      await mount('ListDetail', { listId: 'grocery' });
      fireEvent.changeText(screen.getByTestId('list-add-input'), 'Mint');
      fireEvent.press(screen.getByTestId('list-add-button'));
      await flush();

      expect(callsOf('household.item.add')).toHaveLength(1);
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();
      expect(screen.getByTestId('list-add-input').props.value).toBe('Mint');
      expect(hasRow('Mint')).toBe(false);
      expect(isInert(screen.queryByTestId('list-add-button'))).toBe(true);
      const button = screen.queryByTestId('list-add-button');
      if (button) fireEvent.press(button);
      fireEvent(screen.getByTestId('list-add-input'), 'submitEditing', { nativeEvent: { text: 'Mint' } });
      await flush();
      expect(callsOf('household.item.add')).toHaveLength(1);

      await advance(6000);
      await flush();
      expect(rows().filter((r) => textOf(r).includes('Mint'))).toHaveLength(1);
      expect(screen.queryByText(UNRESOLVED)).toBeNull();
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(callsOf('household.item.add')).toHaveLength(1);
    });

    it('shows Not saved and re-enables Add when the row is still absent after the second readback', async () => {
      server.override('household.item.add', unknownOutcomeFor('household.item.add', 'never', makeError));
      await mount('ListDetail', { listId: 'grocery' });
      fireEvent.changeText(screen.getByTestId('list-add-input'), 'Mint');
      fireEvent.press(screen.getByTestId('list-add-button'));
      await flush();
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();

      await advance(6000);
      await flush();
      expect(screen.getByText('Not saved')).toBeTruthy();
      expect(screen.queryByText(UNRESOLVED)).toBeNull();
      expect(hasRow('Mint')).toBe(false);
      expect(screen.getByTestId('list-add-input').props.value).toBe('Mint');
      const button = screen.getByTestId('list-add-button');
      expect(isInert(button)).toBe(false);
      expect(callsOf('household.item.add')).toHaveLength(1); // the client never resent it on its own

      fireEvent.press(button); // an explicit user retry is a new, single mutation
      await flush();
      expect(callsOf('household.item.add')).toHaveLength(2);
    });
  });

  it('an add that had committed before the response was lost shows the row with no second add', async () => {
    server.override('household.item.add', unknownOutcomeFor('household.item.add', 'now'));
    await mount('ListDetail', { listId: 'grocery' });
    fireEvent.changeText(screen.getByTestId('list-add-input'), 'Mint');
    fireEvent.press(screen.getByTestId('list-add-button'));
    await flush();
    await advance(6000);
    await flush();
    expect(rows().filter((r) => textOf(r).includes('Mint'))).toHaveLength(1);
    expect(screen.queryByText('Not saved')).toBeNull();
    expect(callsOf('household.item.add')).toHaveLength(1);
  });

  describe.each(UNKNOWN)('check with %s', (_name, makeError) => {
    it('keeps the row hidden while unresolved and brings it back with Not saved when still present', async () => {
      server.override('household.item.done', unknownOutcomeFor('household.item.done', 'never', makeError));
      await mount('ListDetail', { listId: 'grocery' });
      fireEvent.press(within(rowOf('Paneer')).getByTestId('list-item-check'));
      await flush();
      await advance(5000);
      await flush();
      expect(callsOf('household.item.done')).toHaveLength(1);
      expect(hasRow('Paneer')).toBe(false);
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();

      await advance(5999);
      expect(hasRow('Paneer')).toBe(false);
      await advance(1);
      await flush();
      expect(hasRow('Paneer')).toBe(true);
      expect(screen.getByText('Not saved')).toBeTruthy();
      expect(within(rowOf('Paneer')).queryByTestId('list-item-undo')).toBeNull();
      await advance(120000);
      expect(callsOf('household.item.done')).toHaveLength(1);
    });

    it('stays gone, with no notice, when the check turned out to have committed (late or immediate)', async () => {
      for (const commit of ['now', 3000] as const) {
        server = resetWorld();
        server.override('household.item.done', unknownOutcomeFor('household.item.done', commit, makeError));
        const view = await mount('ListDetail', { listId: 'grocery' });
        fireEvent.press(within(rowOf('Paneer')).getByTestId('list-item-check'));
        await flush();
        await advance(5000);
        await advance(6000);
        await flush();
        expect(hasRow('Paneer')).toBe(false);
        expect(screen.queryByText('Not saved')).toBeNull();
        expect(callsOf('household.item.done')).toHaveLength(1);
        view.unmount();
      }
    });
  });

  describe.each(UNKNOWN)('remove with %s', (_name, makeError) => {
    it('keeps the row hidden while unresolved and brings it back with Not saved when still present', async () => {
      server.override('household.item.remove', unknownOutcomeFor('household.item.remove', 'never', makeError));
      await mount('ListDetail', { listId: 'meals' });
      fireEvent.press(within(rowOf('Pasta night')).getByTestId('list-item-remove'));
      await flush();
      expect(callsOf('household.item.remove')).toHaveLength(1);
      expect(hasRow('Pasta night')).toBe(false);
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();

      await advance(6000);
      await flush();
      expect(hasRow('Pasta night')).toBe(true);
      expect(screen.getByText('Not saved')).toBeTruthy();
      expect(callsOf('household.item.remove')).toHaveLength(1);
    });

    it('stays gone, with no notice, when the remove turned out to have committed', async () => {
      server.override('household.item.remove', unknownOutcomeFor('household.item.remove', 3000, makeError));
      await mount('ListDetail', { listId: 'meals' });
      fireEvent.press(within(rowOf('Pasta night')).getByTestId('list-item-remove'));
      await flush();
      await advance(6000);
      await flush();
      expect(hasRow('Pasta night')).toBe(false);
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(callsOf('household.item.remove')).toHaveLength(1);
    });
  });
});
