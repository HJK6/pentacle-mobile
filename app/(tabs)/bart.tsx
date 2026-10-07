import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionScreen } from '../pentacle/session/[streamId]';
import { selectMachineStatusList } from 'pentacle-chat-core';
import { isIdentityHost } from '../../src/config/local';
import type { SummonMachine } from '../../src/components/SummonModal';
import { useNewSessionFlow } from '../../src/components/useNewSessionFlow';
import { performChatOpenNavigation } from '../../src/services/chatOpenNavigation';
import ChatsDrawer from '../../src/components/bart/ChatsDrawer';
import { selectAssistantIdentity } from '../../src/services/assistantIdentity';
import BartHeader from '../../src/components/bart/BartHeader';
import BartStatusOverlay from '../../src/components/bart/BartStatusOverlay';
import { selectDrawerGroups, selectOthersNeedingYou } from '../../src/components/bart/bartSelectors';
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
  const groups = useMemo(() => selectDrawerGroups(state), [state]);
  const machines = useMemo(() => selectMachineStatusList(state).filter((machine) => !isIdentityHost(machine.host))
    .map(({ host, title, online }) => ({ host, title, online })), [state]);
  const header = useMemo(() => ({
    identity: selectAssistantIdentity(state),
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
  const openDrawer = useCallback(() => { Keyboard.dismiss(); setDrawerOpen(true); }, []);
  const openStatus = useCallback(() => { Keyboard.dismiss(); setStatusOpen(true); }, []);
  const openQuestions = useCallback(() => {
    if (!isFocused || questionsOpening.current) return;
    questionsOpening.current = true;
    Keyboard.dismiss();
    try { router.push('/pentacle/questions'); }
    catch { questionsOpening.current = false; }
  }, [isFocused, router]);
  return <View style={styles.root}>
    <BartThread {...header} top={insets.top} onDrawer={openDrawer} onStatus={openStatus} onQuestions={openQuestions} />
    {isFocused ? <BartSessions open={drawerOpen} groups={groups} machines={machines} onClose={() => setDrawerOpen(false)} /> : null}
    {statusOpen ? <BartStatusOverlay onClose={() => setStatusOpen(false)} /> : null}
  </View>;
}

// Unrelated session prose may update the drawer but must not force transcript
// renders. The real SessionScreen keeps its own narrow live subscriptions.
const BartThread = React.memo(function BartThread(props: React.ComponentProps<typeof BartHeader>) {
  return <SessionScreen streamId={BART_STREAM_ID} header={<BartHeader {...props} />} questionsInHeader />;
});

// Scope the modal flow to this focus visit so a newer route cancels queued
// presentation. A completed spawn can remain in the store without stealing focus.
function BartSessions({ open, groups, machines, onClose }: {
  open: boolean; groups: ReturnType<typeof selectDrawerGroups>; machines: SummonMachine[]; onClose(): void;
}) {
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onOpened = useCallback((streamId: string) => {
    if (mounted.current) performChatOpenNavigation(streamId, router);
  }, [router]);
  const flow = useNewSessionFlow({ machines, onOpened });
  return <>
    <ChatsDrawer open={open} groups={groups} canStart={flow.canStart} onClose={onClose} onNewSession={flow.start} />
    {flow.modal}
  </>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
