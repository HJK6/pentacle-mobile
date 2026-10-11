import React from 'react';
import { uuid } from 'expo-modules-core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import QuestionsRoute from '../../app/pentacle/questions';
import { QuestionsScreen, selectPendingQuestionCount, selectQuestionDeck } from '../../src/components/questions';
import {
  buildVoiceAnswersMeta, refreshVoiceQuestionSession, activeVoiceQuestionSession, voiceQuestionSnapshot, startVoiceQuestionSession, completeVoiceQuestionSession, freezeVoiceQuestionAnswers, voiceAnswersItemCount, validVoiceAnswersItems, validVoiceQuestionSnapshot, createVoiceQuestionSnapshot,
  installVoiceAnswersCarrier,
  resetVoiceAnswersForTests,
} from '../../src/components/questions/voice/voiceAnswersBinding';
import { makeRecorderHarness } from './voiceHarness';
import { ASSISTANT_STREAM_ID } from '../../src/services/assistantIdentity';
import {
  BART,
  HIDDEN_SEAT,
  HOSTS_CONFIG,
  LEGACY_SESSION,
  SESSION_B,
  SESSION_C,
  baseState,
  durableQuestion,
  legacyQuestion,
  session,
} from './fixtures';

let mockState: any;
const mockListeners = new Set<() => void>();
let mockOptimisticCounter = 0;
const mockActions: Record<string, jest.Mock> = {};
let mockHarness: ReturnType<typeof makeRecorderHarness>;
const mockDeliveryDiscard = jest.fn();

// A navigation object that emits `beforeRemove` the way react-navigation does for a swipe-dismiss:
// the removal proceeds (the listener's `defaultPrevented` stays false) unless a listener prevents it.
const mockNavigation = (() => {
  const listeners = new Set<(event: any) => void>();
  return {
    dispatch: jest.fn(),
    addListener: jest.fn((type: string, listener: (event: any) => void) => {
      if (type === 'beforeRemove') listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    listenerCount: () => listeners.size,
    // Returns whether a listener prevented the removal.
    emitBeforeRemove(action: unknown = { type: 'POP', source: 'swipe' }) {
      let prevented = false;
      const event = { data: { action }, preventDefault: () => { prevented = true; } };
      listeners.forEach((listener) => listener(event));
      return prevented;
    },
    reset() { listeners.clear(); this.dispatch.mockClear(); this.addListener.mockClear(); },
  };
})();

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => ({
  ...require('../helpers/mocks/expoRouter').makeMock({ getParams: () => ({}) }),
  useNavigation: () => mockNavigation,
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../../src/services/chatOpenNavigation', () => ({ performChatOpenNavigation: jest.fn() }));
jest.mock('../../src/services/voiceRecordingEngine', () => ({
  get voiceRecorder() { return mockHarness.recorder; },
}));
jest.mock('../../src/components/voice/VoiceRecordingOverlay', () => ({ __esModule: true, default: () => null, useSharedVoiceControlsActive: () => false }));
jest.mock('../../src/services/voiceDelivery', () => ({
  voiceDelivery: { discard: (...args: unknown[]) => mockDeliveryDiscard(...args) },
}));
jest.mock('../../src/services/pentacleStream', () => {
  const actual = jest.requireActual('../../src/services/pentacleStream');
  const ReactActual = require('react');
  return {
    ...actual,
    getPentacleStreamState: () => mockState,
    voiceTransportSnapshot: () => ({ ready: mockState.connected, inventoryFresh: mockState.hasHydrated, authNeeded: false }),
    usePentacleStreamSelector: (selector: (state: unknown) => unknown) => {
      const [, force] = ReactActual.useReducer((value: number) => value + 1, 0);
      ReactActual.useEffect(() => {
        mockListeners.add(force);
        return () => { mockListeners.delete(force); };
      }, []);
      return selector(mockState);
    },
    usePentacleStreamSelectorWhen: (_enabled: boolean, selector: (state: unknown) => unknown) => selector(mockState),
    usePentacleStreamActions: () => mockActions,
  };
});

const expoRouter = jest.requireMock('expo-router');
const { back: mockBack } = expoRouter.__mock;

function notify() { act(() => { mockListeners.forEach((listener) => listener()); }); }
function setState(next: any) { mockState = next; notify(); }

function installActions() {
  mockActions.beginOptimisticQuestionAnswer = jest.fn(() => `opt-${++mockOptimisticCounter}`);
  mockActions.answerPrompt = jest.fn().mockResolvedValue(undefined);
  mockActions.queueOptimisticQuestionAnswer = jest.fn();
  mockActions.discardOptimisticQuestionAnswer = jest.fn();
  mockActions.dismissQuestion = jest.fn().mockResolvedValue(undefined);
  mockActions.sendMessage = jest.fn().mockResolvedValue(undefined);
}

// Three durable questions (Host C session, Host B session, Bart) + one legacy keyed question.
function threeDurableOneLegacy(extraNotifications: unknown[] = []) {
  return baseState({
    sessions: [
      session(SESSION_C, 'Deploy lane', { last_event_at: '2026-10-06T12:05:00.000Z' }),
      session(SESSION_B, 'Code review', { last_event_at: '2026-10-06T12:04:00.000Z' }),
      session(LEGACY_SESSION, 'Legacy chat', { last_event_at: '2026-10-06T12:03:00.000Z', question: legacyQuestion() }),
      session(BART, 'Bart', { last_event_at: '2026-10-06T12:00:00.000Z' }),
    ],
    notifications: [
      durableQuestion(SESSION_C, 'n-deploy'),
      durableQuestion(SESSION_B, 'n-review'),
      durableQuestion(BART, 'n-bart'),
      ...extraNotifications,
    ],
  });
}
const deckKeys = () => selectQuestionDeck(mockState).map((entry) => entry.key);
const legacyKey = () => selectQuestionDeck(mockState).find((entry) => entry.action.kind === 'legacy')!.key;
const durableKeys = () => selectQuestionDeck(mockState).filter((entry) => entry.action.kind === 'durable').map((entry) => entry.key);
const goTo = (index: number) => { fireEvent.press(screen.getByTestId(`questions-dot-${index}`)); };
const goToKey = (key: string) => goTo(deckKeys().indexOf(key));
const text = (testID: string) => {
  const children = screen.getByTestId(testID).props.children;
  return Array.isArray(children) ? children.join('') : String(children);
};
async function flush() { for (let i = 0; i < 25; i += 1) await Promise.resolve(); }
async function press(testID: string) {
  await act(async () => { fireEvent.press(screen.getByTestId(testID)); await flush(); });
}
function dwell(ms: number) { act(() => { jest.advanceTimersByTime(ms); }); }
async function startVoice() { await press('questions-voice-mic'); }

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG;
  mockOptimisticCounter = 0;
  mockListeners.clear();
  installActions();
  mockBack.mockClear();
  mockDeliveryDiscard.mockClear();
  mockNavigation.reset();
  mockHarness = makeRecorderHarness();
  resetVoiceAnswersForTests();
  installVoiceAnswersCarrier();
  mockState = { connected: true, hasHydrated: true, ...threeDurableOneLegacy() };
});
afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

describe('mic (V1, C7 header accessory)', () => {
  test('the mic sits in the header accessory slot', () => {
    render(<QuestionsScreen />);
    const accessory = screen.getByTestId('questions-header-accessory');
    expect(accessory.children.length).toBeGreaterThan(0);
    expect(screen.getByTestId('questions-voice-mic')).toBeTruthy();
    expect(screen.queryByTestId('questions-voice-bar')).toBeNull();
  });

  test('hidden without the voice send leg that carries meta.voice_answers', () => {
    resetVoiceAnswersForTests();
    render(<QuestionsScreen />);
    expect(screen.queryByTestId('questions-voice-mic')).toBeNull();
    expect(screen.getByTestId('questions-header-accessory').children).toHaveLength(0);
  });

  test('hidden when the deck has no durable pages (legacy only)', () => {
    mockState = baseState({
      sessions: [session(LEGACY_SESSION, 'Legacy chat', { question: legacyQuestion() })],
    });
    render(<QuestionsScreen />);
    expect(screen.getByTestId('questions-counter')).toBeTruthy();
    expect(screen.queryByTestId('questions-voice-mic')).toBeNull();
  });

  test('starting records one take bound to the assistant thread (V6) and shows the bar', async () => {
    render(<QuestionsScreen />);
    await startVoice();
    expect(mockHarness.recorder.activeStreamId()).toBe(BART);
    expect(screen.getByTestId('questions-voice-bar')).toBeTruthy();
    expect(text('questions-voice-progress')).toBe('0 of 3 answered by voice');
    expect(text('questions-voice-elapsed')).toBe('0:00');
    expect(screen.getByTestId('questions-voice-wave')).toBeTruthy();
    expect(screen.getByTestId('questions-voice-done')).toBeTruthy();
    expect(text('questions-voice-page-label')).toBe('RECORDING YOUR ANSWER…');
  });

  test('a busy recorder (the composer is recording) shows a notice and starts nothing', async () => {
    await mockHarness.recorder.start('hosta:other');
    render(<QuestionsScreen />);
    await startVoice();
    expect(screen.queryByTestId('questions-voice-bar')).toBeNull();
    expect(text('questions-toast')).toMatch(/recording/i);
  });

  test('a denied microphone shows a notice and starts nothing', async () => {
    mockHarness.engine.permission = 'denied';
    render(<QuestionsScreen />);
    await startVoice();
    expect(screen.queryByTestId('questions-voice-bar')).toBeNull();
    expect(mockHarness.recorder.isActive()).toBe(false);
    expect(text('questions-toast')).toMatch(/microphone/i);
  });
});

describe('segments and coverage (V1)', () => {
  test('a page flips to ANSWER RECORDED once its segment reaches 1.5 s', async () => {
    render(<QuestionsScreen />);
    await startVoice();
    dwell(1400);
    expect(text('questions-voice-page-label')).toBe('RECORDING YOUR ANSWER…');
    expect(text('questions-voice-progress')).toBe('0 of 3 answered by voice');
    dwell(200);
    expect(text('questions-voice-page-label')).toBe('ANSWER RECORDED');
    expect(text('questions-voice-progress')).toBe('1 of 3 answered by voice');
  });

  test('a page flipped through in under 1.5 s is not covered', async () => {
    render(<QuestionsScreen />);
    await startVoice();
    dwell(1000);
    goTo(1);
    dwell(1700);
    expect(text('questions-voice-progress')).toBe('1 of 3 answered by voice');
    goTo(0);
    expect(text('questions-voice-page-label')).toBe('RECORDING YOUR ANSWER…');
  });

  test('fixture 3 durable + 1 legacy covering 2 durable reads "2 of 3 answered by voice"; legacy shows ANSWER BY TAP', async () => {
    render(<QuestionsScreen />);
    const durable = durableKeys();
    expect(durable).toHaveLength(3);
    await startVoice();
    goToKey(durable[0]); dwell(2000);
    goToKey(legacyKey()); dwell(5000);
    expect(text('questions-voice-page-label')).toBe('ANSWER BY TAP');
    goToKey(durable[1]); dwell(2000);
    expect(text('questions-voice-progress')).toBe('2 of 3 answered by voice');
  });

  test('arrivals during the recording are excluded from n, k and the page label', async () => {
    render(<QuestionsScreen />);
    await startVoice();
    const before = deckKeys();
    setState({ ...mockState, notifications: [...mockState.notifications, durableQuestion(SESSION_B, 'n-late')] });
    const arrival = deckKeys().find((key) => !before.includes(key))!;
    goToKey(arrival);
    dwell(4000);
    expect(text('questions-voice-page-label')).toBe('ANSWER BY TAP');
    expect(text('questions-voice-progress')).toBe('0 of 3 answered by voice');
  });
});

describe('Done (V1 selected set, V2 binding, V5 no false answers)', () => {
  async function recordTwoAndDone() {
    const durable = durableKeys();
    goToKey(durable[0]); await startVoice(); dwell(2000);
    goToKey(durable[1]); dwell(3000);
    await press('questions-voice-done');
    return durable;
  }

  test('Done stops the take, closes the overlay and registers the frozen binding for that recording', async () => {
    render(<QuestionsScreen />);
    const durable = await recordTwoAndDone();
    expect(mockHarness.stopped).toHaveLength(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
    const take = mockHarness.stopped[0];
    expect(take.streamId).toBe(BART);
    const meta = buildVoiceAnswersMeta(take.recordingId, { blobSha: 'sha256:blob', durationS: take.durationS })!;
    expect(meta).toMatchObject({ version: 1, recording_id: take.recordingId, blob_sha: 'sha256:blob', duration_s: take.durationS });
    expect(meta.items.map((item) => item.key)).toEqual([durable[0], durable[1]]);
    expect(meta.items[0]).toEqual({
      key: durable[0],
      question_id: expect.stringMatching(/^q-n-/),
      notification_id: expect.stringMatching(/^n-/),
      producer_stream_id: expect.any(String),
      surface_stream_id: expect.any(String),
      prompt: expect.stringMatching(/Prompt for n-/),
      segment: { start_s: 0, end_s: 2 },
    });
    expect(meta.items[1].segment).toEqual({ start_s: 2, end_s: 5 });
  });

  test('legacy pages and uncovered durable pages are never in the binding', async () => {
    render(<QuestionsScreen />);
    const durable = durableKeys();
    await startVoice();
    goToKey(legacyKey()); dwell(3000);
    goToKey(durable[2]); dwell(2000);
    await press('questions-voice-done');
    const meta = buildVoiceAnswersMeta(mockHarness.stopped[0].recordingId, { blobSha: 's', durationS: 5 })!;
    expect(meta.items.map((item) => item.key)).toEqual([durable[2]]);
  });

  test('a surfaced hidden-seat question binds producer and surface ids separately', async () => {
    const surfaced = durableQuestion(HIDDEN_SEAT, 'n-hidden', { surfaced_to_stream_id: BART });
    mockState = baseState({
      sessions: [session(BART, 'Bart'), session(HIDDEN_SEAT, 'Hidden seat', { visibility: 'hidden' })],
      notifications: [surfaced],
    });
    render(<QuestionsScreen />);
    await startVoice(); dwell(2000);
    await press('questions-voice-done');
    const meta = buildVoiceAnswersMeta(mockHarness.stopped[0].recordingId, { blobSha: 's', durationS: 2 })!;
    expect(meta.items).toHaveLength(1);
    expect(meta.items[0]).toMatchObject({ producer_stream_id: HIDDEN_SEAT, surface_stream_id: BART, notification_id: 'n-hidden' });
  });

  test('arrivals are never selected even after a long dwell; pages answered elsewhere drop out of the binding', async () => {
    render(<QuestionsScreen />);
    const durable = durableKeys();
    goToKey(durable[0]); await startVoice(); dwell(2000);
    goToKey(durable[1]); dwell(2000);
    const before = deckKeys();
    setState({
      ...mockState,
      notifications: [
        ...mockState.notifications.filter((n: any) => n.notification_id !== 'n-review' && n.notification_id !== 'n-deploy'),
        durableQuestion(SESSION_B, 'n-late'),
        { ...durableQuestion(SESSION_C, 'n-deploy') },
      ],
    });
    const after = deckKeys();
    const arrival = after.find((key) => !before.includes(key))!;
    goToKey(arrival); dwell(5000);
    await press('questions-voice-done');
    const meta = buildVoiceAnswersMeta(mockHarness.stopped[0].recordingId, { blobSha: 's', durationS: 9 })!;
    const keys = meta.items.map((item) => item.key);
    expect(keys).not.toContain(arrival);
    expect(keys).not.toContain(before.find((key) => key.startsWith('n-review')));
  });

  test('Done never answers a question or changes the count (V5): no prompt.answer, no optimistic answer, same deck', async () => {
    render(<QuestionsScreen />);
    const countBefore = selectPendingQuestionCount(mockState);
    await recordTwoAndDone();
    expect(selectPendingQuestionCount(mockState)).toBe(countBefore);
    expect(deckKeys()).toHaveLength(4);
    expect(mockActions.answerPrompt).not.toHaveBeenCalled();
    expect(mockActions.beginOptimisticQuestionAnswer).not.toHaveBeenCalled();
    expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
  });

  test('Done with zero covered pages discards the take, closes nothing and registers no binding', async () => {
    render(<QuestionsScreen />);
    await startVoice();
    dwell(1000);
    await press('questions-voice-done');
    expect(mockHarness.engine.discarded).toBe(true);
    expect(mockHarness.stopped).toHaveLength(0);
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockHarness.recorder.isActive()).toBe(false);
    expect(screen.queryByTestId('questions-voice-bar')).toBeNull();
    expect(text('questions-toast')).toMatch(/discarded/i);
  });

  test('a failed stop keeps the recording open and registers nothing', async () => {
    render(<QuestionsScreen />);
    await startVoice(); dwell(2500);
    mockHarness.engine.stopFails = true;
    await press('questions-voice-done');
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('questions-voice-bar')).toBeTruthy();
    expect(buildVoiceAnswersMeta(mockHarness.recorder.snapshot()!.recordingId, { blobSha: 's', durationS: 1 })).toBeNull();
  });

  test('a cap freezes the same selection and retains an unsent question take', async () => {
    render(<QuestionsScreen />);
    await startVoice(); dwell(2500);
    await act(async () => { await mockHarness.recorder.stop('cap'); await flush(); });
    const meta = buildVoiceAnswersMeta(mockHarness.stopped[0].recordingId, { blobSha: 's', durationS: 3 })!;
    expect(meta.items).toHaveLength(1);
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('questions-voice-bar')).toBeTruthy();
  });

  test('an automatic stop with nothing covered retains the unsent take until explicit action', async () => {
    render(<QuestionsScreen />);
    await startVoice(); dwell(500);
    await act(async () => { await mockHarness.recorder.stop('background'); await flush(); });
    expect(mockDeliveryDiscard).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('discard (V1)', () => {
  test('✕ while recording asks first; keeping continues the take', async () => {
    render(<QuestionsScreen />);
    await startVoice(); dwell(2000);
    await press('questions-close');
    expect(screen.getByTestId('questions-voice-confirm')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockHarness.engine.discarded).toBe(false);
    await press('questions-voice-keep');
    expect(screen.queryByTestId('questions-voice-confirm')).toBeNull();
    expect(mockHarness.recorder.isActive()).toBe(true);
    expect(text('questions-voice-progress')).toBe('1 of 3 answered by voice');
  });

  test('confirming the discard drops the take, uploads and marks nothing, and closes the overlay', async () => {
    render(<QuestionsScreen />);
    await startVoice(); dwell(2000);
    await press('questions-close');
    await press('questions-voice-discard');
    expect(mockHarness.engine.discarded).toBe(true);
    expect(mockHarness.stopped).toHaveLength(0);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockActions.answerPrompt).not.toHaveBeenCalled();
  });

  test('✕ while not recording closes immediately (P4 behaviour)', async () => {
    render(<QuestionsScreen />);
    await press('questions-close');
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('questions-voice-confirm')).toBeNull();
  });

  test('unmounting mid-recording preserves the process-owned take', async () => {
    const view = render(<QuestionsScreen />);
    await startVoice(); dwell(2000);
    view.unmount();
    await act(async () => { await flush(); });
    expect(mockHarness.engine.discarded).toBe(false);
    expect(mockHarness.recorder.isActive()).toBe(true);
    expect(mockHarness.stopped).toHaveLength(0);
  });
});

describe('route-level dismissal (V1: leaving a live take asks first)', () => {
  const SWIPE = { type: 'POP', source: 'swipe-dismiss' };

  test('a live take: the dismissal is prevented and the Keep/Discard confirmation shows', async () => {
    render(<QuestionsRoute />);
    await startVoice(); dwell(2000);
    let prevented = false;
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(true);
    expect(screen.getByTestId('questions-voice-confirm')).toBeTruthy();
    expect(mockHarness.engine.discarded).toBe(false);
    expect(mockHarness.recorder.isActive()).toBe(true);
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  });

  test('Keep keeps recording and the dismissal stays cancelled', async () => {
    render(<QuestionsRoute />);
    await startVoice(); dwell(2000);
    act(() => { mockNavigation.emitBeforeRemove(SWIPE); });
    await press('questions-voice-keep');
    expect(screen.queryByTestId('questions-voice-confirm')).toBeNull();
    expect(mockHarness.recorder.isActive()).toBe(true);
    expect(text('questions-voice-progress')).toBe('1 of 3 answered by voice');
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    // The kept take is still guarded.
    let prevented = false;
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(true);
  });

  test('Discard drops the take and leaves by dispatching the original removal action', async () => {
    render(<QuestionsRoute />);
    await startVoice(); dwell(2000);
    act(() => { mockNavigation.emitBeforeRemove(SWIPE); });
    await press('questions-voice-discard');
    expect(mockHarness.engine.discarded).toBe(true);
    expect(mockHarness.stopped).toHaveLength(0);
    expect(mockNavigation.dispatch).toHaveBeenCalledTimes(1);
    expect(mockNavigation.dispatch).toHaveBeenCalledWith(SWIPE);
    expect(mockActions.answerPrompt).not.toHaveBeenCalled();
    // The dispatched action is no longer blocked.
    let prevented = true;
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(false);
  });

  test('a dismissal while the ✕ confirmation is already open stays prevented and Discard still leaves by the dismissal', async () => {
    render(<QuestionsRoute />);
    await startVoice(); dwell(2000);
    await press('questions-close');
    let prevented = false;
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(true);
    await press('questions-voice-discard');
    expect(mockNavigation.dispatch).toHaveBeenCalledWith(SWIPE);
    expect(mockBack).not.toHaveBeenCalled();
  });

  test('no live take: the dismissal leaves normally and nothing is asked or discarded', async () => {
    render(<QuestionsRoute />);
    let prevented = true;
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(false);
    expect(screen.queryByTestId('questions-voice-confirm')).toBeNull();
    await startVoice(); dwell(2000);
    await press('questions-voice-done');
    // After Done the take belongs to the voice send leg: leaving is not blocked.
    act(() => { prevented = mockNavigation.emitBeforeRemove(SWIPE); });
    expect(prevented).toBe(false);
    expect(mockHarness.engine.discarded).toBe(false);
  });
});

describe('n is the full durable deck at recording start (V1, legacy excluded only)', () => {
  // 2 durable (one without a resolver id: it cannot be bound) + 1 legacy.
  function unbindableFixture() {
    const unbindable = durableQuestion(SESSION_B, 'n-unbindable');
    (unbindable.question as any).question_id = undefined;
    return baseState({
      sessions: [
        session(SESSION_C, 'Deploy lane', { last_event_at: '2026-10-06T12:05:00.000Z' }),
        session(SESSION_B, 'Code review', { last_event_at: '2026-10-06T12:04:00.000Z' }),
        session(LEGACY_SESSION, 'Legacy chat', { last_event_at: '2026-10-06T12:03:00.000Z', question: legacyQuestion() }),
        session(BART, 'Bart', { last_event_at: '2026-10-06T12:00:00.000Z' }),
      ],
      notifications: [durableQuestion(SESSION_C, 'n-deploy'), unbindable],
    });
  }
  const unbindableKey = () => selectQuestionDeck(mockState).find((entry) => entry.action.kind === 'durable' && !entry.questionId)!.key;

  test('2 durable incl. 1 unbindable + 1 legacy, covering the bindable one, reads "1 of 2 answered by voice"', async () => {
    mockState = unbindableFixture();
    render(<QuestionsScreen />);
    const bindable = durableKeys().find((key) => key !== unbindableKey())!;
    expect(durableKeys()).toHaveLength(2);
    await startVoice();
    expect(text('questions-voice-progress')).toBe('0 of 2 answered by voice');
    goToKey(bindable); dwell(2000);
    expect(text('questions-voice-progress')).toBe('1 of 2 answered by voice');
  });

  test('the unbindable durable page keeps ANSWER BY TAP, is never covered and is never bound', async () => {
    mockState = unbindableFixture();
    render(<QuestionsScreen />);
    const bindable = durableKeys().find((key) => key !== unbindableKey())!;
    await startVoice();
    goToKey(unbindableKey()); dwell(5000);
    expect(text('questions-voice-page-label')).toBe('ANSWER BY TAP');
    expect(text('questions-voice-progress')).toBe('0 of 2 answered by voice');
    goToKey(bindable); dwell(2000);
    await press('questions-voice-done');
    const meta = buildVoiceAnswersMeta(mockHarness.stopped[0].recordingId, { blobSha: 's', durationS: 7 })!;
    expect(meta.items.map((item) => item.key)).toEqual([bindable]);
  });
});

test('R8 delayed background observation never freezes question time beyond native captured audio', async () => {
  render(<QuestionsScreen />);
  await startVoice();
  const recordingId = mockHarness.recorder.snapshot()!.recordingId;
  // Native capture ended after 2 seconds, but JS observes the background stop 60 seconds later.
  // This uses the existing stop and hook ingress rather than inventing a baseline pause API.
  jest.spyOn(mockHarness.engine, 'poll').mockReturnValue({ level: 0.5, durationMs: 2000 });
  jest.spyOn(mockHarness.engine, 'stop').mockResolvedValue({ uri: 'file:///tmp/p6-take.m4a', durationMs: 2000, bytes: 1000 });
  dwell(62000);
  await act(async () => { await mockHarness.recorder.stop('background'); await flush(); });
  const meta = buildVoiceAnswersMeta(recordingId, { blobSha: 'synthetic-sha', durationS: 2 });
  expect(meta?.items.every(item => item.segment.end_s <= 2) ?? true).toBe(true);
});

test('R8 background stop does not automatically finish question delivery', async () => {
  render(<QuestionsScreen />);
  await startVoice(); dwell(2000);
  await act(async () => { await mockHarness.recorder.stop('background'); await flush(); });
  expect(mockBack).not.toHaveBeenCalled();
});


test('R8 conformance: a short visit plus sixty seconds paused contributes no answer', async () => {
  render(<QuestionsScreen />); await startVoice(); dwell(1000);
  await act(async () => { await mockHarness.recorder.pause('background'); await flush(); });
  dwell(60000);
  expect(text('questions-voice-progress')).toBe('0 of 3 answered by voice');
  expect(mockHarness.recorder.snapshot()?.capturedAudioMs).toBe(1000);
  await act(async () => { await mockHarness.recorder.resume(); await flush(); });
  dwell(600);
  // Pause closed the 1s visit; this new 0.6s visit does not aggregate with it.
  expect(text('questions-voice-progress')).toBe('0 of 3 answered by voice');
});

test('R8 conformance: global Send freezes question binding before the stopped subscriber', async () => {
  render(<QuestionsScreen />); await startVoice(); dwell(2100);
  const id = mockHarness.recorder.snapshot()!.recordingId;
  let observed: unknown;
  mockHarness.recorder.subscribeStopped(take => { observed = buildVoiceAnswersMeta(take.recordingId, { blobSha: 's', durationS: take.durationS }); });
  await act(async () => { await mockHarness.recorder.send(); await flush(); });
  expect(observed).toMatchObject({ recording_id: id, items: [expect.objectContaining({ segment: { start_s: 0, end_s: 2.1 } })] });
  expect(mockBack).toHaveBeenCalledTimes(1);
});

test('R8 conformance: global Discard releases the process question session', async () => {
  render(<QuestionsScreen />); await startVoice(); dwell(2100);
  const id = mockHarness.recorder.snapshot()!.recordingId;
  await act(async () => { await mockHarness.recorder.discard(); await flush(); });
  expect(buildVoiceAnswersMeta(id, { blobSha: 's', durationS: 3 })).toBeNull();
  expect(screen.queryByTestId('questions-voice-bar')).toBeNull();
  expect(mockBack).toHaveBeenCalledTimes(1);
});

test('R8 durable validators reject malformed visits and duplicate answer keys without throwing', () => {
  const item = { key: 'question:0', question_id: 'question', notification_id: 'notification', producer_stream_id: 'hosta:worker', surface_stream_id: 'hosta:chat', prompt: 'Synthetic prompt' };
  const snapshot = createVoiceQuestionSnapshot([item], 1, item.key, [item.key]);
  expect(validVoiceQuestionSnapshot(snapshot)).toBe(true);
  expect(validVoiceQuestionSnapshot({ ...snapshot, visits: [null] })).toBe(false);
  expect(validVoiceQuestionSnapshot({ ...snapshot, visits: [{ key: item.key, startMs: 0, endMs: Infinity }] })).toBe(false);
  const answer = { ...item, segment: { start_s: 0, end_s: 2 } };
  expect(validVoiceAnswersItems([answer], 2000)).toBe(true);
  expect(validVoiceAnswersItems([answer, answer], 2000)).toBe(false);
  expect(validVoiceAnswersItems([answer], 1999)).toBe(false);
});

test('CAP-05 a held finalized question session does not block current-scope capture; terminal cleanup releases only the held binding', async () => {
  const held = '123e4567-e89b-42d3-a456-000000000999';
  const item = { key: 'held:0', question_id: 'held-q', notification_id: 'held', producer_stream_id: 'hosta:worker', surface_stream_id: ASSISTANT_STREAM_ID, prompt: 'Held synthetic question' };
  startVoiceQuestionSession(held, { ...createVoiceQuestionSnapshot([item], 1, item.key, [item.key]), phase: 'finalized', capturedAudioMs: 2500, visits: [{ key: item.key, startMs: 0, endMs: 2500 }] });
  freezeVoiceQuestionAnswers(held, 2500);
  jest.spyOn(mockHarness.recorder, 'isOwnedByCurrentScope').mockImplementation(id => id !== held);
  render(<QuestionsScreen />); await startVoice();
  const current = mockHarness.recorder.snapshot()!.recordingId;
  expect(current).not.toBe(held); expect(voiceAnswersItemCount(held)).toBe(1); expect(voiceQuestionSnapshot(held)).toBeDefined();
  await act(async () => { completeVoiceQuestionSession(held, 'discarded'); });
  expect(voiceAnswersItemCount(held)).toBe(0); expect(voiceQuestionSnapshot(held)).toBeUndefined();
  expect(activeVoiceQuestionSession()?.recordingId).toBe(current);
  await act(async () => { await mockHarness.recorder.discard(); });
});

test('CAP-05 capped answers then scope switch and committed held discard permit the next question take', async () => {
  render(<QuestionsScreen />); await startVoice(); dwell(2500);
  const held = mockHarness.recorder.snapshot()!.recordingId;
  await act(async () => { await mockHarness.recorder.stop('cap'); });
  expect(mockHarness.recorder.isActive()).toBe(false);
  jest.spyOn(mockHarness.recorder, 'isOwnedByCurrentScope').mockImplementation(id => id !== held);
  await act(async () => { refreshVoiceQuestionSession(held); });
  await act(async () => { completeVoiceQuestionSession(held, 'discarded'); });
  expect(activeVoiceQuestionSession()).toBeNull(); expect(voiceAnswersItemCount(held)).toBe(0);
  jest.mocked(uuid.v4).mockReturnValueOnce('123e4567-e89b-42d3-a456-000000000123');
  await startVoice(); expect(mockHarness.recorder.isActive()).toBe(true);
  expect(screen.getByTestId('questions-voice-bar')).toBeTruthy();
  await act(async () => { await mockHarness.recorder.discard(); });
});

test('CAP-03 unavailable question inventory cannot erase previously covered capture eligibility', async () => {
  render(<QuestionsScreen />); await startVoice(); dwell(2500);
  const id = mockHarness.recorder.snapshot()!.recordingId;
  const prior = voiceQuestionSnapshot(id)!;
  setState({ ...mockState, sessions: [], notifications: [], connected: false, hasHydrated: false });
  expect(voiceQuestionSnapshot(id)!.liveKeys).toEqual(prior.liveKeys);
  await act(async () => { await mockHarness.recorder.send(); });
  expect(buildVoiceAnswersMeta(id, { blobSha: 'synthetic', durationS: 3 })?.items.length).toBeGreaterThan(0);
});
