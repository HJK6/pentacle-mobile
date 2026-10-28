import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler } from 'react-native';
import { agentQuestionStreamId, agentQuestionSurfaceStreamId } from '../../../services/agentQuestionNotifications';
import { PermissionDeniedError, RecorderBusyError, NoVoiceAnswersError } from '../../../services/voiceRecording';
import { voiceRecorder, sendVoiceTake, discardVoiceTake } from '../../../services/voiceRecordingEngine';
import { getPentacleStreamState, voiceTransportSnapshot } from '../../../services/pentacleStream';
import { ASSISTANT_STREAM_ID } from '../../../services/assistantIdentity';
import type { QuestionDeckEntry } from '../questionSelectors';
import {
  isVoiceAnswersCarrierInstalled, createVoiceQuestionSnapshot, activeVoiceQuestionSession,
  voiceQuestionSessionRevision, subscribeVoiceQuestionSession, subscribeVoiceQuestionCompletion,
  updateVoiceQuestionPage, coveredVoiceQuestionItems, type VoiceAnswersItem,
} from './voiceAnswersBinding';

// The slice of a react-navigation navigation object the overlay needs to guard its own removal.
export type RemovalGuardNavigation = {
  addListener: (type: 'beforeRemove', listener: (event: {
    data: { action: unknown };
    preventDefault: () => void;
  }) => void) => () => void;
  dispatch: (action: never) => void;
};

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

// React supplies the current page and actions. The process binding owns every visit.
export function useVoiceAnswers({ deck, currentKey, onFinished, onDiscarded, notify, navigation }: {
  deck: readonly QuestionDeckEntry[]; currentKey: string | null;
  onFinished: () => void; onDiscarded: () => void; notify: (message: string) => void;
  navigation?: RemovalGuardNavigation; now?: () => number;
}) {
  useSyncExternalStore(subscribeVoiceQuestionSession, voiceQuestionSessionRevision, voiceQuestionSessionRevision);
  const recorder = voiceRecorder;
  const processSession = activeVoiceQuestionSession();
  const session = processSession && recorder.isOwnedByCurrentScope(processSession.recordingId) ? processSession : null;
  const [localPhase, setLocalPhase] = useState<VoicePhase>('idle');
  const phase = processSession && !session && localPhase !== 'starting' ? 'idle' : localPhase === 'idle' && session ? 'recording' : localPhase;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const callbacks = useRef({ onFinished, onDiscarded, notify }); callbacks.current = { onFinished, onDiscarded, notify };
  const inputs = useRef({ deck, currentKey, navigation }); inputs.current = { deck, currentKey, navigation };
  const observedId = useRef<string | null>(session?.recordingId ?? null);
  if (session) observedId.current = session.recordingId;
  else if (processSession) observedId.current = null;
  const mounted = useRef(true);
  const pendingRemoval = useRef<{ action: unknown } | null>(null);
  const setPhase = useCallback((next: VoicePhase) => { phaseRef.current = next; if (mounted.current) setLocalPhase(next); }, []);
  const recording = !!session && phase !== 'starting';
  const eligibleCount = useMemo(() => deck.filter(isVoiceEligible).length, [deck]);
  const available = recording || phase === 'starting' || (isVoiceAnswersCarrierInstalled() && eligibleCount > 0);

  useEffect(() => {
    if (processSession && !session && localPhase !== 'idle' && localPhase !== 'starting') setPhase('idle');
  }, [processSession?.recordingId, session?.recordingId, localPhase, setPhase]);

  useEffect(() => subscribeVoiceQuestionCompletion(event => {
    if (event.recordingId !== observedId.current || phaseRef.current === 'starting') return;
    observedId.current = null; setPhase('idle');
    if (event.reason === 'no_answers') { pendingRemoval.current = null; callbacks.current.notify('No answers recorded. Take discarded.'); return; }
    const removal = pendingRemoval.current; pendingRemoval.current = null;
    if (event.reason === 'sent') callbacks.current.onFinished();
    else if (removal && inputs.current.navigation) inputs.current.navigation.dispatch(removal.action as never);
    else callbacks.current.onDiscarded();
  }), [setPhase]);

  const start = useCallback(async () => {
    const prior = activeVoiceQuestionSession();
    if (phaseRef.current !== 'idle' || !isVoiceAnswersCarrierInstalled()
      || (prior && (recorder.isActive() || recorder.isOwnedByCurrentScope(prior.recordingId)))) return;
    const current = inputs.current;
    const eligibleItems = current.deck.filter(isVoiceEligible).map(entry => {
      const { segment: _, ...item } = bindingItem(entry, { start_s: 0, end_s: 0 }); return item;
    });
    if (!eligibleItems.length) return;
    const questionBinding = createVoiceQuestionSnapshot(eligibleItems, current.deck.filter(entry => entry.action.kind === 'durable').length, current.currentKey, current.deck.map(entry => entry.key));
    setPhase('starting');
    try {
      const origin = getPentacleStreamState().sessions.find(row => row.stream_id === ASSISTANT_STREAM_ID);
      if (process.env.EXPO_PUBLIC_HARNESS === '1') require('../../../utils/m1Diagnostic').m1Diagnostic('recorder_start', { origin: 'question_voice_answer', operation_kind: 'voice_answer', stream_id: ASSISTANT_STREAM_ID });
      const id = await recorder.start(ASSISTANT_STREAM_ID, { originGeneration: origin?.session_generation ?? null, originLabel: origin?.title || 'Assistant', textPrefix: '', images: [], operationKind: 'voice_answer', questionBinding });
      observedId.current = id;
      if (mounted.current) setPhase('recording');
    } catch (error) {
      if (!mounted.current) return;
      setPhase('idle');
      callbacks.current.notify(error instanceof RecorderBusyError ? 'Another recording is in progress. Finish it first.'
        : error instanceof PermissionDeniedError ? 'Microphone access is off. Enable it in Settings.'
        : 'Could not start recording. Check the original chat and available storage.');
    }
  }, [recorder, setPhase]);

  useEffect(() => {
    const active = activeVoiceQuestionSession(); if (!active || !recorder.isOwnedByCurrentScope(active.recordingId)) return;
    const at = recorder.snapshot()?.recordingId === active.recordingId ? recorder.capturedAudioMs() : active.snapshot.capturedAudioMs;
    const transport = voiceTransportSnapshot();
    const authoritative = getPentacleStreamState().hasHydrated && transport.ready && transport.inventoryFresh && !transport.authNeeded;
    updateVoiceQuestionPage(active.recordingId, currentKey, authoritative ? deck.map(entry => entry.key) : active.snapshot.liveKeys, at);
  }, [currentKey, deck, session?.recordingId, recorder]);

  const done = useCallback(async () => {
    const active = activeVoiceQuestionSession(); if (!active || !recorder.isOwnedByCurrentScope(active.recordingId) || phaseRef.current !== 'recording') return;
    setPhase('finishing');
    try {
      if (recorder.snapshot()?.recordingId === active.recordingId) await recorder.send();
      else await sendVoiceTake(active.recordingId);
    } catch (error) {
      if (error instanceof NoVoiceAnswersError) return;
      if (mounted.current) setPhase('recording');
      callbacks.current.notify("Couldn't save or send the recording. Try again.");
    }
  }, [recorder, setPhase]);
  const requestDiscard = useCallback(() => { if (phaseRef.current === 'recording') setPhase('confirming'); }, [setPhase]);
  const keepRecording = useCallback(() => {
    if (phaseRef.current === 'confirming') { pendingRemoval.current = null; setPhase('recording'); }
  }, [setPhase]);
  const confirmDiscard = useCallback(async () => {
    const active = activeVoiceQuestionSession(); if (!active || !recorder.isOwnedByCurrentScope(active.recordingId) || phaseRef.current !== 'confirming') return;
    try {
      if (recorder.snapshot()?.recordingId === active.recordingId) await recorder.discard();
      else await discardVoiceTake(active.recordingId);
    } catch { callbacks.current.notify('Could not discard the recording. Try again.'); }
  }, [recorder]);

  useEffect(() => {
    if (!recording) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { requestDiscard(); return true; });
    return () => sub.remove();
  }, [recording, requestDiscard]);
  useEffect(() => {
    if (!navigation) return;
    return navigation.addListener('beforeRemove', event => {
      const live = phaseRef.current;
      if (!['recording','confirming','finishing'].includes(live)) return;
      event.preventDefault(); if (live === 'finishing') return;
      pendingRemoval.current = { action: event.data.action }; if (live === 'recording') setPhase('confirming');
    });
  }, [navigation, setPhase]);
  useEffect(() => {
    mounted.current = true;
    // Root lock and ordinary route lifetimes cannot discard the process-owned take.
    return () => { mounted.current = false; };
  }, []);

  const covered = session ? coveredVoiceQuestionItems(session.recordingId) : [];
  const coveredKeys = new Set(covered.map(item => item.key));
  const eligibleKeys = new Set(session?.snapshot.eligibleItems.map(item => item.key) ?? []);
  return { available, phase, recording, confirming: phase === 'confirming', finishing: phase === 'finishing',
    progress: { k: covered.length, n: session?.snapshot.durableTotal ?? 0 },
    pageState: (key: string): VoicePageState => !recording ? null : !eligibleKeys.has(key) ? 'tap' : coveredKeys.has(key) ? 'recorded' : 'recording',
    start, done, requestDiscard, keepRecording, confirmDiscard };
}
