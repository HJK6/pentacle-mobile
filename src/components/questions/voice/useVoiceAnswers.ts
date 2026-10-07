import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BackHandler } from 'react-native';

import { agentQuestionStreamId, agentQuestionSurfaceStreamId } from '../../../services/agentQuestionNotifications';
import { PermissionDeniedError, RecorderBusyError, type FinishedRecording } from '../../../services/voiceRecording';
import { voiceRecorder } from '../../../services/voiceRecordingEngine';
import { voiceDelivery } from '../../../services/voiceDelivery';
import { BART_STREAM_ID } from '../../status/statusSelectors';
import type { QuestionDeckEntry } from '../questionSelectors';
import { SegmentTracker } from './segments';
import {
  isVoiceAnswersCarrierInstalled,
  registerVoiceAnswersBinding,
  releaseVoiceAnswersBinding,
  type VoiceAnswersItem,
} from './voiceAnswersBinding';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'confirming' | 'finishing';
export type VoicePageState = 'recording' | 'recorded' | 'tap' | null;

// The producer (asker) of a durable deck page, or '' when the page cannot be bound.
function producerOf(entry: QuestionDeckEntry) {
  return entry.action.kind === 'durable' ? agentQuestionStreamId(entry.action.model.notification) : '';
}

// Voice scope (v1): durable items with a resolver id and an asker. Legacy keyed pages are
// answered by tap only.
export function isVoiceEligible(entry: QuestionDeckEntry) {
  return entry.action.kind === 'durable' && !!entry.questionId && !!producerOf(entry);
}

function bindingItem(entry: QuestionDeckEntry, segment: VoiceAnswersItem['segment']): VoiceAnswersItem {
  const action = entry.action as Extract<QuestionDeckEntry['action'], { kind: 'durable' }>;
  return {
    key: entry.key,
    question_id: entry.questionId as string,
    notification_id: action.id,
    producer_stream_id: producerOf(entry),
    surface_stream_id: agentQuestionSurfaceStreamId(action.model.notification) || entry.streamId,
    prompt: entry.question.prompt,
    segment,
  };
}

type Session = {
  recordingId: string;
  t0: number;
  tracker: SegmentTracker;
  startKeys: ReadonlySet<string>;
  finishing: boolean;
};

const START_FAILURE: Record<string, string> = {
  busy: 'Another recording is in progress. Finish it first.',
  denied: 'Microphone access is off. Enable it in Settings.',
  other: 'Could not start recording.',
};

// One recording across the overlay's durable pages (spec § V1). The take is the app's ordinary
// voice recording, bound to the assistant thread; this hook only decides which pages it covers
// and freezes that set as the `voice_answers.v1` binding when the take ends. It never answers a
// question: counts move only when the daemon closes one.
export function useVoiceAnswers({ deck, currentKey, onFinished, onDiscarded, notify, now = Date.now }: {
  // The live deck (pages the daemon still lists as open).
  deck: readonly QuestionDeckEntry[];
  currentKey: string | null;
  // The take was handed to the voice send leg with its binding: close the overlay.
  onFinished: () => void;
  // The take was dropped on the operator's confirmation: close the overlay.
  onDiscarded: () => void;
  notify: (message: string) => void;
  now?: () => number;
}) {
  const recorder = voiceRecorder;
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const phaseRef = useRef<VoicePhase>('idle');
  const deckRef = useRef(deck);
  const currentKeyRef = useRef(currentKey);
  const callbacks = useRef({ onFinished, onDiscarded, notify, now });
  const mounted = useRef(true);
  deckRef.current = deck;
  currentKeyRef.current = currentKey;
  callbacks.current = { onFinished, onDiscarded, notify, now };

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  // Pages covered right now, restricted to pages the daemon still lists (a page answered
  // elsewhere drops out of the take).
  const coveredNow = () => {
    const session = sessionRef.current;
    if (!session) return new Map<string, VoiceAnswersItem['segment']>();
    const live = new Set(deckRef.current.map((entry) => entry.key));
    return new Map([...session.tracker.covered(callbacks.current.now() - session.t0)].filter(([key]) => live.has(key)));
  };

  // The selected set: covered durable pages, in segment order.
  const freeze = (): VoiceAnswersItem[] => {
    const byKey = new Map(deckRef.current.map((entry) => [entry.key, entry]));
    const items: VoiceAnswersItem[] = [];
    for (const [key, segment] of coveredNow()) {
      const entry = byKey.get(key);
      if (entry && isVoiceEligible(entry)) items.push(bindingItem(entry, segment));
    }
    return items;
  };

  const endSession = () => { sessionRef.current = null; setPhase('idle'); };

  const discardTake = async (recordingId?: string) => {
    endSession();
    try { await recorder.discard(); } catch { /* the engine already released the take */ }
    if (recordingId) releaseVoiceAnswersBinding(recordingId);
  };

  const eligibleCount = useMemo(() => deck.filter(isVoiceEligible).length, [deck]);
  const recording = phase === 'recording' || phase === 'confirming' || phase === 'finishing';
  // Hidden until the voice send leg carries the binding, and when no durable page can be bound.
  const available = recording || phase === 'starting' || (isVoiceAnswersCarrierInstalled() && eligibleCount > 0);

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || !isVoiceAnswersCarrierInstalled()) return;
    setPhase('starting');
    let recordingId: string;
    try {
      recordingId = await recorder.start(BART_STREAM_ID);
    } catch (error) {
      if (!mounted.current) return;
      setPhase('idle');
      const kind = error instanceof RecorderBusyError ? 'busy' : error instanceof PermissionDeniedError ? 'denied' : 'other';
      callbacks.current.notify(START_FAILURE[kind]);
      return;
    }
    if (!mounted.current) {
      void recorder.discard().catch(() => undefined);
      return;
    }
    const startKeys = deckRef.current.filter(isVoiceEligible).map((entry) => entry.key);
    if (startKeys.length === 0) {
      void recorder.discard().catch(() => undefined);
      setPhase('idle');
      return;
    }
    const tracker = new SegmentTracker(startKeys);
    const t0 = callbacks.current.now();
    tracker.enter(currentKeyRef.current, 0);
    sessionRef.current = { recordingId, t0, tracker, startKeys: new Set(startKeys), finishing: false };
    setPhase('recording');
  }, [recorder, setPhase]);

  // Page changes close one visit and open the next.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || session.finishing) return;
    session.tracker.enter(currentKey, callbacks.current.now() - session.t0);
    rerender();
  }, [currentKey, phase]);

  // The page being visited becomes covered the moment its visit reaches the threshold.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || (phase !== 'recording' && phase !== 'confirming')) return undefined;
    const wait = session.tracker.msUntilCovered(callbacks.current.now() - session.t0);
    if (wait === null) return undefined;
    const timer = setTimeout(rerender, wait);
    return () => clearTimeout(timer);
  }, [currentKey, phase, deck]);

  const done = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== 'recording') return;
    const items = freeze();
    if (items.length === 0) {
      await discardTake(session.recordingId);
      callbacks.current.notify('No answers recorded. Take discarded.');
      return;
    }
    session.finishing = true;
    setPhase('finishing');
    // Registered before the stop so the voice send leg finds it whenever the transcript lands.
    registerVoiceAnswersBinding(session.recordingId, items);
    try {
      await recorder.stop('tap');
    } catch {
      releaseVoiceAnswersBinding(session.recordingId);
      session.finishing = false;
      if (mounted.current) setPhase('recording');
      callbacks.current.notify("Couldn't stop the recording. Try again.");
      return;
    }
    endSession();
    callbacks.current.onFinished();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder, setPhase]);

  // The recorder also stops itself (5-minute cap, interruption, backgrounding). The take then
  // follows the ordinary voice path, so freeze the binding at that moment.
  useEffect(() => recorder.subscribeStopped((take: FinishedRecording) => {
    const session = sessionRef.current;
    if (!session || session.finishing || take.recordingId !== session.recordingId) return;
    const items = freeze();
    if (items.length === 0) {
      endSession();
      voiceDelivery.discard(take.recordingId);
      callbacks.current.notify('No answers recorded. Take discarded.');
      return;
    }
    registerVoiceAnswersBinding(take.recordingId, items);
    endSession();
    callbacks.current.onFinished();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [recorder]);

  const requestDiscard = useCallback(() => {
    if (phaseRef.current === 'recording') setPhase('confirming');
  }, [setPhase]);
  const keepRecording = useCallback(() => {
    if (phaseRef.current === 'confirming') setPhase('recording');
  }, [setPhase]);
  const confirmDiscard = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== 'confirming') return;
    await discardTake(session.recordingId);
    callbacks.current.onDiscarded();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  // Android back asks before it leaves a live take.
  useEffect(() => {
    if (!recording) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phaseRef.current === 'recording') requestDiscard();
      return true;
    });
    return () => subscription.remove();
  }, [recording, requestDiscard]);

  // Leaving the overlay by any route other than Done discards a live take.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = sessionRef.current;
      if (session && !session.finishing) {
        sessionRef.current = null;
        void recorder.discard().catch(() => undefined);
        releaseVoiceAnswersBinding(session.recordingId);
      }
    };
  }, [recorder]);

  const covered = recording ? coveredNow() : null;
  const session = sessionRef.current;
  const pageState = (key: string): VoicePageState => {
    if (!recording || !session) return null;
    if (!session.startKeys.has(key)) return 'tap';
    return covered?.has(key) ? 'recorded' : 'recording';
  };

  return {
    available,
    phase,
    recording,
    confirming: phase === 'confirming',
    finishing: phase === 'finishing',
    // k of n answered by voice: covered pages vs the durable pages at recording start.
    progress: { k: covered?.size ?? 0, n: session?.startKeys.size ?? 0 },
    pageState,
    start,
    done,
    requestDiscard,
    keepRecording,
    confirmDiscard,
  };
}
