import React from 'react';
import { render } from '@testing-library/react-native';
import IndexScreen from '../../app';

jest.mock('expo-router', () => require('../helpers/mocks/expoRouter').makeMock());

const routerMock = require('expo-router').__mock;

test('redirects cold renders to the assistant home tab', () => {
  render(<IndexScreen />);

  expect(routerMock.redirect).toHaveBeenCalledWith('/(tabs)/bart');
});

