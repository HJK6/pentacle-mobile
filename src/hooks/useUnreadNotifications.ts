import { useCallback, useSyncExternalStore } from 'react';
import { AGENT_QUESTION_PRODUCER } from '../services/agentQuestionNotifications';
import { getNativeNotifications } from '../services/nativeNotifications';

const Notifications = getNativeNotifications();

const unreadAgentIds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let nativeSub: { remove: () => void } | null = null;

function notify() {
  version += 1;
  listeners.forEach((fn) => fn());
}

export function markRead(agentId: string) {
  if (unreadAgentIds.delete(agentId)) notify();
}

function ensureNativeListener() {
  if (!Notifications || nativeSub) return;
  nativeSub = Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request.content.data || {};
    if (data.producer === AGENT_QUESTION_PRODUCER || data.sender === AGENT_QUESTION_PRODUCER) return;
    const agentId = data.agent_id as string | undefined;
    if (agentId) {
      unreadAgentIds.add(agentId);
      notify();
    }
  });
}

function subscribe(listener: () => void) {
  ensureNativeListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      nativeSub?.remove();
      nativeSub = null;
    }
  };
}

function getSnapshot() {
  return version;
}

export function useHasUnreadNotification(agentId: string) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return unreadAgentIds.has(agentId);
}

export default function useUnreadNotifications() {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const hasUnread = useCallback((agentId: string) => unreadAgentIds.has(agentId), [version]);
  const hasUnreadUpdates = unreadAgentIds.has('system');

  return { hasUnread, hasUnreadUpdates, unreadAgentIds };
}
