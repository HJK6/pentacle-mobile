import React from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TabLayout from '../../../app/(tabs)/_layout';

let mockIdentityState = { sessions: [] as any[] };
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector(mockIdentityState),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
let mockOptions: any;
let mockScreens: any[];
jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock').default;
  return { ...mock, useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) };
});
jest.mock('expo-router', () => {
  const React = require('react');
  return { Tabs: Object.assign(({ children, screenOptions }: any) => {
    mockOptions = screenOptions;
    mockScreens = React.Children.toArray(children).map((child: any) => child.props);
    return null;
  }, { Screen: () => null }) };
});

const Tabs = createBottomTabNavigator();
const Empty = () => <View />;

test('the actual tab bar applies compact icon/label/button geometry within the safe bar', () => {
  jest.useFakeTimers();
  const keyboard = jest.spyOn(Keyboard, 'addListener');
  render(<TabLayout />).unmount();
  const view = render(<SafeAreaProvider><NavigationContainer><Tabs.Navigator initialRouteName="bart" screenOptions={mockOptions}>
    {mockScreens.filter((screen) => screen.options.href !== null).map((screen) =>
      <Tabs.Screen key={screen.name} name={screen.name} options={screen.options} component={Empty} />)}
  </Tabs.Navigator></NavigationContainer></SafeAreaProvider>);
  const button = view.getByTestId('bart-tab-button');
  expect(StyleSheet.flatten(button.props.style)).toMatchObject({ padding: 0, gap: 3 });
  expect(view.getByText('ASSISTANT')).toHaveStyle({ fontSize: 9, lineHeight: 11 });
  expect(view.getByText('PERSONAL')).toBeTruthy();
  expect(view.getByText('DASHBOARDS')).toBeTruthy();
  expect(view.getByText('SETTINGS')).toBeTruthy();
  const show = keyboard.mock.calls.find(([name]) => name === 'keyboardWillShow')![1];
  const hide = keyboard.mock.calls.find(([name]) => name === 'keyboardWillHide')![1];
  act(() => show({} as any));
  const barIsOutOfFlow = () => view.UNSAFE_getAllByType(View).some((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.height === 81 && style?.position === 'absolute' && node.props.pointerEvents === 'none';
  });
  expect(barIsOutOfFlow()).toBe(true);
  act(() => hide({} as any));
  act(() => jest.advanceTimersByTime(300));
  expect(barIsOutOfFlow()).toBe(false);
  keyboard.mockRestore();
});
