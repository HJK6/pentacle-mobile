export function isDefaultVisibleSession(session: unknown) {
  const visibility = typeof session === 'object' && session !== null && 'visibility' in session
    ? (session as { visibility?: unknown }).visibility
    : undefined;
  return !visibility || visibility === 'default';
}

export function selectDefaultVisibleSessions<T>(sessions: readonly T[]): T[] {
  return sessions.filter(isDefaultVisibleSession);
}
