import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOP_INSET, Tokens } from '@/constants/Colors';
import Starfield from '../../src/components/Starfield';
import LanesSurface from '../../src/components/lanes/LanesSurface';
import LaneHistoryScreen, { type LaneHistoryTarget } from '../../src/components/lanes/LaneHistoryScreen';
import { BART_STREAM_ID } from '../../src/components/status/statusSelectors';
import { performChatOpenNavigation } from '../../src/services/chatOpenNavigation';
import { HOME_ROUTE } from '../../src/services/homeRoute';
import { usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { selectLaneViewModels, selectWorkLaneCounts, type LaneViewModel } from '../../src/services/workLanes';

// /pentacle/lanes — the daemon's open work lanes (header lanes tap). A tap goes to the lane's
// visible chat: an open chat, Bart's own thread, a read-only retained history, or an honest
// "Chat unavailable" row — never a hidden worker, a new generation, or a silent Bart fallback.
export default function LanesRoute() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const state = usePentacleStreamSelectorWhen(isFocused, (snapshot) => snapshot);
  const [now, setNow] = useState(Date.now);
  const [history, setHistory] = useState<LaneHistoryTarget | null>(null);
  useEffect(() => {
    if (!isFocused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [isFocused]);
  const lanes = useMemo(() => selectLaneViewModels(state, now), [state, now]);
  const counts = selectWorkLaneCounts(state);
  const top = Math.max(insets.top, TOP_INSET);
  const bottom = Math.max(insets.bottom, 18);

  const close = useCallback(() => { router.back(); }, [router]);
  const openLane = useCallback((model: LaneViewModel) => {
    const tap = model.tap;
    if (tap.action === 'open_chat') {
      if (tap.stream_id === BART_STREAM_ID) router.replace(HOME_ROUTE as any);
      else performChatOpenNavigation(tap.stream_id, router);
    } else if (tap.action === 'history') {
      setHistory({ streamId: tap.stream_id, generation: tap.generation, title: model.lane.title });
    }
  }, [router]);
  const openLead = useCallback((streamId: string) => { performChatOpenNavigation(streamId, router); }, [router]);

  return <View style={styles.root}>
    <Starfield />
    <LanesSurface lanes={lanes} counts={counts} truncated={state.workLanes?.truncated === true} now={now}
      top={top} bottom={bottom} onOpenLane={openLane} onOpenLead={openLead} onClose={close} />
    {history
      ? <View style={StyleSheet.absoluteFill}>
        <LaneHistoryScreen target={history} connected={state.connected} onClose={() => setHistory(null)} top={top} bottom={bottom} />
      </View>
      : null}
  </View>;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: Tokens.palette.ink } });
