import { useEffect } from 'react';
import { listNotifications, usePentacleStreamSelectorWhen } from '../services/pentacleStream';
import type { PentacleNotification } from 'pentacle-chat-core';

// Live notifications slice (newest-first). Triggers a `notification.list`
// backfill on mount/focus; the live `notification` broadcast frame keeps the
// slice fresh afterwards.
//
// `states` is intentionally omitted so the daemon returns ALL states — the
// persistent Updates feed shows terminal (answered/done/failed/resolved) cards
// in place, not just open ones (decision #2). `limit:100` bounds the page
// (newest-first) to match the desktop persistent-feed default (Spec-QA S2).
const NOTIFICATION_LIST_LIMIT = 100;

export default function useNotifications(enabled = true) {
  const notifications = usePentacleStreamSelectorWhen(
    enabled,
    (state) => state.notifications as PentacleNotification[],
    Object.is,
  );
  const connecting = usePentacleStreamSelectorWhen(enabled, (state) => state.connecting, Object.is);
  const lastError = usePentacleStreamSelectorWhen(enabled, (state) => state.lastError, Object.is);

  useEffect(() => {
    if (!enabled) return;
    // Backfill; ignore rejection (not connected yet / RPC error) — the live
    // broadcast and a later focus will recover.
    listNotifications({ limit: NOTIFICATION_LIST_LIMIT }).catch(() => undefined);
  }, [enabled]);

  return {
    notifications,
    connecting,
    loading: connecting && notifications.length === 0,
    error: lastError || null,
    refetch: async () => {
      try {
        await listNotifications({ limit: NOTIFICATION_LIST_LIMIT });
      } catch {
        // swallow — surfaced via lastError / live frame
      }
    },
  };
}
