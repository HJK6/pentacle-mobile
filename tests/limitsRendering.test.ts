// Reproduces the phone's blank-limits defect: the daemon's usage rows now carry
// `upstream_reported_at` + `probed_at` (7 fields) and a `limits_health` sidecar
// (usage_publisher.py / server.py hello assembly). The mobile normalizer used to
// reject any row whose field set was not exactly the legacy 5, so every hello and
// `limits.update` frame fell back to the all-null INITIAL rows. These tests lock:
// hello + update populate, reconnect without `limits` preserves rows, and Claude
// probe-error health projects to renderable text.
import {
  applyPentacleSnapshotMessage,
  applyPentacleLimits,
  limitHealthText,
  initialPentacleStreamState,
  type PentacleLimit,
} from 'pentacle-chat-core';

// Live daemon frame shape (7-field rows): usage_publisher._empty_row / server.py hello.
const DAEMON_LIMITS = [
  {
    id: 'claude', label: 'Claude', pct: 42,
    resets_at_iso: '2026-09-08T00:00:00Z', resets_text: 'Mon 7PM',
    upstream_reported_at: '2026-09-05T05:00:00Z', probed_at: '2026-09-05T05:00:01Z',
  },
  {
    id: 'fable', label: 'Fable', pct: null,
    resets_at_iso: null, resets_text: null,
    upstream_reported_at: null, probed_at: null,
  },
  {
    id: 'codex', label: 'Codex', pct: 73,
    resets_at_iso: '2026-09-08T00:00:00Z', resets_text: 'Mon 7PM',
    upstream_reported_at: '2026-09-05T05:00:00Z', probed_at: '2026-09-05T05:00:01Z',
  },
];

// health_snapshot(): {schema_version, claude: <HEALTH_KEYS dict>}; hosta's Claude probe
// fails (claude_health.outcome = provider_error) — the row must still render with text.
const DAEMON_LIMITS_HEALTH = {
  schema_version: 1,
  claude: {
    attempted_at: '2026-09-05T05:00:00Z',
    outcome: 'provider_error',
    error: { code: 'claude_usage_provider_error', message: 'Provider usage is unavailable' },
    upstream_reported_at: null,
    probed_at: '2026-09-05T05:00:00Z',
    stale_after_seconds: 3600,
  },
};

function byId(limits: PentacleLimit[] | undefined, id: string): PentacleLimit | undefined {
  return (limits ?? []).find((row) => row.id === id);
}

describe('mobile limits rendering from the daemon frame', () => {
  it('hello snapshot populates rows from the 7-field daemon shape and captures health', () => {
    const state = applyPentacleSnapshotMessage(initialPentacleStreamState, {
      sessions: [],
      limits: DAEMON_LIMITS,
      limits_health: DAEMON_LIMITS_HEALTH,
    });
    expect(state.limits).toHaveLength(3);
    expect(byId(state.limits, 'claude')?.pct).toBe(42);
    expect(byId(state.limits, 'codex')?.pct).toBe(73);
    expect(byId(state.limits, 'codex')?.resets_text).toBe('Mon 7PM');
    expect(state.limitsHealth?.claude?.outcome).toBe('provider_error');
  });

  it('limits.update populates rows from the 7-field daemon shape', () => {
    const state = applyPentacleLimits(initialPentacleStreamState, DAEMON_LIMITS);
    expect(byId(state.limits, 'claude')?.pct).toBe(42);
    expect(byId(state.limits, 'codex')?.pct).toBe(73);
  });

  it('tolerates unknown future fields on a row (forward compatible)', () => {
    const withExtra = DAEMON_LIMITS.map((row) => ({ ...row, some_future_field: 'x' }));
    const state = applyPentacleLimits(initialPentacleStreamState, withExtra);
    expect(byId(state.limits, 'claude')?.pct).toBe(42);
  });

  it('reconnect without a limits field leaves the previous rows in place', () => {
    const populated = applyPentacleSnapshotMessage(initialPentacleStreamState, {
      sessions: [],
      limits: DAEMON_LIMITS,
      limits_health: DAEMON_LIMITS_HEALTH,
    });
    const reconnected = applyPentacleSnapshotMessage(populated, { sessions: [] });
    expect(byId(reconnected.limits, 'claude')?.pct).toBe(42);
    expect(byId(reconnected.limits, 'codex')?.pct).toBe(73);
  });

  it('projects a Claude probe error to renderable text (row never hidden)', () => {
    const state = applyPentacleSnapshotMessage(initialPentacleStreamState, {
      sessions: [],
      limits: DAEMON_LIMITS,
      limits_health: DAEMON_LIMITS_HEALTH,
    });
    expect(limitHealthText(state.limitsHealth?.claude)).toBe('Provider usage is unavailable');
    // A healthy/absent provider produces no text (nothing to render, still a row).
    expect(limitHealthText(state.limitsHealth?.codex)).toBeNull();
    expect(limitHealthText(undefined)).toBeNull();
  });
});
