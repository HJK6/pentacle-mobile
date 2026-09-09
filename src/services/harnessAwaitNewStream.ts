import { logTelemetry, selectPentacleDerivedEventIndex, teeTelemetrySink } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleStreamState } from 'pentacle-chat-core';
import * as harnessDiagnostics from './harnessDiagnostics';
import { normalizePentacleHost } from 'pentacle-chat-core';
import { performHarnessChatOpen } from './chatOpenNavigation';

type RouterLike = {
  push: (href: any) => void;
  replace?: (href: any) => void;
};

type StreamLike = {
  getPentacleStreamState: () => PentacleStreamState;
  subscribePentacleStream: (listener: () => void) => () => void;
};

const RENDER_OBSERVED_FALLBACK_MS = 5000;

function eventMatches(event: PentacleEvent, marker: string, hostFilter: string | undefined | null): boolean {
  if (!marker || !String(event.text || '').includes(marker)) return false;
  const normalizedFilter = normalizePentacleHost(hostFilter || '');
  if (!normalizedFilter) return true;
  return normalizePentacleHost(event.host) === normalizedFilter;
}

function findMatchingEvent(
  state: PentacleStreamState,
  marker: string,
  hostFilter: string | undefined | null,
): PentacleEvent | null {
  return selectPentacleDerivedEventIndex(state).chronological.find(
    (event) => eventMatches(event, marker, hostFilter),
  ) || null;
}

export function subscribeAndOpenNewStream(
  stream: StreamLike,
  marker: string | undefined | null,
  hostFilter: string | undefined | null,
  router: RouterLike,
): (() => void) | null {
  const trimmedMarker = String(marker || '').trim();
  if (!trimmedMarker) return null;

  let done = false;
  let unsubscribeMatch: (() => void) | null = null;
  let restoreTelemetrySink: (() => void) | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let dumped = false;

  const cleanup = () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    unsubscribeMatch?.();
    unsubscribeMatch = null;
    restoreTelemetrySink?.();
    restoreTelemetrySink = null;
  };

  const dumpOnce = (streamId: string, trigger: 'render_observed' | 'timeout_fallback') => {
    if (dumped) return;
    dumped = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    const state = stream.getPentacleStreamState();
    harnessDiagnostics.dumpSingleSession(state, streamId, { dump_trigger: trigger });
    cleanup();
  };

  const dumpAfterMatchingRender = (streamId: string) => {
    let transcriptReady = false;
    restoreTelemetrySink = teeTelemetrySink((payload) => {
      if (payload.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED) {
        if (String(payload.data.stream_id || '') === streamId) transcriptReady = true;
        return;
      }
      if (payload.message !== TELEMETRY_EVENTS.CHAT_EVENT_RENDERED) return;
      if (String(payload.data.stream_id || '') !== streamId) return;
      if (!transcriptReady) return;
      dumpOnce(streamId, 'render_observed');
    });
    fallbackTimer = setTimeout(() => dumpOnce(streamId, 'timeout_fallback'), RENDER_OBSERVED_FALLBACK_MS);
  };

  const maybeOpen = () => {
    if (done) return;
    const match = findMatchingEvent(stream.getPentacleStreamState(), trimmedMarker, hostFilter);
    if (!match) return;
    done = true;
    unsubscribeMatch?.();
    unsubscribeMatch = null;

    const host = normalizePentacleHost(match.host);
    logTelemetry(TELEMETRY_EVENTS.HARNESS_NEW_STREAM_OBSERVED, {
      stream_id: match.stream_id,
      marker: trimmedMarker,
      host,
    });
    logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_STREAM_ATTEMPTED, {
      stream_id: match.stream_id,
    });
    performHarnessChatOpen(match.stream_id, router);
    dumpAfterMatchingRender(match.stream_id);
  };

  unsubscribeMatch = stream.subscribePentacleStream(maybeOpen);
  maybeOpen();
  return cleanup;
}
