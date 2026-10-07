import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOP_INSET, Tokens } from '@/constants/Colors';
import { peekEventsForStream } from 'pentacle-chat-core';
import Starfield from '../../src/components/Starfield';
import StatusSurface from '../../src/components/status/StatusSurface';
import { BART_STREAM_ID, selectOpenLanes, selectStatusUpdates } from '../../src/components/status/statusSelectors';
import {
  getPentacleStreamState, registerFocusedPentacleStream, requestStreamEvents, selectStreamEventsLoadState,
  selectStreamSlice, usePentacleStreamSelectorWhen,
} from '../../src/services/pentacleStream';
import { performChatOpenNavigation } from '../../src/services/chatOpenNavigation';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';

export default function UpdatesScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const state = usePentacleStreamSelectorWhen(isFocused, (snapshot) => snapshot);
  const updates = useMemo(() => selectStatusUpdates(state), [state]);
  const lanes = useMemo(() => selectOpenLanes(state), [state]);
  const [now, setNow] = useState(Date.now);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logActive = useRef(false);
  logActive.current = isFocused && state.connected && showLog;
  useEffect(() => () => { logActive.current = false; }, []);
  const olderInFlight = useRef(false);
  const pendingHistoryDemand = useRef(false);
  if (!logActive.current) pendingHistoryDemand.current = false;
  const hasOlderHistoryPage = usePentacleStreamSelectorWhen(isFocused, (snapshot) =>
    selectStreamSlice(snapshot, BART_STREAM_ID, { visibleCount: 0, includeDraft: false }).hasOlderHistoryPage);
  const historyLoad = usePentacleStreamSelectorWhen(isFocused, (snapshot) => selectStreamEventsLoadState(snapshot, BART_STREAM_ID));

  useEffect(() => {
    if (!isFocused) return;
    logFocusedTab('updates');
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    const release = registerFocusedPentacleStream(BART_STREAM_ID);
    return () => { clearInterval(timer); release(); };
  }, [isFocused]);

  // One revalidation on each focused connection; the existing transport coalesces
  // in-flight requests and owns retained history. Clock ticks never trigger I/O.
  const fresh = useRef(historyLoad.fresh);
  fresh.current = historyLoad.fresh;
  useEffect(() => {
    if (!isFocused || !state.connected || fresh.current) {
      setLoading(false);
      if (fresh.current) setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void requestStreamEvents(BART_STREAM_ID, 300, { purpose: 'mount-fetch' })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isFocused, state.connected]);

  const loadEarlier = useCallback(async () => {
    if (!logActive.current || olderInFlight.current) return;
    if (loading) { pendingHistoryDemand.current = true; return; }
    pendingHistoryDemand.current = false;
    if (!hasOlderHistoryPage) return;
    olderInFlight.current = true;
    let oldest = Math.min(...peekEventsForStream(getPentacleStreamState(), BART_STREAM_ID)
      .map((event) => event.daemon_seq).filter(Number.isFinite));
    try {
      // A filtered-out page leaves the list height unchanged, so onEndReached
      // will not fire again. Continue this one demand until a status is found.
      do {
        const page = await requestStreamEvents(BART_STREAM_ID, 300, { purpose: 'older-page' });
        if (!logActive.current || page.some((event) => event.publish_kind === 'status')) break;
        const nextOldest = Math.min(...page.map((event) => event.daemon_seq));
        if (!Number.isFinite(nextOldest) || nextOldest >= oldest) break;
        oldest = nextOldest;
      } while (selectStreamSlice(getPentacleStreamState(), BART_STREAM_ID).hasOlderHistoryPage);
    } catch {
      if (logActive.current) setError(true);
    } finally {
      olderInFlight.current = false;
    }
  }, [hasOlderHistoryPage, loading]);

  useEffect(() => {
    if (showLog && !loading && !error && (updates.length === 0 || pendingHistoryDemand.current)) void loadEarlier();
  }, [showLog, loading, error, updates.length, loadEarlier]);

  const openSession = useCallback((streamId: string) => {
    performChatOpenNavigation(streamId, router);
  }, [router]);

  return <View style={styles.container}>
    <Starfield />
    <StatusSurface updates={updates} lanes={lanes} now={now}
      working={state.sessions.find((session) => session.stream_id === BART_STREAM_ID)?.working === true}
      top={Math.max(insets.top, TOP_INSET)} bottom={Math.max(insets.bottom, 18) + 92}
      showLog={showLog} onShowLog={setShowLog} loading={loading} error={error} onOpen={openSession} onLoadEarlier={loadEarlier} />
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Tokens.palette.ink, position: 'relative' },
});
