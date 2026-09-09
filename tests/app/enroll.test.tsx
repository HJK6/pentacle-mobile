import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import EnrollScreen from '../../app/enroll';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import { enrollPentacleDevice, enrollPentacleDeviceLegacy } from '../../src/services/pentacleStream';

const mockParams: Record<string, unknown> = {};
jest.mock('expo-router', () => {
  const mock = require('../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../src/services/pentacleStream', () => ({
  enrollPentacleDevice: jest.fn(),
  enrollPentacleDeviceLegacy: jest.fn(),
}));

const routerMock = require('expo-router').__mock;
const tokenApi = {
  isReady: true,
  setToken: jest.fn(),
  setWsUrl: jest.fn(),
};

beforeEach(() => {
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
  tokenApi.isReady = true;
  tokenApi.setToken.mockResolvedValue(undefined);
  tokenApi.setWsUrl.mockResolvedValue(undefined);
  (usePentacleToken as jest.Mock).mockReturnValue(tokenApi);
  (enrollPentacleDevice as jest.Mock).mockResolvedValue({ token: 'token-123' });
  (enrollPentacleDeviceLegacy as jest.Mock).mockResolvedValue({ token: 'legacy-token' });
});

test('renders missing-code error without enrolling', async () => {
  render(<EnrollScreen />);

  expect(await screen.findByText('Enrollment link is missing a code.')).toBeTruthy();
  expect(enrollPentacleDevice).not.toHaveBeenCalled();
});

test('does not call enrollment service while token store is not ready', async () => {
  mockParams.code = 'abc';
  tokenApi.isReady = false;

  render(<EnrollScreen />);

  await Promise.resolve();
  expect(enrollPentacleDevice).not.toHaveBeenCalled();
});

test('valid code and ws enrolls, stores token, and routes to chats', async () => {
  mockParams.code = 'abc';
  mockParams.ws = 'ws://control.example/ws';

  render(<EnrollScreen />);

  await waitFor(() => expect(tokenApi.setWsUrl).toHaveBeenCalledWith('ws://control.example/ws'));
  expect(enrollPentacleDevice).toHaveBeenCalledWith('ABC', 'ws://control.example/ws');
  await waitFor(() => expect(tokenApi.setToken).toHaveBeenCalledWith('token-123'));
  expect(routerMock.replace).toHaveBeenCalledWith('/chats');
});

test('renders enrollment service errors', async () => {
  mockParams.code = 'abc';
  (enrollPentacleDevice as jest.Mock).mockRejectedValue(new Error('bad code'));

  render(<EnrollScreen />);

  expect(await screen.findByText('bad code')).toBeTruthy();
  expect(tokenApi.setToken).not.toHaveBeenCalled();
});

test('protocol=1 is the only route to explicit legacy enrollment', async () => {
  mockParams.code = 'abc';
  mockParams.protocol = '1';

  render(<EnrollScreen />);

  await waitFor(() => expect(enrollPentacleDeviceLegacy).toHaveBeenCalledWith('ABC', undefined));
  expect(enrollPentacleDevice).not.toHaveBeenCalled();
  expect(tokenApi.setToken).toHaveBeenCalledWith('legacy-token');
});

test('unknown protocol values remain on fail-closed v2 enrollment', async () => {
  mockParams.code = 'abc';
  mockParams.protocol = 'legacy';

  render(<EnrollScreen />);

  await waitFor(() => expect(enrollPentacleDevice).toHaveBeenCalledWith('ABC', undefined));
  expect(enrollPentacleDeviceLegacy).not.toHaveBeenCalled();
});

test('unmount mid-flight does not store token or route', async () => {
  mockParams.code = 'abc';
  let resolveEnroll: (value: { token: string }) => void = () => undefined;
  (enrollPentacleDevice as jest.Mock).mockReturnValue(new Promise((resolve) => {
    resolveEnroll = resolve;
  }));

  const rendered = render(<EnrollScreen />);
  rendered.unmount();
  resolveEnroll({ token: 'late-token' });

  await Promise.resolve();
  expect(tokenApi.setToken).not.toHaveBeenCalled();
  expect(routerMock.replace).not.toHaveBeenCalled();
});
