import { GREEN, MUTED, colorOf, flush, registerOutboundGuard, rpcError, sameColor, textOf } from './support';
import { fireEvent, mount, navTargets, backCalls, resetWorld, screen, within } from './screens';
import type { FakeHousehold } from './support';

registerOutboundGuard();

let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const rows = () => screen.queryAllByTestId('lists-row');

describe('ListsIndex', () => {
  it('shows one row per list in the order To-do, Grocery, Meals, Chores, Study plan', async () => {
    await mount('ListsIndex');
    expect(rows()).toHaveLength(5);
    ['To-do', 'Grocery', 'Meals', 'Chores', 'Study plan'].forEach((name, i) => {
      expect(within(rows()[i]).getByText(name)).toBeTruthy();
    });
  });

  it('previews the first three open labels joined by " · " and shows Empty for an empty list', async () => {
    await mount('ListsIndex');
    const [tasks, grocery, meals, chores, study] = rows();
    expect(within(grocery).getByText('Oat milk · Paneer · Coffee beans')).toBeTruthy();
    expect(within(meals).getByText('Dal + rice · Sheet-pan chicken · Pasta night')).toBeTruthy();
    expect(within(chores).getByText('Change HVAC filter · Take out recycling')).toBeTruthy();
    expect(within(study).getByText('Empty')).toBeTruthy();
    // To-do has six items: the preview joins exactly three of them and never reaches the lowest-ranked ones.
    const preview = textOf(tasks);
    expect(preview.split(' · ')).toHaveLength(3);
    expect(preview).not.toContain('Sweep the garage');
    expect(preview).not.toContain('Pay invoice');
  });

  it('shows the open count, green when above zero and muted at zero', async () => {
    await mount('ListsIndex');
    const expected: Array<[number, string, string]> = [
      [0, '6', GREEN],
      [1, '4', GREEN],
      [2, '3', GREEN],
      [3, '2', GREEN],
      [4, '0', MUTED],
    ];
    for (const [i, count, color] of expected) {
      const el = within(rows()[i]).getByText(count);
      expect(sameColor(colorOf(el), color)).toBe(true);
    }
  });

  it('opens the list detail when a row is tapped', async () => {
    await mount('ListsIndex');
    fireEvent.press(rows()[1]);
    await flush();
    const target = navTargets().join(' ');
    expect(target).toContain('personal/list');
    expect(target).toContain('grocery');
  });

  it('has a Lists title and a back chevron, and no New list control (deviation D1)', async () => {
    await mount('ListsIndex');
    expect(screen.getByText('Lists')).toBeTruthy();
    expect(screen.queryByText(/new list/i)).toBeNull();
    expect(screen.queryByLabelText(/new list/i)).toBeNull();
    fireEvent.press(screen.getByText('‹'));
    await flush();
    expect(backCalls() + navTargets().length).toBeGreaterThan(0);
  });

  it('shows the unavailable line when the snapshot fails', async () => {
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await mount('ListsIndex', {}, false);
    expect(screen.getByText('Household store unavailable')).toBeTruthy();
  });
});
