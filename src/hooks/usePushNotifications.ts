import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  usePentacleStreamActions,
  usePentacleStreamSelector,
} from '../services/pentacleStream';
import { logTelemetry } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import { getNativeNotifications } from '../services/nativeNotifications';

const Notifications = getNativeNotifications();

const seenForegroundNotificationIds = new Set<string>();

function stringField(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function notificationIdFromData(data: Record<string, unknown>) {
  return stringField(data.notification_id);
}

function shouldPresentForegroundNotification(data: Record<string, unknown>) {
  const notificationId = notificationIdFromData(data);
  if (!notificationId) return true;
  if (seenForegroundNotificationIds.has(notificationId)) return false;
  seenForegroundNotificationIds.add(notificationId);
  return true;
}

Notifications?.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as Record<string, unknown>;
    const shouldPresent = shouldPresentForegroundNotification(data);
    return {
      shouldShowAlert: shouldPresent,
      shouldPlaySound: shouldPresent,
      shouldSetBadge: shouldPresent,
      shouldShowBanner: shouldPresent,
      shouldShowList: shouldPresent,
    };
  },
});

type PushState = {
  expoPushToken: string | null;
  error: string | null;
};

type PushNotificationOptions = {
  locked?: boolean;
};

type PendingNotificationRoute = {
  route: string;
  data: Record<string, unknown>;
  source: string;
};

let lastNotificationRoute = '';
let lastNotificationRouteAt = 0;

function notificationCategory(data: Record<string, unknown>) {
  if (data?.agent_id === 'system') return 'system';
  if (data?.stream_id) return 'stream';
  if (data?.agent_id) return 'agent';
  return 'unknown';
}

function logNotificationReceived(data: Record<string, unknown>, source: string) {
  const category = notificationCategory(data);
  logTelemetry(TELEMETRY_EVENTS.PUSH_NOTIFICATION_RECEIVED, {
    category,
    hasDeeplink: Boolean(data?.stream_id || data?.agent_id),
    source,
    stream_id_present: Boolean(data?.stream_id),
    agent_id: typeof data?.agent_id === 'string' ? data.agent_id : undefined,
  });
}

function questionPayloadStreamId(data: Record<string, unknown>) {
  const question = data.question;
  if (question && typeof question === 'object') {
    const nested = question as Record<string, unknown>;
    return stringField(nested.producer_stream_id) || stringField(nested.answer_to_stream_id);
  }
  return '';
}

function notificationStreamId(data: Record<string, unknown>) {
  return (
    stringField(data.stream_id) ||
    questionPayloadStreamId(data) ||
    stringField(data.producer_stream_id) ||
    stringField(data.answer_to_stream_id) ||
    stringField(data.asking_stream_id)
  );
}

function claimNotificationRoute(route: string) {
  const now = Date.now();
  if (route === lastNotificationRoute && now - lastNotificationRouteAt < 1500) return false;
  lastNotificationRoute = route;
  lastNotificationRouteAt = now;
  return true;
}

function pushNotificationRoute(route: string, data: Record<string, unknown>, source: string) {
  logTelemetry(TELEMETRY_EVENTS.PUSH_TAP_ROUTED, {
    destination: route,
    category: notificationCategory(data),
    source,
  });
  if (route.startsWith('/pentacle/session/')) {
    router.push('/(tabs)/chats' as any);
  }
  router.push(route as any);
}

function routeNotificationTap(
  data: Record<string, unknown>,
  source: string,
  actions: ReturnType<typeof usePentacleStreamActions>,
  scheduleRoute: (pending: PendingNotificationRoute) => void,
  delayMs = 0,
) {
  const streamId = notificationStreamId(data);
  const route = streamId
    ? `/pentacle/session/${encodeURIComponent(streamId)}`
    : data?.agent_id === 'system' || data?.agent_id
      ? '/updates'
      : '';
  if (!route) return;
  if (!claimNotificationRoute(route)) return;
  if (streamId) {
    actions.prefetchStreamEvents(streamId, 'notification');
  }
  const pending = { route, data, source };
  if (delayMs > 0) {
    setTimeout(() => scheduleRoute(pending), delayMs);
    return;
  }
  scheduleRoute(pending);
}

export default function usePushNotifications(options: PushNotificationOptions = {}): PushState {
  const actions = usePentacleStreamActions();
  const connected = usePentacleStreamSelector((state) => state.connected, Object.is);
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registeredTokenRef = useRef<string | null>(null);
  const locked = Boolean(options.locked);
  const lockedRef = useRef(locked);
  const pendingRouteRef = useRef<PendingNotificationRoute | null>(null);

  const scheduleRoute = useRef((pending: PendingNotificationRoute) => {
    if (lockedRef.current) {
      pendingRouteRef.current = pending;
      return;
    }
    pushNotificationRoute(pending.route, pending.data, pending.source);
  }).current;

  useEffect(() => {
    lockedRef.current = locked;
    if (locked || !pendingRouteRef.current) return;
    const pending = pendingRouteRef.current;
    pendingRouteRef.current = null;
    scheduleRoute(pending);
  }, [locked, scheduleRoute]);

  useEffect(() => {
    if (Platform.OS === 'web' || process.env.EXPO_PUBLIC_HARNESS === '1' || !Notifications) return;

    registerForPushNotifications()
      .then((token) => {
        if (token) setExpoPushToken(token);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Push registration failed'));

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      logNotificationReceived(data, 'response_listener');
      routeNotificationTap(data, 'response_listener', actions, scheduleRoute);
    });

    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as Record<string, unknown>;
      logNotificationReceived(data, 'last_response');
      routeNotificationTap(data, 'last_response', actions, scheduleRoute, 500);
    });

    return () => responseSub.remove();
  }, [actions, scheduleRoute]);

  useEffect(() => {
    if (!connected || !expoPushToken || registeredTokenRef.current === expoPushToken) return;
    actions
      .registerPushToken({
        pushToken: expoPushToken,
        platform: Platform.OS,
        deviceName: `Pentacle ${Platform.OS}`,
      })
      .then(() => {
        registeredTokenRef.current = expoPushToken;
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Push token registration failed'));
  }, [actions, connected, expoPushToken]);

  return { expoPushToken, error };
}

async function registerForPushNotifications(): Promise<string | null> {
  // Harness builds skip the OS notification permission prompt — it blocks
  // the first-launch UI on the e2e harness's autoaccept_biometric/spawn
  // flow until a human taps Allow/Don't Allow, which breaks autonomous
  // device sweeps. The prompt re-fires on every fresh install (uninstall +
  // reinstall is the harness's standard reset), so suppressing it in
  // harness builds is the right scope.
  if (process.env.EXPO_PUBLIC_HARNESS === '1' || !Notifications) return null;
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    throw new Error('Missing EAS project id');
  }

  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  return tokenData.data;
}
