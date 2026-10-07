import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOP_INSET, Tokens } from '@/constants/Colors';
import { peekEventsForStream } from 'pentacle-chat-core';
import Starfield from '../Starfield';
import StatusSurface from '../status/StatusSurface';
import { BART_STREAM_ID, selectOpenLanes, selectStatusUpdates } from '../status/statusSelectors';
import {
  getPentacleStreamState, requestStreamEvents, selectStreamEventsLoadState,
  selectStreamSlice, usePentacleStreamSelectorWhen,
} from '../../services/pentacleStream';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';


// Preserve the Updates history wiring while composing the locked surface in a modal.
export default function BartStatusOverlay({ onClose }: { onClose(): void }) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(rise, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [rise]);
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
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    // The embedded SessionScreen owns the singleton focused-stream registration.
    return () => clearInterval(timer);
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
    performChatOpenNavigation(streamId, router, onClose);
  }, [router, onClose]);

  return <Modal visible presentationStyle="fullScreen" animationType="none" onRequestClose={onClose}>
    <View style={styles.container}>
    <Animated.View testID="bart-status-overlay" style={[styles.container, {
      opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
    }]}>
    <Starfield />
    <StatusSurface updates={updates} lanes={lanes} now={now}
      working={state.sessions.find((session) => session.stream_id === BART_STREAM_ID)?.working === true}
      top={Math.max(insets.top, TOP_INSET)} bottom={Math.max(insets.bottom, 18)}
      showLog={showLog} onShowLog={setShowLog} loading={loading} error={error} onOpen={openSession} onLoadEarlier={loadEarlier} />
    <Pressable accessibilityRole="button" accessibilityLabel="Close status" onPress={onClose}
      style={[styles.close, { top: Math.max(insets.top, TOP_INSET) }]}><Text style={styles.closeText}>✕</Text></Pressable>
    </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  close: { position: 'absolute', right: 16, width: 34, height: 34, borderRadius: 17, borderWidth: 1,
    borderColor: Tokens.palette.line, backgroundColor: Tokens.palette.panel, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: Tokens.palette.muted, fontSize: 18 },
  container: { flex: 1, backgroundColor: Tokens.palette.ink, position: 'relative' },
});
