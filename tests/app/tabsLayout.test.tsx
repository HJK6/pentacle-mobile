import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { Fonts, Tokens } from '../../constants/Colors';

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
let mockIdentityState = { sessions: [] as any[] };
jest.mock('../../src/services/pentacleStream', () => ({
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(mockIdentityState),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
const mockTabs = jest.fn();
jest.mock('expo-router', () => {
  const mock = require('../helpers/mocks/expoRouter').makeMock();
  return { ...mock, Tabs: Object.assign((props: any) => {
    mockTabs(props);
    return props.children;
  }, { Screen: mock.Tabs.Screen }) };
});

test('tab bar uses the approved typography, colors, and insets', () => {
  const TabLayout = require('../../app/(tabs)/_layout').default;
  render(<TabLayout />);
  const options = mockTabs.mock.calls[0][0].screenOptions;
  expect(options.tabBarHideOnKeyboard).toBe(true);
  expect(options.tabBarActiveTintColor).toBe('#3dff66');
  expect(options.tabBarInactiveTintColor).toBe('#7fa896');
  expect(StyleSheet.flatten(options.tabBarLabelStyle)).toMatchObject({
    fontFamily: Fonts.jetBrainsMono.medium, fontSize: 9, letterSpacing: 0.5,
  });
  expect(StyleSheet.flatten(options.tabBarStyle)).toMatchObject({
    paddingTop: 9, paddingBottom: 22, paddingHorizontal: 0,
    backgroundColor: Tokens.palette.ink, borderTopColor: Tokens.palette.line, borderTopWidth: 1,
  });
});


test('larger bottom and landscape side insets remain safe', () => {
  mockTabs.mockClear();
  mockInsets = { top: 0, bottom: 34, left: 44, right: 44 };
  const TabLayout = require('../../app/(tabs)/_layout').default;
  render(<TabLayout />);
  expect(StyleSheet.flatten(mockTabs.mock.calls[0][0].screenOptions.tabBarStyle)).toMatchObject({
    height: 81, paddingBottom: 34, paddingLeft: 44, paddingRight: 44,
  });
});
