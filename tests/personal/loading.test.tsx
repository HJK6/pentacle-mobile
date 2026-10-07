import './mocks';
import { act } from '@testing-library/react-native';
import { FakeHousehold, flush } from './support';
import { mount, resetWorld, screen, type PersonalComponent } from './screens';

let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const SCREENS: Array<[PersonalComponent, Record<string, unknown>]> = [
  ['PersonalHome', {}],
  ['ListsIndex', {}],
  ['ListDetail', { listId: 'tasks' }],
  ['CalendarView', {}],
];

describe('first load shows the existing spinner atom (Target State 6)', () => {
  it.each(SCREENS)('%s: spinner while the first snapshot is pending, gone once it lands', async (name, props) => {
    let release: () => void = () => undefined;
    server.override('household.snapshot', (fields, fake) =>
      new Promise((resolve) => {
        release = () => resolve(fake.apply('household.snapshot', fields));
      }),
    );
    await mount(name, props, false);
    expect(screen.getByTestId('household-loading')).toBeTruthy();
    expect(screen.queryByText('Household store unavailable')).toBeNull();

    await act(async () => release());
    await flush();
    expect(screen.queryByTestId('household-loading')).toBeNull();
  });

  it.each(SCREENS)('%s: no spinner once the first snapshot has failed', async (name, props) => {
    server.override('household.snapshot', () => Promise.reject(new Error('down')));
    await mount(name, props, false);
    expect(screen.queryByTestId('household-loading')).toBeNull();
  });
});
