import { useEffect, useRef } from 'react';
import { listNotifications } from '../services/pentacleStream';

type AskRow = { eventCase?: string; notificationId?: string };

// Terminal answers are absent from hello's open-only notification inventory.
// Fetch only loaded ask identities, once per focus/connection, in bounded batches.
export default function useTranscriptQuestionBackfill(
  streamId: string,
  enabled: boolean,
  rows: readonly AskRow[] | undefined,
) {
  const idsKey = JSON.stringify([...new Set((rows ?? [])
    .filter((row) => row.eventCase === 'agent-question-ask' && row.notificationId)
    .map((row) => row.notificationId as string))].sort());
  const requested = useRef({ streamId, ids: new Set<string>() });
  useEffect(() => {
    if (!enabled || requested.current.streamId !== streamId) {
      requested.current = { streamId, ids: new Set() };
    }
    if (!enabled || !streamId) return;
    const scope = requested.current;
    const ids = (JSON.parse(idsKey) as string[]).filter((id) => !scope.ids.has(id));
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      batch.forEach((id) => scope.ids.add(id));
      void listNotifications({ notificationIds: batch }).catch(() => {
        batch.forEach((id) => scope.ids.delete(id));
      });
    }
  }, [enabled, idsKey, streamId]);
}
