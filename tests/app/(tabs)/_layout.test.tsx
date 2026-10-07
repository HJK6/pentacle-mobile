import React from 'react';
import { render } from '@testing-library/react-native';
import TabLayout from '../../../app/(tabs)/_layout';
import MachineSigil from '../../../src/components/MachineSigil';

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
let mockIdentityState = { sessions: [] as any[] };
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(mockIdentityState),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
const mockTabs = jest.fn();
jest.mock('expo-router', () => {
  const mock = require('../../helpers/mocks/expoRouter').makeMock();
  return { ...mock, Tabs: Object.assign((props: any) => {
    mockTabs(props);
    return props.children;
  }, { Screen: mock.Tabs.Screen }) };
});
jest.mock('../../../src/services/mobileTabsTelemetry', () => ({ logTabPressed: jest.fn() }));
jest.mock('../../../src/hooks/useUnreadNotifications', () => ({
  markRead: jest.fn(), useHasUnreadNotification: jest.fn(() => true),
}));

const config = () => require('expo-router').__mock.tabScreens.mock.calls.map((call: any[]) => call[0]);
const visible = () => config().filter((screen: any) => screen.options.href !== null);

beforeEach(() => { mockIdentityState = { sessions: [] }; require('expo-router').__mock.tabScreens.mockClear(); });

test('Bart is the initial tab and the four visible tabs have the contract order and labels', () => {
  render(<TabLayout />);
  expect(mockTabs).toHaveBeenCalledWith(expect.objectContaining({ initialRouteName: 'bart' }));
  expect(visible().map((screen: any) => [screen.name, screen.options.title, screen.options.tabBarLabel])).toEqual([
    ['bart', 'Assistant', 'ASSISTANT'], ['personal', 'Personal', 'PERSONAL'],
    ['dashboards', 'Dashboards', 'DASHBOARDS'], ['settings', 'Settings', 'SETTINGS'],
  ]);
});

test('old surfaces stay registered as hidden route destinations', () => {
  render(<TabLayout />);
  expect(config().filter((screen: any) => screen.options.href === null).map((screen: any) => screen.name).sort())
    .toEqual(['chats', 'unified', 'updates']);
});

test('tab icons reuse the lamp and render outlined person, four tiles, and settings glyph', () => {
  render(<TabLayout />);
  const [bart, personal, dashboards, settings] = visible();
  const lamp = render(bart.options.tabBarIcon({ color: '#3dff66' }));
  expect(lamp.UNSAFE_getByType(MachineSigil).props).toMatchObject({ kind: 'djinni', size: 22, color: '#3dff66' });
  expect(lamp.queryByTestId('updates-unread-dot')).toBeNull();
  expect(render(personal.options.tabBarIcon({ color: '#7fa896' })).getByTestId('bart-tab-person')).toBeTruthy();
  expect(render(dashboards.options.tabBarIcon({ color: '#7fa896' })).getByTestId('bart-tab-grid')).toBeTruthy();
  expect(render(settings.options.tabBarIcon({ color: '#7fa896' })).getByText('⊹')).toBeTruthy();
});

test('every visible tab logs its route name without marking notifications read', () => {
  render(<TabLayout />);
  visible().forEach((screen: any) => screen.listeners.tabPress());
  expect(require('../../../src/services/mobileTabsTelemetry').logTabPressed.mock.calls)
    .toEqual([['bart'], ['personal'], ['dashboards'], ['settings']]);
  expect(require('../../../src/hooks/useUnreadNotifications').markRead).not.toHaveBeenCalled();
});

test('a renamed assistant updates the home title and uppercase label without changing tab tint', () => {
  const view = render(<TabLayout />);
  expect(visible()[0].options.title).toBe('Assistant');
  mockIdentityState = { sessions: [{ stream_id: 'bart:assistant', display_name: 'Lews', title: 'Older name', host: 'hostc' }] };
  require('expo-router').__mock.tabScreens.mockClear();
  view.rerender(<TabLayout />);
  const home = visible()[0];
  expect(home.options).toMatchObject({ title: 'Lews', tabBarLabel: 'LEWS' });
  expect(render(home.options.tabBarIcon({ color: '#7fa896' })).UNSAFE_getByType(MachineSigil).props)
    .toMatchObject({ kind: 'djinni', color: '#7fa896', size: 22 });
});
