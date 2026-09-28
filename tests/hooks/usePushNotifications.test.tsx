import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import usePushNotifications from '../../src/hooks/usePushNotifications';
import { consentConnection, sendConsentCommand, usePentacleStreamActions, usePentacleStreamSelector } from '../../src/services/pentacleStream';

let mockResponseListener: ((response: any) => void) | undefined;
let mockNotificationHandler: any;
let mockPushTokenListener: ((token: any) => void) | undefined;
const mockPushTokenRemove = jest.fn();
const mockResponseRemove = jest.fn();
const mockPlatform = { OS: 'ios' };
const mockRegisterPushToken = jest.fn().mockResolvedValue(true);
const mockPrefetchStreamEvents = jest.fn();

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Platform') return mockPlatform;
      return target[prop as keyof typeof target];
    },
  });
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { extra: { eas: { projectId: 'project-123' } } },
  },
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn((handler) => {
    mockNotificationHandler = handler;
  }),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addPushTokenListener: jest.fn((listener) => {
    mockPushTokenListener = listener;
    return { remove: () => { mockPushTokenListener = undefined; mockPushTokenRemove(); } };
  }),
  addNotificationResponseReceivedListener: jest.fn((listener) => {
    mockResponseListener = listener;
    return { remove: mockResponseRemove };
  }),
  getLastNotificationResponseAsync: jest.fn(),
  clearLastNotificationResponseAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-router', () => require('../helpers/mocks/expoRouter').makeMock());

jest.mock('../../src/services/pentacleStream', () => ({
  consentConnection: jest.fn(()=>null),
  sendConsentCommand: jest.fn().mockResolvedValue({}),
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelector: jest.fn(),
}));

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
  mockPlatform.OS = 'ios';
  require('expo-constants').default.expoConfig.extra.eas.projectId = 'project-123';
  require('expo-constants').default.expoConfig.extra.pushEnvironment = 'development';
  (consentConnection as jest.Mock).mockReturnValue(null);
  (sendConsentCommand as jest.Mock).mockResolvedValue({push_status:'registered'});
  mockResponseListener = undefined;
  mockPushTokenListener = undefined;
  mockPushTokenRemove.mockClear();
  mockRegisterPushToken.mockResolvedValue(true);
  mockPrefetchStreamEvents.mockClear();
  (usePentacleStreamActions as jest.Mock).mockReturnValue({
    registerPushToken: mockRegisterPushToken,
    prefetchStreamEvents: mockPrefetchStreamEvents,
  });
  (usePentacleStreamSelector as jest.Mock).mockImplementation((selector: (state: any) => unknown) => selector({ connected: true }));
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[one]' });
  (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
});

test('registers a granted push token with the stream server', async () => {
  const { result } = renderHook(() => usePushNotifications());

  await waitFor(() => expect(result.current.expoPushToken).toBe('ExponentPushToken[one]'));
  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith({
    pushToken: 'ExponentPushToken[one]',
    platform: 'ios',
    deviceName: 'Pentacle ios',
  }));
});

test('does not register or throw when permission is denied', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });

  const { result } = renderHook(() => usePushNotifications());

  await waitFor(() => expect(Notifications.getPermissionsAsync).toHaveBeenCalled());
  expect(result.current.error).toBeNull();
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
});

test('requests permission when status is undetermined', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'undetermined' });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });

  renderHook(() => usePushNotifications());

  await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalled());
  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ExponentPushToken[one]' })));
});

test('surfaces registration setup and server errors without throwing', async () => {
  const constants = require('expo-constants').default;
  constants.expoConfig.extra.eas.projectId = '';
  const first = renderHook(() => usePushNotifications());

  await waitFor(() => expect(first.result.current.error).toBe('Missing EAS project id'));
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  first.unmount();

  constants.expoConfig.extra.eas.projectId = 'project-123';
  mockRegisterPushToken.mockRejectedValueOnce(new Error('server refused token'));
  const second = renderHook(() => usePushNotifications());

  await waitFor(() => expect(second.result.current.error).toBe('server refused token'));
});

test('re-registers when the push token rotates across mounts', async () => {
  const first = renderHook(() => usePushNotifications());
  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ExponentPushToken[one]' })));
  first.unmount();

  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[two]' });
  renderHook(() => usePushNotifications());

  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'ExponentPushToken[two]' })));
});

test('routes notification taps by payload branch', async () => {
  renderHook(() => usePushNotifications());
  await waitFor(() => expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalled());

  mockResponseListener?.({
    notification: {
      request: {
        content: {
          data: {
            producer: 'agent_question.v1',
            notification_id: 'question-route',
            question: { producer_stream_id: 'hostb:claude:asker' },
            agent_id: 'system',
          },
        },
      },
    },
  });
  mockResponseListener?.({ notification: { request: { content: { data: { stream_id: 'alpha/session 1' } } } } });
  mockResponseListener?.({ notification: { request: { content: { data: { agent_id: 'system' } } } } });
  mockResponseListener?.({ notification: { request: { content: { data: { agent_id: 'hostc' } } } } });
  mockResponseListener?.({ notification: { request: { content: { data: { agent_id: 'hostc' } } } } });

  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostb%3Aclaude%3Aasker');
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/alpha%2Fsession%201');
  expect(router.push).toHaveBeenCalledWith('/(tabs)/chats');
  expect(router.push).toHaveBeenCalledWith('/updates');
  expect(mockPrefetchStreamEvents).toHaveBeenCalledWith('hostb:claude:asker', 'notification');
  expect(mockPrefetchStreamEvents).toHaveBeenCalledWith('alpha/session 1', 'notification');
});

test('defers a locked stream notification route until unlock while prefetching once at tap time', async () => {
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));
  const { rerender } = renderHook((props: { locked: boolean }) => usePushNotifications({ locked: props.locked }), {
    initialProps: { locked: true },
  });
  await waitFor(() => expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalled());

  mockResponseListener?.({ notification: { request: { content: { data: { stream_id: 'locked-stream' } } } } });
  mockResponseListener?.({ notification: { request: { content: { data: { stream_id: 'locked-stream' } } } } });

  expect(mockPrefetchStreamEvents).toHaveBeenCalledTimes(1);
  expect(mockPrefetchStreamEvents).toHaveBeenCalledWith('locked-stream', 'notification');
  expect(router.push).not.toHaveBeenCalled();

  rerender({ locked: false });

  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/pentacle/session/locked-stream'));
  expect(router.push).toHaveBeenNthCalledWith(1, '/(tabs)/chats');
  expect(router.push).toHaveBeenNthCalledWith(2, '/pentacle/session/locked-stream');
  expect(seen.filter((payload) => payload.message === TELEMETRY_EVENTS.PUSH_TAP_ROUTED)).toHaveLength(1);
  telemetry.setTelemetrySink(null);
});

test('foreground notification handler suppresses repeated notification_ids', async () => {
  const first = await mockNotificationHandler.handleNotification({
    request: { content: { data: { notification_id: 'foreground-dup' } } },
  });
  const second = await mockNotificationHandler.handleNotification({
    request: { content: { data: { notification_id: 'foreground-dup' } } },
  });
  const withoutId = await mockNotificationHandler.handleNotification({
    request: { content: { data: {} } },
  });

  expect(first.shouldShowAlert).toBe(true);
  expect(first.shouldShowBanner).toBe(true);
  expect(second.shouldShowAlert).toBe(false);
  expect(second.shouldShowBanner).toBe(false);
  expect(withoutId.shouldShowAlert).toBe(true);
});

test('routes the last stream notification response after the startup delay and removes listeners', async () => {
  jest.useFakeTimers();
  (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue({
    notification: { request: { content: { data: { stream_id: 'beta' } } } },
  });

  const { unmount } = renderHook(() => usePushNotifications());
  await waitFor(() => expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalled());

  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(500);
  });

  expect(router.push).toHaveBeenCalledWith('/pentacle/session/beta');
  expect(router.push).toHaveBeenCalledWith('/(tabs)/chats');
  expect(mockPrefetchStreamEvents).toHaveBeenCalledWith('beta', 'notification');
  unmount();
  expect(mockResponseRemove).toHaveBeenCalled();
});

test('routes the last system notification response after the startup delay', async () => {
  jest.useFakeTimers();
  (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue({
    notification: { request: { content: { data: { agent_id: 'system' } } } },
  });

  renderHook(() => usePushNotifications());
  await waitFor(() => expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalled());

  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(500);
  });

  expect(router.push).toHaveBeenCalledWith('/updates');
});

test('skips native push registration on web', async () => {
  mockPlatform.OS = 'web';

  renderHook(() => usePushNotifications());

  await Promise.resolve();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
});

test('skips every native notification registration path in harness builds', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';

  renderHook(() => usePushNotifications());

  await Promise.resolve();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  expect(Notifications.getLastNotificationResponseAsync).not.toHaveBeenCalled();
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
});

test('consent registration binds the current scope and repeats for a new credential',async()=>{
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  const hook=renderHook(()=>usePushNotifications());
  await waitFor(()=>expect(sendConsentCommand).toHaveBeenCalledWith('consent.push_register',{push_token:'ExponentPushToken[one]',platform:'ios',project_id:'project-123',environment:'development'}));
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  (sendConsentCommand as jest.Mock).mockClear();
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|b',host_id:'host',credential_id:'b',generation:2});
  hook.rerender(undefined);
  await waitFor(()=>expect(sendConsentCommand).toHaveBeenCalledTimes(1));
  expect((sendConsentCommand as jest.Mock).mock.calls[0][1]).not.toHaveProperty('credential_id');
});

test('denied permission removes only the freshly authenticated consent binding',async()=>{
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({status:'denied'});
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({status:'denied'});
  renderHook(()=>usePushNotifications());
  await waitFor(()=>expect(sendConsentCommand).toHaveBeenCalledWith('consent.push_register',{permission:'denied'}));
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
});

test('consent OS tap waits for unlock and routes to the exact request without opening or signing',async()=>{
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  const hook=renderHook((props:{locked:boolean})=>usePushNotifications(props),{initialProps:{locked:true}});
  await waitFor(()=>expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalled());
  act(()=>mockResponseListener?.({notification:{request:{content:{data:{kind:'approval',host_id:'host',request_id:'exact-request'}}}}}));
  expect(router.push).not.toHaveBeenCalled();
  hook.rerender({locked:false});
  await waitFor(()=>expect(router.push).toHaveBeenCalledWith(expect.objectContaining({pathname:'/approval',params:expect.objectContaining({kind:'approval',host_id:'host',request_id:'exact-request',gesture:expect.any(String)})})));
  expect((sendConsentCommand as jest.Mock).mock.calls.every(call=>call[0]==='consent.push_register')).toBe(true);
  expect(mockPrefetchStreamEvents).not.toHaveBeenCalled();
});

test('cold consent tap waits for a matching authenticated reconnect and refuses a foreign host hint',async()=>{
  (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue({notification:{request:{content:{data:{kind:'enrollment',host_id:'host',request_id:'cold-offer'}}}}});
  const hook=renderHook(()=>usePushNotifications());
  await waitFor(()=>expect(Notifications.getLastNotificationResponseAsync).toHaveBeenCalled());
  expect(router.push).not.toHaveBeenCalled();
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  hook.rerender(undefined);
  await waitFor(()=>expect(router.push).toHaveBeenCalledWith(expect.objectContaining({pathname:'/approval',params:expect.objectContaining({request_id:'cold-offer'})})));
  (router.push as jest.Mock).mockClear();
  act(()=>mockResponseListener?.({notification:{request:{content:{data:{kind:'approval',host_id:'foreign',request_id:'other-request'}}}}}));
  expect(router.push).not.toHaveBeenCalled();
  expect(mockPrefetchStreamEvents).not.toHaveBeenCalled();
});

test('consuming a cold consent tap clears the native cached response before later normal launches',async()=>{
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue({notification:{request:{identifier:'last-tap',content:{data:{kind:'approval',host_id:'host',request_id:'old-tap'}}}}});
  renderHook(()=>usePushNotifications());
  await waitFor(()=>expect(router.push).toHaveBeenCalled());
  expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalled();
});


test('native token listener converts the supplied token without any native re-request', async () => {
  const mockNativeRequest = jest.fn(async () => ({ type: 'ios', data: 'synthetic-native' }));
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockImplementation(async (options) => {
    // Expo requests native registration only when no devicePushToken is supplied.
    const token = options.devicePushToken ?? await mockNativeRequest();
    return { data: `ExponentPushToken[${token.data}]` };
  });
  const hook = renderHook(() => usePushNotifications());
  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith(expect.objectContaining({
    pushToken: 'ExponentPushToken[synthetic-native]',
  })));
  expect(mockNativeRequest).toHaveBeenCalledTimes(1);
  mockNativeRequest.mockClear();
  const rotated = { type: 'ios', data: 'synthetic-rotated' };
  await act(async () => { mockPushTokenListener?.(rotated); });
  expect(mockNativeRequest).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenLastCalledWith({
    projectId: 'project-123', devicePushToken: rotated,
  });
  await waitFor(() => expect(mockRegisterPushToken).toHaveBeenCalledWith(expect.objectContaining({
    pushToken: 'ExponentPushToken[synthetic-rotated]',
  })));
  await act(async () => { mockPushTokenListener?.(rotated); mockPushTokenListener?.(rotated); });
  expect(mockNativeRequest).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(4);
  hook.unmount();
  expect(mockPushTokenRemove).toHaveBeenCalledTimes(1);
  expect(mockPushTokenListener).toBeUndefined();
});

test('listener token rotation retains fresh consent scope binding across credential changes', async () => {
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|a',host_id:'host',credential_id:'a',generation:1});
  const hook = renderHook(() => usePushNotifications());
  await waitFor(() => expect(sendConsentCommand).toHaveBeenCalledWith('consent.push_register', expect.objectContaining({
    push_token: 'ExponentPushToken[one]',
  })));
  (sendConsentCommand as jest.Mock).mockClear();
  const rotated = {type:'ios',data:'synthetic-consent-rotation'};
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockImplementation(async options => {
    if (options.devicePushToken !== rotated) throw new Error('Listener requested native registration again');
    return {data:'ExponentPushToken[rotated]'};
  });
  await act(async () => { mockPushTokenListener?.(rotated); });
  await waitFor(() => expect(sendConsentCommand).toHaveBeenCalledWith('consent.push_register', {
    push_token:'ExponentPushToken[rotated]',platform:'ios',project_id:'project-123',environment:'development',
  }));
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  (sendConsentCommand as jest.Mock).mockClear();
  (consentConnection as jest.Mock).mockReturnValue({scope:'host|b',host_id:'host',credential_id:'b',generation:2});
  hook.rerender(undefined);
  await waitFor(() => expect(sendConsentCommand).toHaveBeenCalledTimes(1));
  expect((sendConsentCommand as jest.Mock).mock.calls[0]).toEqual(['consent.push_register', {
    push_token:'ExponentPushToken[rotated]',platform:'ios',project_id:'project-123',environment:'development',
  }]);
  expect(hook.result.current.error).toBeNull();
});
