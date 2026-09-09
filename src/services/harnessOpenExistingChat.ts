import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { logTelemetry } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import { isAgentOrchSession } from './harnessSessionFilters';
import { normalizePentacleHost } from 'pentacle-chat-core';
import * as harnessRuntime from '../utils/harnessRuntime';
import { markStreamOpenIntent, prefetchStreamEvents, type StreamOpenEntrySource } from './pentacleStream';
import { performHarnessChatOpen } from './chatOpenNavigation';

type RouterLike = {
  // Expo Router's generated Href union is not available in this harness-only module.
  push: (href: any) => void;
  replace?: (href: any) => void;
};

function sessionTime(session: PentacleSessionSummary): number {
  const parsed = Date.parse(session.last_event_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeProvider(provider: string | undefined): string | null {
  if (!provider) return null;
  const trimmed = String(provider).trim().toLowerCase();
  return trimmed || null;
}

function hasRenderableSummary(session: PentacleSessionSummary): boolean {
  return Boolean(String(session.last_text || session.draft || '').trim());
}

export function pickSession(
  state: PentacleStreamState,
  host: string,
  provider?: 'claude' | 'codex',
  streamIdOverride?: string | null,
): PentacleSessionSummary | null {
  const normalizedHost = normalizePentacleHost(host);
  if (!normalizedHost) return null;
  const wantedProvider = normalizeProvider(provider);
  const override = String(streamIdOverride || '').trim();
  if (override) {
    const matched = [...state.sessions]
      .filter((session) => normalizePentacleHost(session.host) === normalizedHost)
      .filter((session) => {
        if (!wantedProvider) return true;
        return normalizeProvider(session.provider) === wantedProvider;
      })
      .find((session) => session.stream_id === override);
    if (matched) return matched;
    // An explicit harness override is authoritative. Scripted-daemon inventory
    // can arrive after the launch action, but the requested stream is already
    // backed by deterministic history; synthesize only the routing summary so
    // the harness does not race inventory hydration.
    return {
      stream_id: override,
      host: normalizedHost,
      provider: wantedProvider || 'unknown',
      session_name: override.split(':').slice(1).join(':') || override,
      display_name: '[harness-explicit-override]',
      last_event_at: '',
      last_text: '',
      last_kind: '',
      draft: '',
      pending: false,
      working: false,
      online: true,
    };
  }
  // Pick-by-host DISCOVERY path: choose the most-recent ONLINE session for the
  // host. The online filter is a correctness contract here — discovery must
  // land on a live session and no-op when none is online, never resurrect a
  // dead/stale session. (R2 dropped `session.online` from BOTH branches under
  // composite load, but only the override branch — opening a specifically
  // requested stream_id, which should ignore online-flapping — needs that.
  // The composite scenario opens via override/`entry_source: search`, so
  // restoring the filter here does not touch it.)
  const candidates = [...state.sessions]
    .filter((session) => session.online && normalizePentacleHost(session.host) === normalizedHost)
    .filter((session) => {
      if (!wantedProvider) return true;
      return normalizeProvider(session.provider) === wantedProvider;
    })
    .filter(hasRenderableSummary)
    .filter((session) => !isAgentOrchSession(session));
  return candidates
    .sort((a, b) => {
      const timeDelta = sessionTime(b) - sessionTime(a);
      if (timeDelta !== 0) return timeDelta;
      return String(b.stream_id || '').localeCompare(String(a.stream_id || ''));
    })[0] || null;
}

export function attemptOpenExistingChat(
  state: PentacleStreamState,
  host: string | undefined,
  router: RouterLike,
  provider?: 'claude' | 'codex',
  streamIdOverride?: string | null,
): string | null {
  const override = String(streamIdOverride || '').trim();
  const session = override ? null : pickSession(state, host || '', provider);
  if (!override && !session) return null;
  const streamId = override || String(session?.stream_id || '');
  const normalizedHost = normalizePentacleHost(host || session?.host || '');
  if (!streamId || !normalizedHost) return null;

  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED, {
    stream_id: streamId,
    host: normalizedHost,
    ...(override ? { stream_id_override: true } : {}),
  });
  // Mark this stream active for the harness telemetry mirror so its events
  // are emitted to [TELEMETRY] (production behavior unchanged).
  try { harnessRuntime.markStreamHarnessActive(streamId); } catch {}
  const entrySourceParam = harnessRuntime.getParam('entry_source');
  const entrySource: StreamOpenEntrySource =
    entrySourceParam === 'list-settle' ||
    entrySourceParam === 'press-in' ||
    entrySourceParam === 'notification' ||
    entrySourceParam === 'search' ||
    entrySourceParam === 'cold-jump'
      ? entrySourceParam
      : (streamIdOverride ? 'search' : 'cold-jump');
  markStreamOpenIntent(streamId, entrySource);
  if (entrySource !== 'cold-jump') {
    prefetchStreamEvents(streamId, entrySource);
  }
  // G2 chat_open_paint instrumentation. The SLO scenario opens chats through
  // THIS harness path, not the interactive Chats-row `openChat` handler, so it
  // must route through the SAME shared navigation unit — otherwise the paint
  // trace never begins, the navigation-intent coordinator is never seeded, the
  // destination screen's `acknowledgeChatRowNavigationIntent` returns null, and
  // zero chat_open_paint phases emit (the 0-paint-event root cause). Reusing
  // `performChatOpenNavigation` (not re-implementing it) also makes the harness
  // honor the product's real push/replace/noop branch, and keeps the two paths
  // from drifting again. `router.push`/`replace` are wrapped so a pre-mount
  // navigation throw (harness cold launch fires before RootLayout mounts) is
  // swallowed while the caller still gets its stream_id back. Production keeps
  // the NOOP paint sink, so nothing is emitted there.
  performHarnessChatOpen(streamId, router);
  return streamId;
}
