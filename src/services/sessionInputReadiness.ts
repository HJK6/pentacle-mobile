import type { PentacleSessionSummary } from 'pentacle-chat-core';

export function isPentacleSessionSendEligible(
  session: PentacleSessionSummary | null | undefined,
): boolean {
  if (!session) return false;
  switch (session.bootstrap_state) {
    case 'queued':
    case 'starting':
    case 'failed':
      return false;
    case 'ready':
      return true;
    default:
      // Missing and non-modern values belong to the legacy compatibility path.
      return true;
  }
}
