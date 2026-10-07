import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import QuestionsRoute from '../../app/pentacle/questions';
import { QuestionsScreen } from '../../src/components/questions';
import { resetVoiceAnswersForTests } from '../../src/components/questions/voice/voiceAnswersBinding';
import { performChatOpenNavigation } from '../../src/services/chatOpenNavigation';
import {
  SESSION_B,
  BART,
  HOSTS_CONFIG,
  LEGACY_SESSION,
  SESSION_C,
  baseState,
  durableQuestion,
  fixtureState,
  legacyQuestion,
  session,
} from './fixtures';

let mockParams: Record<string, unknown> = {};
let mockState: any;
const mockListeners = new Set<() => void>();
let mockOptimisticCounter = 0;
const mockActions: Record<string, jest.Mock> = {};

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => ({
  ...require('../helpers/mocks/expoRouter').makeMock({ getParams: () => mockParams }),
  useNavigation: () => ({ addListener: () => () => undefined, dispatch: () => undefined }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../../src/services/chatOpenNavigation', () => ({ performChatOpenNavigation: jest.fn() }));
jest.mock('../../src/services/pentacleStream', () => {
  const actual = jest.requireActual('../../src/services/pentacleStream');
  const ReactActual = require('react');
  return {
    ...actual,
    usePentacleStreamSelector: (selector: (state: unknown) => unknown) => {
      const [, force] = ReactActual.useReducer((value: number) => value + 1, 0);
      ReactActual.useEffect(() => {
        mockListeners.add(force);
        return () => { mockListeners.delete(force); };
      }, []);
      return selector(mockState);
    },
    // The assistant identity hook reads the same test state.
    usePentacleStreamSelectorWhen: (_enabled: boolean, selector: (state: unknown) => unknown) => selector(mockState),
    usePentacleStreamActions: () => mockActions,
  };
});

const expoRouter = jest.requireMock('expo-router');
// The fixture's assistant session title; the overlay shows the shared assistant identity
// (display_name, then title, then 'Assistant'; docs/bart_home_contracts.md § Assistant identity).
const FIXTURE_ASSISTANT_TITLE = 'Bart';
const { back: mockBack } = expoRouter.__mock;
const mockNavigate = performChatOpenNavigation as jest.Mock;

const LINE = 'rgba(120,255,160,0.16)';
const GREEN = '#3dff66';
const ACCENT_C = '#1f5bff';
const ACCENT_B = '#ff2e3e';

function notify() {
  act(() => { mockListeners.forEach((listener) => listener()); });
}
function setState(next: any) {
  mockState = next;
  notify();
}
function patchState(patch: (state: any) => any) {
  setState(patch(mockState));
}

function installActions() {
  mockActions.beginOptimisticQuestionAnswer = jest.fn(({ text }: { text: string }) => {
    const id = `opt-${++mockOptimisticCounter}`;
    mockState = {
      ...mockState,
      optimisticSends: { ...mockState.optimisticSends, [id]: { optimistic_id: id, text, status: 'queued', stream_id: 'x' } },
    };
    notify();
    return id;
  });
  mockActions.answerPrompt = jest.fn().mockResolvedValue(undefined);
  mockActions.queueOptimisticQuestionAnswer = jest.fn();
  mockActions.discardOptimisticQuestionAnswer = jest.fn((id: string) => {
    const { [id]: _removed, ...rest } = mockState.optimisticSends;
    mockState = { ...mockState, optimisticSends: rest };
    notify();
  });
  mockActions.dismissQuestion = jest.fn(async ({ sessionName }: { sessionName: string }) => {
    mockState = {
      ...mockState,
      sessions: mockState.sessions.map((s: any) => (s.session_name === sessionName ? { ...s, question: null } : s)),
    };
    notify();
  });
  mockActions.sendMessage = jest.fn().mockResolvedValue(undefined);
}

// Three single-item durable questions: Host C session (blue), Host B session (red), Bart (green).
function threeState() {
  return baseState({
    sessions: [
      session(SESSION_C, 'Deploy lane', { last_event_at: '2026-10-06T12:05:00.000Z' }),
      session(SESSION_B, 'Code review', { last_event_at: '2026-10-06T12:04:00.000Z' }),
      session(BART, 'Bart', { last_event_at: '2026-10-06T12:00:00.000Z' }),
    ],
    notifications: [
      durableQuestion(SESSION_C, 'n-deploy'),
      durableQuestion(SESSION_B, 'n-review'),
      durableQuestion(BART, 'n-bart'),
    ],
  });
}

const style = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);
const text = (testID: string) => {
  const children = screen.getByTestId(testID).props.children;
  return Array.isArray(children) ? children.join('') : String(children);
};
const counter = () => text('questions-counter');
const answerCurrentPage = () => { fireEvent.press(screen.getByTestId('questions-option-1')); };
const goTo = (index: number) => { fireEvent.press(screen.getByTestId(`questions-dot-${index}`)); };

// Lets the serial submit chain (several awaited promises) settle inside act.
async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}
async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
    await flush();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG;
  mockParams = {};
  mockOptimisticCounter = 0;
  mockListeners.clear();
  installActions();
  mockBack.mockClear();
  mockNavigate.mockClear();
  mockState = threeState();
});
afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

describe('header (T2–T7)', () => {
  test('T3/T4: counter text and "Machine · session title" subtitle for the first page', () => {
    render(<QuestionsScreen />);
    expect(counter()).toBe('QUESTION 1 / 3');
    expect(text('questions-subtitle')).toBe('Host C · Deploy lane');
    expect(style('questions-counter').color).toBe(ACCENT_C);
  });

  test('T3/T4: the assistant page reads the assistant identity name (default "Assistant", R-ident), uses the lamp green and hides See chat', () => {
    render(<QuestionsScreen />);
    goTo(2);
    expect(counter()).toBe('QUESTION 3 / 3');
    expect(text('questions-subtitle')).toBe(FIXTURE_ASSISTANT_TITLE);
    expect(style('questions-counter').color).toBe(GREEN);
    expect(screen.queryByTestId('questions-see-chat')).toBeNull();
  });

  test('the assistant page follows a renamed assistant session and defaults to Assistant', () => {
    const renamed = (patch: Record<string, unknown>) => ({ ...mockState,
      sessions: mockState.sessions.map((item: any) => (item.stream_id === 'bart:assistant' ? { ...item, ...patch } : item)) });
    mockState = renamed({ display_name: 'Lews' });
    const view = render(<QuestionsScreen />);
    goTo(2);
    expect(text('questions-subtitle')).toBe('Lews');
    view.unmount();
    mockState = renamed({ display_name: '', title: '' });
    render(<QuestionsScreen />);
    goTo(2);
    expect(text('questions-subtitle')).toBe('Assistant');
  });

  test('T5: See chat navigates through performChatOpenNavigation to the entry stream and never pushes an href', () => {
    render(<QuestionsScreen />);
    fireEvent.press(screen.getByTestId('questions-see-chat'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toBe(SESSION_C);
    expect(mockNavigate.mock.calls[0][1]).toBe(expoRouter.router);
    expect(expoRouter.__mock.push).not.toHaveBeenCalled();
    goTo(1);
    fireEvent.press(screen.getByTestId('questions-see-chat'));
    expect(mockNavigate.mock.calls[1][0]).toBe(SESSION_B);
  });

  test('T6/C7: without the voice send leg there is no mic; the accessory slot is empty before the close button (voice: voiceAnswers.test.tsx)', () => {
    resetVoiceAnswersForTests();
    render(<QuestionsScreen />);
    expect(screen.queryByLabelText(/voice|mic/i)).toBeNull();
    expect(screen.getByTestId('questions-header-accessory').children).toHaveLength(0);
  });

  test('T7/AC7: close calls router.back() once, sends nothing and marks nothing answered', async () => {
    render(<QuestionsScreen />);
    answerCurrentPage();
    await press('questions-close');
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockActions.answerPrompt).not.toHaveBeenCalled();
    expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
    expect(mockActions.beginOptimisticQuestionAnswer).not.toHaveBeenCalled();
    expect(Object.keys(mockState.optimisticSends)).toHaveLength(0);
  });
});

describe('footer state machine (T10–T13)', () => {
  const pages = [0, 1, 2];
  const answeredCounts = [0, 1, 3];

  // For each (page, answered-count): answered pages are the first `count` pages so "all" is every page.
  test.each(pages.flatMap((page) => answeredCounts.map((count) => [page, count] as const)))(
    'page %i with %i answered',
    (page, count) => {
      render(<QuestionsScreen />);
      for (let i = 0; i < count; i += 1) { goTo(i); answerCurrentPage(); }
      goTo(page);
      const last = page === 2;
      const all = count === 3;

      // T10 Back: only when not on the first page.
      expect(!!screen.queryByTestId('questions-back')).toBe(page > 0);
      if (page > 0) expect(style('questions-back').borderColor).toBe(`${style('questions-counter').color}55`);

      // T11 Submit: shown once >= 1 answered.
      expect(!!screen.queryByTestId('questions-submit')).toBe(count > 0);
      if (count > 0) {
        const accent = [ACCENT_C, ACCENT_B, GREEN][page];
        const submit = style('questions-submit');
        expect(text('questions-submit-label')).toBe(all ? 'Send all answers' : `Submit ${count} of 3`);
        // Filled when last page or all answered; outline otherwise.
        expect(submit.backgroundColor).toBe(last || all ? accent : 'transparent');
        expect(submit.borderColor).toBe(accent);
        if (last || all) expect(submit.flex).toBe(1);
      }

      // T12 Next: when not last; filled unless all answered.
      expect(!!screen.queryByTestId('questions-next')).toBe(!last);
      if (!last) {
        const accent = [ACCENT_C, ACCENT_B, GREEN][page];
        expect(style('questions-next').backgroundColor).toBe(all ? 'transparent' : accent);
      }

      // T13 last page with nothing answered: disabled "n unanswered".
      const unanswered = screen.queryByTestId('questions-unanswered');
      expect(!!unanswered).toBe(last && count === 0);
      if (unanswered) {
        expect(text('questions-unanswered-label')).toBe('3 unanswered');
        expect(unanswered.props.accessibilityState?.disabled).toBe(true);
      }
    },
  );

  test('a bounded multi-select that violates its constraint does not count as answered', () => {
    mockState = baseState({
      sessions: [session(LEGACY_SESSION, 'Legacy chat', {
        question: legacyQuestion({ multiSelect: true, min_select: 2, options: [{ index: 1, label: 'X' }, { index: 2, label: 'Y' }] }),
      })],
    });
    render(<QuestionsScreen />);
    answerCurrentPage(); // one of two required selections
    expect(screen.queryByTestId('questions-submit')).toBeNull();
    expect(screen.getByTestId('questions-unanswered')).toBeTruthy();
    expect(screen.getByTestId('questions-constraint')).toBeTruthy();
    fireEvent.press(screen.getByTestId('questions-option-2'));
    expect(screen.getByTestId('questions-submit')).toBeTruthy();
  });
});

describe('dots (T9)', () => {
  test('one dot per page; active is 22 wide in its accent; answered is accent+66; others are the line color; tap navigates', () => {
    render(<QuestionsScreen />);
    goTo(1);
    answerCurrentPage(); // page 2 (Host B) answered; then leave it
    goTo(0);

    expect(screen.getAllByTestId(/^questions-dot-\d+$/)).toHaveLength(3);
    expect(style('questions-dot-0')).toMatchObject({ width: 22, backgroundColor: ACCENT_C });
    expect(style('questions-dot-1')).toMatchObject({ width: 8, backgroundColor: `${ACCENT_B}66` });
    expect(style('questions-dot-2')).toMatchObject({ width: 8, backgroundColor: LINE });

    goTo(2);
    expect(counter()).toBe('QUESTION 3 / 3');
    expect(style('questions-dot-2')).toMatchObject({ width: 22, backgroundColor: GREEN });
    expect(style('questions-dot-0')).toMatchObject({ width: 8, backgroundColor: LINE });
    goTo(1);
    expect(counter()).toBe('QUESTION 2 / 3');
    // Active wins over answered.
    expect(style('questions-dot-1')).toMatchObject({ width: 22, backgroundColor: ACCENT_B });
  });
});

describe('partial submit (T14, AC4)', () => {
  test('sends only answered items, toasts "Sent 1 answer · 2 left" for 2200 ms and resets to page 1', async () => {
    render(<QuestionsScreen />);
    goTo(1);
    answerCurrentPage();
    expect(text('questions-submit-label')).toBe('Submit 1 of 3');
    await press('questions-submit');

    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(1);
    expect(mockActions.answerPrompt.mock.calls[0][0]).toMatchObject({ questionId: 'q-n-review', selections: ['yes'] });
    expect(mockBack).not.toHaveBeenCalled();
    expect(text('questions-toast')).toBe('Sent 1 answer · 2 left');
    expect(counter()).toBe('QUESTION 1 / 2');
    expect(text('questions-subtitle')).toBe('Host C · Deploy lane');
    expect(screen.queryByTestId('questions-dot-2')).toBeNull();

    act(() => { jest.advanceTimersByTime(2199); });
    expect(screen.queryByTestId('questions-toast')).not.toBeNull();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.queryByTestId('questions-toast')).toBeNull();
  });

  test('pluralises: "Sent 2 answers · 1 left"', async () => {
    render(<QuestionsScreen />);
    goTo(0); answerCurrentPage();
    goTo(2); answerCurrentPage();
    await press('questions-submit');
    expect(text('questions-toast')).toBe('Sent 2 answers · 1 left');
    expect(counter()).toBe('QUESTION 1 / 1');
  });

  test('Submit is disabled while sending (no double send)', async () => {
    let release: () => void = () => undefined;
    mockActions.answerPrompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<QuestionsScreen />);
    goTo(1); answerCurrentPage();
    await press('questions-submit');
    expect(screen.getByTestId('questions-submit').props.accessibilityState?.disabled).toBe(true);
    expect(text('questions-submit-label')).toBe('Sending');
    await press('questions-submit');
    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await flush(); });
    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(1);
  });

  test('a failed item stays on its page with its draft and error; k counts only acked items; remaining items still send', async () => {
    mockActions.answerPrompt.mockRejectedValueOnce(new Error('daemon offline')).mockResolvedValue(undefined);
    render(<QuestionsScreen />);
    goTo(0); answerCurrentPage();
    goTo(1); answerCurrentPage();
    await press('questions-submit');

    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(2);
    expect(text('questions-toast')).toBe('Sent 1 answer · 2 left');
    // Sent item (Host B) left; the failed Host C item is still page 1 with its draft and error.
    expect(counter()).toBe('QUESTION 1 / 2');
    expect(text('questions-subtitle')).toBe('Host C · Deploy lane');
    expect(text('questions-item-error')).toBe('daemon offline');
    expect(screen.getByTestId('questions-option-1').props.accessibilityState.checked).toBe(true);
  });

  test('a multi-item notification: sending one item leaves the other page in place', async () => {
    mockState = fixtureState();
    render(<QuestionsScreen />);
    expect(counter()).toBe('QUESTION 1 / 6');
    answerCurrentPage(); // n-deploy:0
    await press('questions-submit');
    expect(mockActions.answerPrompt.mock.calls[0][0].questionId).toBe('q-n-deploy-a');
    expect(text('questions-toast')).toBe('Sent 1 answer · 5 left');
    expect(counter()).toBe('QUESTION 1 / 5');
    expect(text('questions-prompt')).toBe('n-deploy second?');
  });
});

describe('legacy send failure (C4)', () => {
  test('the dismissed question leaves the deck, is not counted in k, and a persistent error with See chat remains', async () => {
    mockState = fixtureState();
    mockActions.sendMessage.mockRejectedValueOnce(new Error('socket closed'));
    render(<QuestionsScreen />);
    goTo(2); answerCurrentPage(); // n-review:0
    goTo(3); answerCurrentPage(); // legacy
    expect(counter()).toBe('QUESTION 4 / 6');
    await press('questions-submit');

    // ama acked (1 sent); legacy answer failed after dismiss, so it left the deck and is not in k.
    expect(text('questions-toast')).toBe('Sent 1 answer · 4 left');
    expect(counter()).toBe('QUESTION 1 / 4');
    expect(text('questions-legacy-error')).toBe("Answer to Legacy chat couldn't be sent — retry it from that chat");
    fireEvent.press(screen.getByTestId('questions-legacy-see-chat'));
    expect(mockNavigate).toHaveBeenCalledWith(LEGACY_SESSION, expoRouter.router);

    // Persists past the toast, and past paging, until dismissed.
    act(() => { jest.advanceTimersByTime(5000); });
    goTo(1);
    expect(screen.getByTestId('questions-legacy-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('questions-legacy-dismiss'));
    expect(screen.queryByTestId('questions-legacy-error')).toBeNull();
  });

  test('when the legacy failure empties the deck the overlay stays open on the empty state with the error', async () => {
    mockState = baseState({ sessions: [session(LEGACY_SESSION, 'Legacy chat', { question: legacyQuestion() })] });
    mockActions.sendMessage.mockRejectedValueOnce(new Error('socket closed'));
    render(<QuestionsScreen />);
    answerCurrentPage();
    await press('questions-submit');
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('questions-empty')).toBeTruthy();
    expect(screen.getByTestId('questions-legacy-error')).toBeTruthy();
  });
});

describe('send all (T15, AC5)', () => {
  test('all items resolve -> every item sent and router.back() once', async () => {
    render(<QuestionsScreen />);
    for (let i = 0; i < 3; i += 1) { goTo(i); answerCurrentPage(); }
    expect(text('questions-submit-label')).toBe('Send all answers');
    await press('questions-submit');
    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(3);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('one failure keeps the overlay open on the first failed page with draft and error; succeeded items are gone', async () => {
    mockActions.answerPrompt
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('rejected by daemon'))
      .mockResolvedValue(undefined);
    render(<QuestionsScreen />);
    for (let i = 0; i < 3; i += 1) { goTo(i); answerCurrentPage(); }
    await press('questions-submit');

    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(3);
    expect(mockBack).not.toHaveBeenCalled();
    expect(counter()).toBe('QUESTION 1 / 1');
    expect(text('questions-subtitle')).toBe('Host B · Code review');
    expect(text('questions-item-error')).toBe('rejected by daemon');
    expect(screen.getByTestId('questions-option-1').props.accessibilityState.checked).toBe(true);
    expect(screen.queryByTestId('questions-dot-1')).toBeNull();
  });

  test('retrying the failed item sends it again and closes the overlay once it resolves', async () => {
    mockActions.answerPrompt.mockRejectedValueOnce(new Error('flaky')).mockResolvedValue(undefined);
    mockState = baseState({
      sessions: [session(SESSION_B, 'Code review')],
      notifications: [durableQuestion(SESSION_B, 'n-review')],
    });
    render(<QuestionsScreen />);
    answerCurrentPage();
    await press('questions-submit');
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('questions-item-error')).toBeTruthy();
    await press('questions-submit');
    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(2);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

describe('empty state and entry param (C5)', () => {
  test('zero pending shows "No questions waiting" with a working close', async () => {
    mockState = baseState({ sessions: [session(BART, 'Bart')] });
    render(<QuestionsScreen />);
    expect(within(screen.getByTestId('questions-empty')).getByText('No questions waiting')).toBeTruthy();
    expect(screen.queryByTestId('questions-counter')).toBeNull();
    await press('questions-close');
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('notificationId opens on the first page of that notification when still pending', () => {
    mockState = fixtureState();
    render(<QuestionsScreen notificationId="n-review" />);
    expect(counter()).toBe('QUESTION 3 / 6');
    expect(text('questions-subtitle')).toBe('Host B · Code review');
  });

  test('a multi-item notification opens on its first item', () => {
    mockState = fixtureState();
    render(<QuestionsScreen notificationId="n-deploy" />);
    expect(counter()).toBe('QUESTION 1 / 6');
  });

  test('an unknown notificationId opens page 1', () => {
    render(<QuestionsScreen notificationId="n-does-not-exist" />);
    expect(counter()).toBe('QUESTION 1 / 3');
  });

  test('the route reads notificationId from the route params and renders the overlay', () => {
    mockParams = { notificationId: 'n-bart' };
    render(<QuestionsRoute />);
    expect(counter()).toBe('QUESTION 3 / 3');
    expect(text('questions-subtitle')).toBe(FIXTURE_ASSISTANT_TITLE);
    expect(expoRouter.__mock.stackScreens).toHaveBeenCalledWith(expect.objectContaining({
      options: { presentation: 'transparentModal', animation: 'fade' },
    }));
  });
});

describe('live data (AC8)', () => {
  test('a question answered elsewhere disappears, and the current page is tracked by key', () => {
    render(<QuestionsScreen />);
    goTo(2); // Bart
    expect(counter()).toBe('QUESTION 3 / 3');
    patchState((state) => ({
      ...state,
      notifications: state.notifications.filter((n: any) => n.notification_id !== 'n-deploy'),
    }));
    expect(counter()).toBe('QUESTION 2 / 2');
    expect(text('questions-subtitle')).toBe(FIXTURE_ASSISTANT_TITLE);
  });

  test('a new question arriving appends without moving the current page', () => {
    render(<QuestionsScreen />);
    goTo(1);
    patchState((state) => ({
      ...state,
      sessions: [...state.sessions, session('hostb:codex:new', 'Late arrival', { last_event_at: '2020-01-01T00:00:00.000Z' })],
      notifications: [...state.notifications, durableQuestion('hostb:codex:new', 'n-new')],
    }));
    expect(counter()).toBe('QUESTION 2 / 4');
    expect(text('questions-subtitle')).toBe('Host B · Code review');
    expect(screen.getAllByTestId(/^questions-dot-\d+$/)).toHaveLength(4);
  });

  test('when the current page vanishes the page index is clamped', () => {
    render(<QuestionsScreen />);
    goTo(2);
    patchState((state) => ({
      ...state,
      notifications: state.notifications.filter((n: any) => n.notification_id !== 'n-bart'),
    }));
    expect(counter()).toBe('QUESTION 2 / 2');
    expect(text('questions-subtitle')).toBe('Host B · Code review');
  });

  test('a deck emptied by the daemon shows the empty state', () => {
    render(<QuestionsScreen />);
    patchState((state) => ({ ...state, notifications: [] }));
    expect(screen.getByTestId('questions-empty')).toBeTruthy();
    expect(within(screen.getByTestId('questions-empty')).getByText(/No questions waiting/)).toBeTruthy();
  });
});

describe('final-QA regressions (cycle 1)', () => {
  test('T11/T13: a partly answered multi-item legacy action shows a disabled "Submit 0 of n", never "n unanswered"', () => {
    mockState = baseState({
      sessions: [session(LEGACY_SESSION, 'Legacy chat', {
        question: legacyQuestion({
          multi: true,
          questions: [
            { index: 1, prompt: 'First legacy?', options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] },
            { index: 2, prompt: 'Second legacy?', options: [{ index: 1, label: 'Red' }, { index: 2, label: 'Blue' }] },
          ],
        }),
      })],
    });
    render(<QuestionsScreen />);
    answerCurrentPage();
    goTo(1);
    expect(counter()).toBe('QUESTION 2 / 2');
    expect(screen.queryByTestId('questions-unanswered')).toBeNull();
    expect(text('questions-submit-label')).toBe('Submit 0 of 2');
    expect(screen.getByTestId('questions-submit').props.accessibilityState?.disabled).toBe(true);
  });

  async function holdFirstAnswer() {
    let release: () => void = () => undefined;
    mockActions.answerPrompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    return () => release();
  }
  function arrive() {
    patchState((state) => ({
      ...state,
      notifications: [...state.notifications, durableQuestion(SESSION_B, 'n-arrival', { created_at: '2026-10-06T13:00:00.000Z' })],
    }));
  }

  test('AC8/T14: a question arriving during a partial send is shown at once and counted in "m left"', async () => {
    const release = await holdFirstAnswer();
    render(<QuestionsScreen />);
    goTo(1); answerCurrentPage();
    await press('questions-submit');
    arrive();
    expect(screen.queryByTestId('questions-dot-3')).not.toBeNull();
    await act(async () => { release(); await flush(); });
    expect(text('questions-toast')).toBe('Sent 1 answer · 3 left');
    expect(counter()).toBe('QUESTION 1 / 3');
  });

  test('AC5/AC8: send-all does not close when a question arrived during the send; it stays open on it', async () => {
    const release = await holdFirstAnswer();
    render(<QuestionsScreen />);
    for (let i = 0; i < 3; i += 1) { goTo(i); answerCurrentPage(); }
    await press('questions-submit');
    arrive();
    await act(async () => { release(); await flush(); });
    expect(mockActions.answerPrompt).toHaveBeenCalledTimes(3);
    expect(mockBack).not.toHaveBeenCalled();
    expect(counter()).toBe('QUESTION 1 / 1');
    expect(text('questions-toast')).toBe('Sent 3 answers · 1 left');
  });
});
