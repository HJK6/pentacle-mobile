import './mocks';
import { registerOutboundGuard } from './support';
import { mount, resetWorld, screen, type PersonalComponent } from './screens';

// The lamp is the assistant's machine sigil (contracts § Assistant identity), not a fixed kind.
jest.mock('../../src/services/assistantIdentity', () => ({
  ...jest.requireActual('../../src/services/assistantIdentity'),
  useAssistantIdentity: () => ({ streamId: 'bart:assistant', name: 'Nova', hostId: 'host-a', sigilKind: 'owl' }),
}));

registerOutboundGuard();

beforeEach(() => {
  resetWorld();
});

const SCREENS: Array<[PersonalComponent, Record<string, unknown>]> = [
  ['PersonalHome', {}],
  ['ListDetail', { listId: 'tasks' }],
  ['CalendarView', {}],
];

describe('Personal lamps follow the assistant identity sigil', () => {
  it.each(SCREENS)('%s draws every lamp with the identity sigilKind', async (name, props) => {
    await mount(name, props);
    expect(screen.queryAllByTestId('sigil-owl').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId('sigil-djinni')).toHaveLength(0);
  });
});
