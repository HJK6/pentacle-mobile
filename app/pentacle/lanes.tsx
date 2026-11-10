import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOP_INSET, Tokens } from '@/constants/Colors';
import Starfield from '../../src/components/Starfield';
import VoiceRecordingOverlay from '../../src/components/voice/VoiceRecordingOverlay';
import LanesOverlay from '../../src/components/lanes/LanesOverlay';
import { selectAssistantIdentity } from '../../src/services/assistantIdentity';
import { usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { selectLaneCardViewModels, selectLaneUpdates } from '../../src/services/workLanes';

export default function LanesRoute() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const state = usePentacleStreamSelectorWhen(isFocused, snapshot => snapshot);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isFocused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [isFocused]);
  const lanes = useMemo(() => selectLaneCardViewModels(state, now), [state, now]);
  const updates = useMemo(() => selectLaneUpdates(state), [state]);
  const identity = selectAssistantIdentity(state);
  const close = useCallback(() => router.back(), [router]);
  return <View style={styles.root}>
    <Starfield />
    <LanesOverlay active={isFocused} lanes={lanes} inventory={state.workLanes} assistantName={identity.name} connected={state.connected} updates={updates}
      readShow={process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1' ? require('../../src/harness/workLaneShows').readScreenshotWorkLaneShow : undefined}
      top={Math.max(insets.top, TOP_INSET)} bottom={Math.max(insets.bottom, 18)} onChat={() => {}} onClose={close} />
    <VoiceRecordingOverlay visible={isFocused} priority={1} hostName="lanes" />
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: Tokens.palette.ink } });
