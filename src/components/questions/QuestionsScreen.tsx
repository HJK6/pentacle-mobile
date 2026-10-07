import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { Fonts, Tokens } from '../../../constants/Colors';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import { usePentacleStreamActions, usePentacleStreamSelector } from '../../services/pentacleStream';
import {
  MobileQuestionOne,
  useMobileQuestionFlow,
  type MobileQuestionAnswer,
  type MobileQuestionEntry,
} from '../MobileQuestions';
import Starfield from '../Starfield';
import DeckDots from './DeckDots';
import { selectQuestionDeck, type QuestionDeckEntry } from './questionSelectors';
import { useAssistantIdentity } from '../../services/assistantIdentity';
import SourceMark from './SourceMark';
import { sendableKeys, submitDeckAnswers } from './submitDeckAnswers';
import VoiceAnswerBar, { VoiceMicButton, VoicePageLabel } from './voice/VoiceAnswerBar';
import { useVoiceAnswers, type RemovalGuardNavigation } from './voice/useVoiceAnswers';

const TOAST_MS = 2200;
const FALLBACK_ERROR = 'Question answer could not be submitted.';

type LegacyError = { actionId: string; streamId: string; title: string };

const suffixed = (base: string, index: number) => (index === 0 ? base : `${base}-${index}`);

function Chevron({ color, flip = false }: { color: string; flip?: boolean }) {
  return (
    <Svg width={17} height={17} viewBox="0 0 24 24" fill="none" style={flip ? styles.flip : undefined}>
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function initialPageKey(deck: readonly QuestionDeckEntry[], notificationId?: string) {
  if (!notificationId) return null;
  return deck.find((entry) => entry.action.kind === 'durable' && entry.action.id === notificationId)?.key ?? null;
}

// P4 Questions overlay (README §5 / BartQuestionsOverlay): one pending question per page over
// every open durable question (Bart and sessions), with partial submit.
export default function QuestionsScreen({ notificationId, navigation }: { notificationId?: string; navigation?: RemovalGuardNavigation }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const actions = usePentacleStreamActions();
  const assistant = useAssistantIdentity();
  const liveDeck = usePentacleStreamSelector(selectQuestionDeck);
  // While a send is in flight its submitted items stay pinned: each leaves the live deck the moment
  // its optimistic answer begins, and the flow would drop its draft. A failed item returns on discard
  // with its draft intact because it stayed pinned. Everything else stays live, so a question that
  // arrives during the send shows at once.
  const [inFlight, setInFlight] = useState<{ snapshot: QuestionDeckEntry[]; pinned: Set<string> } | null>(null);
  const deck = useMemo(() => {
    if (!inFlight) return liveDeck;
    const live = new Set(liveDeck.map((entry) => entry.key));
    const kept = inFlight.snapshot.filter((entry) => live.has(entry.key) || inFlight.pinned.has(entry.key));
    const keptKeys = new Set(kept.map((entry) => entry.key));
    const liveByKey = new Map(liveDeck.map((entry) => [entry.key, entry]));
    return [
      ...kept.map((entry) => liveByKey.get(entry.key) ?? entry),
      ...liveDeck.filter((entry) => !keptKeys.has(entry.key)),
    ];
  }, [inFlight, liveDeck]);

  const flowEntries = useMemo<MobileQuestionEntry<QuestionDeckEntry>[]>(() => deck.map((entry) => ({
    key: entry.key,
    question: entry.question,
    source: entry,
    locked: entry.locked,
  })), [deck]);
  const flow = useMobileQuestionFlow(flowEntries);

  // The current page is tracked by key so a question vanishing or arriving elsewhere never moves it.
  const [pageKey, setPageKey] = useState<string | null>(() => initialPageKey(deck, notificationId));
  const lastIndexRef = useRef(0);
  const seededRef = useRef(deck.length > 0);
  const found = pageKey ? deck.findIndex((entry) => entry.key === pageKey) : -1;
  const index = found >= 0 ? found : Math.min(lastIndexRef.current, Math.max(0, deck.length - 1));
  lastIndexRef.current = index;
  const current: QuestionDeckEntry | undefined = deck[index];

  useEffect(() => {
    // The deck can load after mount (notification backfill): honour the entry param once.
    if (!seededRef.current && deck.length > 0) {
      seededRef.current = true;
      const key = initialPageKey(deck, notificationId);
      if (key) { setPageKey(key); return; }
    }
    if (found < 0 && current) setPageKey(current.key);
  }, [deck, found, current, notificationId]);

  const [sending, setSending] = useState(false);
  // The send result is applied once the pins are released, against the live deck at that render, so
  // "m left" and the send-all close see arrivals and failed items that came back.
  const [outcome, setOutcome] = useState<{ sent: number; clean: boolean; firstFailedKey: string | null } | null>(null);
  const sendingRef = useRef(false);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [legacyErrors, setLegacyErrors] = useState<LegacyError[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  // qc-rise: .25s opacity + 4px translateY on mount and on every page change.
  const rise = useRef(new Animated.Value(0)).current;
  const currentKey = current?.key;
  useEffect(() => {
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [currentKey, rise]);
  const riseStyle = {
    opacity: rise,
    transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
  };

  const scrollRef = useRef<ScrollView>(null);
  const answeredKeys = flow.answered;
  const sendable = useMemo(() => sendableKeys(deck, answeredKeys), [deck, answeredKeys]);
  const total = deck.length;
  const sendCount = sendable.size;
  // T11/T13 follow "any page answered"; k counts only what can be sent now (a multi-item legacy
  // action is sendable once all of its items are answered).
  const anyAnswered = deck.some((entry) => !entry.locked && answeredKeys.has(entry.key));
  const allDone = flow.allAnswered;
  const isLast = index === total - 1;

  const close = () => router.back();
  const seeChat = (streamId: string) => performChatOpenNavigation(streamId, router);
  // P6 voice answers (docs/QUESTIONS_OVERLAY.md § Voice answers): one take across the durable
  // pages. Done and a confirmed discard both leave the overlay; neither answers anything.
  const voice = useVoiceAnswers({
    deck: liveDeck,
    currentKey: current?.key ?? null,
    onFinished: close,
    onDiscarded: close,
    notify: showToast,
    navigation,
  });

  const submit = async () => {
    if (sendingRef.current || sendCount === 0) return;
    sendingRef.current = true;
    setSending(true);
    setInFlight({ snapshot: deck, pinned: new Set(sendable) });
    setItemErrors((previous) => {
      const next = { ...previous };
      sendable.forEach((key) => { delete next[key]; });
      return next;
    });
    const snapshot = deck;
    const answers = new Map<string, MobileQuestionAnswer>();
    flowEntries.forEach((entry) => { if (sendable.has(entry.key)) answers.set(entry.key, flow.answerFor(entry)); });
    try {
      const result = await submitDeckAnswers({ actions, deck: snapshot, answers });
      if (!mounted.current) return;
      if (result.failed.length > 0) {
        setItemErrors((previous) => ({
          ...previous,
          ...Object.fromEntries(result.failed.map((failure) => [failure.key, failure.message || FALLBACK_ERROR])),
        }));
      }
      if (result.legacyFailed.length > 0) {
        setLegacyErrors((previous) => [
          ...previous,
          ...result.legacyFailed
            .filter((failure) => !previous.some((error) => error.actionId === failure.actionId))
            .map((failure) => ({
              actionId: failure.actionId,
              streamId: failure.streamId,
              title: snapshot.find((entry) => entry.key === failure.keys[0])?.sessionTitle ?? '',
            })),
        ]);
      }
      const firstFailed = snapshot.find((entry) => result.failed.some((failure) => failure.key === entry.key));
      setOutcome({
        sent: result.sent.length,
        clean: result.failed.length === 0 && result.legacyFailed.length === 0,
        firstFailedKey: firstFailed?.key ?? null,
      });
    } finally {
      sendingRef.current = false;
      if (mounted.current) {
        setSending(false);
        setInFlight(null);
      }
    }
  };

  useEffect(() => {
    if (!outcome || inFlight) return;
    setOutcome(null);
    const remaining = liveDeck.length;
    // T15 / a deck emptied by this screen's own send closes the overlay; failures or questions that
    // arrived during the send keep it open.
    if (outcome.clean && remaining === 0) {
      close();
      return;
    }
    if (outcome.sent > 0) showToast(`Sent ${outcome.sent} answer${outcome.sent === 1 ? '' : 's'} · ${remaining} left`);
    const failedKey = outcome.firstFailedKey && liveDeck.some((entry) => entry.key === outcome.firstFailedKey)
      ? outcome.firstFailedKey
      : null;
    setPageKey(failedKey ?? liveDeck[0]?.key ?? null);
  }, [outcome, inFlight, liveDeck]); // eslint-disable-line react-hooks/exhaustive-deps

  const topPad = Math.max(insets.top, 12) + 8;
  const legacyBanner = legacyErrors.length > 0 ? (
    <View style={styles.legacyErrors}>
      {legacyErrors.map((error, position) => (
        <View key={error.actionId} style={styles.legacyError}>
          <Text testID={suffixed('questions-legacy-error', position)} style={styles.legacyErrorText}>
            {`Answer to ${error.title} couldn't be sent — retry it from that chat`}
          </Text>
          <View style={styles.legacyActions}>
            <Pressable
              testID={suffixed('questions-legacy-see-chat', position)}
              accessibilityRole="button"
              onPress={() => seeChat(error.streamId)}
              style={styles.seeChat}
            >
              <Text style={styles.seeChatText}>See chat ›</Text>
            </Pressable>
            <Pressable
              testID={suffixed('questions-legacy-dismiss', position)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => setLegacyErrors((previous) => previous.filter((item) => item.actionId !== error.actionId))}
              style={styles.legacyDismiss}
            >
              <Text style={styles.legacyDismissText}>×</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  ) : null;

  const voiceBar = voice.recording ? (
    <VoiceAnswerBar
      k={voice.progress.k}
      n={voice.progress.n}
      confirming={voice.confirming}
      finishing={voice.finishing}
      onDone={() => { void voice.done(); }}
      onKeep={voice.keepRecording}
      onDiscard={() => { void voice.confirmDiscard(); }}
    />
  ) : null;
  const voiceAccessory = voice.available ? (
    <VoiceMicButton recording={voice.recording} onPress={() => { void (voice.recording ? voice.done() : voice.start()); }} />
  ) : null;

  const closeButton = (
    <Pressable
      testID="questions-close"
      accessibilityRole="button"
      accessibilityLabel="Close questions"
      onPress={voice.recording ? voice.requestDiscard : close}
      style={styles.closeButton}
    >
      <Text style={styles.closeText}>×</Text>
    </Pressable>
  );

  if (!current) {
    return (
      <View testID="questions-overlay" accessibilityViewIsModal style={styles.root}>
        <Starfield />
        <View style={[styles.header, { paddingTop: topPad, borderBottomColor: Tokens.palette.line }]}>
          <View style={styles.headerCopy} />
          <View testID="questions-header-accessory" style={styles.accessory}>{voiceAccessory}</View>
          {closeButton}
        </View>
        <View testID="questions-empty" style={styles.empty}>
          <Text style={styles.emptyText}>No questions waiting</Text>
        </View>
        {legacyBanner}
        {voiceBar ? <View style={styles.voiceDock}>{voiceBar}</View> : null}
      </View>
    );
  }

  const accent = current.accent;
  const entry = flowEntries[index];
  const error = itemErrors[current.key];
  const outlineSubmit = !(allDone || isLast);
  const voicePageState = voice.pageState(current.key);
  return (
    <Animated.View testID="questions-overlay" accessibilityViewIsModal style={styles.root}>
      <Starfield />
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: `${accent}33` }]}>
        <SourceMark isBart={current.isBart} assistantSigil={assistant.sigilKind} machineName={current.machineName} accent={accent} size={32} />
        <View style={styles.headerCopy}>
          <Text testID="questions-counter" style={[styles.counter, { color: accent }]}>{`QUESTION ${index + 1} / ${total}`}</Text>
          <Text testID="questions-subtitle" numberOfLines={1} style={styles.subtitle}>
            {current.isBart ? assistant.name : `${current.machineLabel} · ${current.sessionTitle}`}
          </Text>
        </View>
        {current.isBart ? null : (
          <Pressable
            testID="questions-see-chat"
            accessibilityRole="button"
            onPress={() => seeChat(current.streamId)}
            style={styles.seeChat}
          >
            <Text style={styles.seeChatText}>See chat ›</Text>
          </Pressable>
        )}
        <View testID="questions-header-accessory" style={styles.accessory}>{voiceAccessory}</View>
        {closeButton}
      </View>
      <Animated.View style={[styles.bodyWrap, riseStyle]}>
        <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            ref={scrollRef}
            key={current.key}
            testID="questions-scroll"
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            <MobileQuestionOne
              entry={entry}
              draft={flow.draftFor(current.key)}
              accent={accent}
              disabled={current.locked || sending}
              onChange={(draft) => flow.setDraft(current.key, draft)}
              onInputFocus={() => requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))}
              testPrefix="questions"
            />
            {error ? <Text testID="questions-item-error" style={styles.warning}>{error}</Text> : null}
            {voicePageState ? <VoicePageLabel state={voicePageState} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
      {legacyBanner}
      {toast ? (
        <View pointerEvents="none" style={[styles.toastDock, voice.recording && styles.toastDockVoice]}>
          <Text testID="questions-toast" style={styles.toast}>{toast}</Text>
        </View>
      ) : null}
      <View style={[styles.footer, { borderTopColor: `${accent}22`, paddingBottom: 26 + insets.bottom }]}>
        {voiceBar}
        <DeckDots entries={deck} activeIndex={index} answered={answeredKeys} onChange={(next) => setPageKey(deck[next]?.key ?? null)} />
        <View style={styles.actions}>
          {index > 0 ? (
            <Pressable
              testID="questions-back"
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={() => setPageKey(deck[index - 1].key)}
              style={[styles.navButton, styles.backButton, { borderColor: `${accent}55` }]}
            >
              <Chevron color={accent} flip />
            </Pressable>
          ) : null}
          {anyAnswered ? (
            <Pressable
              testID="questions-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: sending || sendCount === 0 }}
              disabled={sending || sendCount === 0}
              onPress={() => { void submit(); }}
              style={[
                styles.navButton,
                (allDone || isLast) && styles.grow,
                { borderColor: accent, backgroundColor: outlineSubmit ? 'transparent' : accent },
                (sending || sendCount === 0) && styles.sending,
              ]}
            >
              <Text testID="questions-submit-label" style={[styles.navText, { color: outlineSubmit ? accent : Tokens.palette.ink }]}>
                {sending ? 'Sending' : (allDone ? 'Send all answers' : `Submit ${sendCount} of ${total}`)}
              </Text>
            </Pressable>
          ) : null}
          {!isLast ? (
            <Pressable
              testID="questions-next"
              accessibilityRole="button"
              onPress={() => setPageKey(deck[index + 1].key)}
              style={[styles.navButton, styles.grow, { borderColor: accent, backgroundColor: allDone ? 'transparent' : accent }]}
            >
              <Text style={[styles.navText, { color: allDone ? accent : Tokens.palette.ink }]}>Next</Text>
              <Chevron color={allDone ? accent : Tokens.palette.ink} />
            </Pressable>
          ) : null}
          {isLast && !anyAnswered ? (
            <Pressable
              testID="questions-unanswered"
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
              disabled
              style={[styles.navButton, styles.grow, styles.unanswered]}
            >
              <Text testID="questions-unanswered-label" style={[styles.navText, { color: Tokens.palette.dim }]}>{`${total} unanswered`}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  header: { paddingHorizontal: 16, paddingBottom: 13, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 1 },
  headerCopy: { flex: 1, minWidth: 0, gap: 1 },
  counter: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 11, letterSpacing: 1.5 },
  subtitle: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 13 },
  seeChat: { flexShrink: 0, borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, paddingVertical: 6, paddingHorizontal: 8 },
  seeChatText: { color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.bold, fontSize: 13 },
  accessory: { flexShrink: 0 },
  closeButton: { width: 34, height: 34, flexShrink: 0, borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: Tokens.palette.dim, fontSize: 24, fontWeight: '200' },
  bodyWrap: { flex: 1, zIndex: 1 },
  body: { flex: 1 },
  bodyContent: { paddingVertical: 20, paddingHorizontal: 16, gap: 14 },
  warning: { color: Tokens.palette.amber, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10, marginTop: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  emptyText: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.semiBold, fontSize: 18 },
  legacyErrors: { paddingHorizontal: 16, paddingBottom: 8, gap: 6, zIndex: 1 },
  legacyError: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: Tokens.palette.amber, borderRadius: 4, padding: 8 },
  legacyErrorText: { flex: 1, color: Tokens.palette.amber, fontFamily: Fonts.rajdhani.semiBold, fontSize: 13 },
  legacyActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legacyDismiss: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  legacyDismissText: { color: Tokens.palette.dim, fontSize: 20 },
  toastDock: { position: 'absolute', left: 16, right: 16, bottom: 150, zIndex: 3 },
  toastDockVoice: { bottom: 196 },
  voiceDock: { paddingHorizontal: 16, paddingBottom: 26, zIndex: 1 },
  toast: { textAlign: 'center', fontFamily: Fonts.rajdhani.bold, fontSize: 14, color: Tokens.palette.ink, backgroundColor: Tokens.palette.green, borderRadius: 4, paddingVertical: 9, paddingHorizontal: 12, overflow: 'hidden' },
  footer: { borderTopWidth: 1, paddingTop: 12, paddingHorizontal: 16, gap: 13, backgroundColor: Tokens.palette.ink, zIndex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: 4, paddingVertical: 12, paddingHorizontal: 14 },
  backButton: { backgroundColor: 'transparent', paddingHorizontal: 12 },
  grow: { flex: 1 },
  navText: { fontFamily: Fonts.rajdhani.bold, fontSize: 15.5 },
  unanswered: { backgroundColor: 'transparent', borderColor: Tokens.palette.line },
  sending: { opacity: 0.6 },
  flip: { transform: [{ scaleX: -1 }] },
});
