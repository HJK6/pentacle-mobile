/**
 * Harness-only: filters that exclude agent-orchestration sub-agent sessions
 * from the `open_existing_chat` preflight.
 *
 * Agent-orch sessions (auto-named `codex-<host>-<digits>` /
 * `claude-<host>-<digits>`) appear in the inventory and beat real user
 * sessions on `last_event_at` recency, so the harness preflight needs to
 * skip them.
 *
 * The exported `PentacleSessionSummary` type does NOT carry `closed_at`
 * or `role`; preflight filtering intentionally operates on
 * `display_name` (preferred) and `session_name` (fallback when
 * `display_name` is falsy).
 *
 * Override: set `EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX` to a
 * `;`-delimited list of regex literals (each compiled with the `i` flag).
 * Patterns that fail to parse are skipped with a `console.warn`.
 *
 * Spec: public behavior contract Stage 1.1.
 */

import type { PentacleSessionSummary } from 'pentacle-chat-core';

const BUILTIN_AGENT_ORCH_PATTERNS: RegExp[] = [
  /^codex-(hosta|hostb|hostc|hostd)-\d+$/i,
  /^claude-(hosta|hostb|hostc|hostd)-\d+$/i,
  // Agent-orch / orchestrator-driver TUI sessions are named
  // `<provider>-<YYYYMMDDhhmmss>-<nonce>` (matches the daemon's
  // REAL_TUI_SESSION_RE). These are the agent-driver TUIs that the
  // harness must NEVER select as an "existing chat" — sending to them
  // would write into the orchestrator's own input.
  /^(claude|codex)-20\d{12}-[a-z0-9]+$/i,
];

function parseOverridePatterns(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  const out: RegExp[] = [];
  for (const literal of raw.split(';')) {
    const trimmed = literal.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, 'i'));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[harnessSessionFilters] failed to parse EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX entry ${JSON.stringify(trimmed)}: ${String(err)}`,
      );
    }
  }
  return out;
}

export const AGENT_ORCH_DISPLAY_NAME_PATTERNS: RegExp[] = [
  ...BUILTIN_AGENT_ORCH_PATTERNS,
  ...parseOverridePatterns(process.env.EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX),
];

/**
 * Returns true if the session looks like an agent-orchestration worker
 * session and should be excluded from harness preflight picks.
 *
 * Checks BOTH `session_name` AND `display_name`. Agent-orch sessions
 * have a stable auto-generated `session_name`
 * (`<provider>-<host>-<digits>` or `<provider>-<YYYYMMDDhhmmss>-<nonce>`)
 * but users (or peer agents) can RENAME their `display_name` to anything
 * (e.g. "Pentacle Mobile Stable V1"). Checking display_name alone misses
 * those sessions; checking both is safe because the patterns target
 * machine-generated formats that humans don't typically pick.
 */
export function isAgentOrchSession(session: PentacleSessionSummary): boolean {
  const candidates = [
    (session.display_name && session.display_name.trim()) ? session.display_name : '',
    session.session_name || '',
  ].filter(Boolean);
  if (candidates.length === 0) return false;
  for (const candidate of candidates) {
    for (const pattern of AGENT_ORCH_DISPLAY_NAME_PATTERNS) {
      if (pattern.test(candidate)) return true;
    }
  }
  return false;
}
