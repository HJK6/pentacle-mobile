/** A projection of the daemon's estimate, never a client-generated forecast. */
type LaneEstimate = {
  eta_at?: string | null;
  eta_set_at?: string | null;
  now?: number;
  needsYou?: boolean;
};

function interval({ eta_at, eta_set_at, now = Date.now() }: LaneEstimate) {
  const end = Date.parse(eta_at ?? '');
  const start = Date.parse(eta_set_at ?? '');
  return Number.isFinite(end) && Number.isFinite(start) && Number.isFinite(now) && end > start
    ? { end, start, now }
    : null;
}

export function formatLaneEta(estimate: LaneEstimate): string {
  if (estimate.needsYou) return 'Blocked';
  const value = interval(estimate);
  if (!value) return '—';
  const delta = value.end - value.now;
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const duration = hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${minutes}m`;
  return `${delta > 0 ? '~' : 'late '}${duration}`;
}

/** Fleet parity helper for tests only; the status surface never renders percentages. */
export function fleetOverrunPct(estimate: LaneEstimate): number {
  const value = interval(estimate);
  return value ? Math.max(0, 100 * (value.now - value.end) / (value.end - value.start)) : 0;
}
