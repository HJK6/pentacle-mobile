import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionScreen } from '../pentacle/session/[streamId]';
import { selectLocalAssistantIdentity } from '../../src/components/bart/assistantIdentity';
import BartHeader from '../../src/components/bart/BartHeader';
import BartStatusOverlay from '../../src/components/bart/BartStatusOverlay';
import { selectOthersNeedingYou } from '../../src/components/bart/bartSelectors';
import { selectPendingQuestionCount } from '../../src/components/questions/questionSelectors';
import { BART_STREAM_ID, selectOpenLanes } from '../../src/components/status/statusSelectors';
import { usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import { resetChatOpenNavigationIntents } from '../../src/services/chatOpenNavigationIntent';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';

export default function BartScreen() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const state = usePentacleStreamSelectorWhen(isFocused, (snapshot) => snapshot);
  const [statusOpen, setStatusOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const questionsOpening = useRef(false);
  const header = useMemo(() => ({
    identity: selectLocalAssistantIdentity(state),
    others: selectOthersNeedingYou(state).length, pending: selectPendingQuestionCount(state),
    lanes: selectOpenLanes(state).length,
    working: state.sessions.find((session) => session.stream_id === BART_STREAM_ID)?.working === true,
  }), [state]);
  useEffect(() => {
    if (isFocused) {
      questionsOpening.current = false;
      resetChatOpenNavigationIntents();
      logFocusedTab('bart');
    } else { setStatusOpen(false); setDrawerOpen(false); }
  }, [isFocused]);
  const openQuestions = () => {
    if (!isFocused || questionsOpening.current) return;
    questionsOpening.current = true;
    Keyboard.dismiss();
    try { router.push('/pentacle/questions'); }
    catch { questionsOpening.current = false; }
  };
  return <View style={styles.root}>
    <SessionScreen streamId={BART_STREAM_ID} header={<BartHeader {...header} top={insets.top}
      onDrawer={() => { Keyboard.dismiss(); setDrawerOpen(true); }}
      onStatus={() => { Keyboard.dismiss(); setStatusOpen(true); }} onQuestions={openQuestions} />} />
    {statusOpen ? <BartStatusOverlay onClose={() => setStatusOpen(false)} /> : null}
  </View>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
