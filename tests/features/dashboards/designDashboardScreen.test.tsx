import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DashboardScreen from '../../../app/pentacle/dashboard/[dashboardId]';

let mockParams: Record<string, string> = {};
let mockPolicy: unknown;
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, replace: mockReplace, canGoBack: mockCanGoBack }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../src/services/pentacleStream', () => ({
  getHostedDashboardPolicy: () => mockPolicy,
}));
jest.mock('react-native-webview', () => ({
  WebView: require('react-native').View,
}));
const origin = 'https://chat.example.ts.net';
const path = '/next/embed/design';
const webView = () => screen.getByTestId('design-webview');

beforeEach(() => {
  jest.clearAllMocks();
  mockCanGoBack.mockReturnValue(true);
  mockParams = { dashboardId: 'design' };
  mockPolicy = { pentacleOrigin: origin, tailnetSuffix: 'example.ts.net' };
});

test('mounts Design in the app and keeps refused navigation out of the browser', () => {
  const openURL = jest.spyOn(Linking, 'openURL');
  try {
    render(<DashboardScreen />);
    expect(screen.queryByRole('header', { name: 'Design' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
    expect(webView().props.source).toEqual({ uri: origin + path });
    expect(webView().props).toMatchObject({
      originWhitelist: ['*'],
      sharedCookiesEnabled: false,
      javaScriptCanOpenWindowsAutomatically: false,
    });
    expect(webView().props.onMessage).toBeUndefined();
    fireEvent(webView(), 'openWindow', { nativeEvent: { targetUrl: 'https://example.test' } });
    const navigate = webView().props.onShouldStartLoadWithRequest;
    act(() => {
      expect(navigate({ url: 'mailto:team@example.test' })).toBe(false);
    });
    expect(openURL).not.toHaveBeenCalled();
  } finally {
    openURL.mockRestore();
  }
});

test('opens an exact target and Back pops the native route', () => {
  mockParams = { dashboardId: 'design', projectId: 'p', designId: 'board', viewId: 'screen' };
  render(<DashboardScreen />);
  expect(webView().props.source).toEqual({ uri: `${origin}${path}/p/board/screen` });
  fireEvent.press(screen.getByRole('button', { name: 'Back' }));
  expect(mockBack).toHaveBeenCalledTimes(1);
  expect(mockReplace).not.toHaveBeenCalled();
});

test('a deep route with no back stack returns to Dashboards', () => {
  mockCanGoBack.mockReturnValue(false);
  render(<DashboardScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Back' }));
  expect(mockReplace).toHaveBeenCalledWith('/dashboards');
});

test('token sign-in redirects fail closed and Retry reads the current live policy', () => {
  mockParams = { dashboardId: 'design', projectId: 'p', designId: 'board' };
  render(<DashboardScreen />);
  const navigate = webView().props.onShouldStartLoadWithRequest;
  act(() => {
    expect(navigate({ url: origin + '/login', isTopFrame: true, navigationType: 'other' })).toBe(false);
  });
  expect(screen.getByText('Design did not load')).toBeVisible();
  expect(screen.queryByTestId('design-webview')).toBeNull();
  mockPolicy = { pentacleOrigin: 'https://new.example.ts.net', tailnetSuffix: 'example.ts.net' };
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(webView().props.source).toEqual({ uri: `https://new.example.ts.net${path}/p/board` });
});

test('shows the failure state for a main-frame HTTP denial and permits retry', () => {
  render(<DashboardScreen />);
  fireEvent(webView(), 'httpError', { nativeEvent: { url: origin + path, statusCode: 401 } });
  expect(screen.getByText('Design did not load')).toBeVisible();
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(webView().props.source).toEqual({ uri: origin + path });
});

test('waits for a valid policy when opened offline and never loads malformed route input', () => {
  mockPolicy = null;
  const route = render(<DashboardScreen />);
  expect(screen.getByText('Design did not load')).toBeVisible();
  expect(screen.queryByTestId('design-webview')).toBeNull();
  mockPolicy = { pentacleOrigin: origin, tailnetSuffix: 'example.ts.net' };
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(webView().props.source).toEqual({ uri: origin + path });
  mockParams = { dashboardId: 'design', projectId: '..', designId: 'board' };
  route.rerender(<DashboardScreen />);
  expect(screen.getByText('Design did not load')).toBeVisible();
  expect(screen.queryByTestId('design-webview')).toBeNull();
});

test('a stale load failure cannot replace the newly mounted retry', () => {
  render(<DashboardScreen />);
  const failOldLoad = webView().props.onError;
  act(failOldLoad);
  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  act(failOldLoad);
  expect(webView().props.source).toEqual({ uri: origin + path });
});

test('unrelated route parameters cannot supply a URL', () => {
  mockParams.url = 'https://elsewhere.example.test';
  render(<DashboardScreen />);
  expect(webView().props.source).toEqual({ uri: origin + path });
});

test('unsupported dashboard IDs do not mount a WebView', () => {
  mockParams.dashboardId = 'unknown';
  render(<DashboardScreen />);
  expect(screen.getByText('Dashboard unavailable')).toBeVisible();
  expect(screen.queryByTestId('design-webview')).toBeNull();
});
