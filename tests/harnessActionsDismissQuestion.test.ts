/**
 * Unit tests for the agent-question L3 action handler in
 * `src/services/harnessActions.ts` (runDismissQuestion). Mocks at module
 * boundaries (telemetry sink, stream sessions, dismissQuestion) so the
 * telemetry sequencing + skip-reason classifier + option-selection default
 * are exercised end-to-end. Mirrors tests/harnessActionsNotifications.test.ts.
 *
 * Spec: spec_pentacle__chat_agent_question_parsing_2026_05_27.
 */
import type { PentacleQuestion, PentacleSessionSummary, TelemetryPayload } from 'pentacle-chat-core';

beforeAll(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
});
afterAll(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
});

type Actions = typeof import('../src/services/harnessActions');
type Telemetry = typeof import('pentacle-chat-core');

let activeTelemetry: Telemetry | null = null;

function loadFreshModules(): { actions: Actions; telemetry: Telemetry } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const telemetry = require('pentacle-chat-core') as Telemetry;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actions = require('../src/services/harnessActions') as Actions;
  activeTelemetry = telemetry;
  // The flowContext.streamId is module-level scratch state; reset between
  // cases so a prior spawn does not scope this case.
  actions.__resetFlowContextForTests();
  return { actions, telemetry };
}

afterEach(() => {
  activeTelemetry?.setTelemetrySink(null);
  activeTelemetry = null;
});

function question(overrides: Partial<PentacleQuestion> = {}): PentacleQuestion {
  return {
    header: 'Pick',
    prompt: 'Pick a number.',
    options: [
      { index: 1, label: '1', meta: false },
      { index: 2, label: '2', meta: false },
      { index: 3, label: 'Type something.', meta: true },
      { index: 4, label: 'Chat about this', meta: true },
    ],
    question_key: 'question-key-one',
    ...overrides,
  } as PentacleQuestion;
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'hostc:claude:one',
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    title: 'Test chat',
    last_event_at: '2026-05-27T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function names(seen: TelemetryPayload[]): string[] {
  return seen.map((p) => p.message);
}

function expectDismissCall(mock: jest.Mock, textFragment: string) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc',
    sessionName: 'one',
    questionKey: 'question-key-one',
    text: expect.stringContaining(textFragment),
  }));
}

describe('runDismissQuestion', () => {
  test('answers an already-pending question (default first non-meta option) and emits scheduled → sent', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => true);

    await actions.runDismissQuestion({
      getSessions: () => [session({ question: question() })],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 1000,
    });

    // No explicit option → the first non-meta option (index 1) is chosen.
    expectDismissCall(dismissQuestion, 'Q1 (Pick): 1');
    expect(names(seen)).toEqual([
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SCHEDULED,
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SENT,
    ]);
  });

  test('uses the explicit option param when provided', async () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);
    const dismissQuestion = jest.fn(async () => true);

    await actions.runDismissQuestion({
      option: 2,
      getSessions: () => [session({ question: question() })],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 1000,
    });

    expectDismissCall(dismissQuestion, 'Q1 (Pick): 2');
  });

  test('forwards builder-shaped dismiss answers and emits answer/free-text counts', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => true);
    const answers = [
      { selectedOptionIndex: 2 },
      { text: 'freeform reply' },
    ];

    await actions.runDismissQuestion({
      answers,
      getSessions: () => [session({ question: question() })],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 1000,
    });

    expectDismissCall(dismissQuestion, 'Q1 (Pick): 2');
    expect(names(seen)).toEqual([
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SCHEDULED,
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SENT,
    ]);
    expect(seen[1].data).toMatchObject({
      stream_id: 'hostc:claude:one',
      answer_count: 2,
      free_text_count: 1,
    });
  });

  test('builder-shaped dismiss answers can target a free-text-only pending question', async () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);
    const dismissQuestion = jest.fn(async () => true);
    const answers = [{ text: 'free text only' }];

    await actions.runDismissQuestion({
      answers,
      getSessions: () => [
        session({
          question: question({
            options: [{ index: 1, label: 'Type something.', meta: true }],
          }),
        }),
      ],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 1000,
    });

    expectDismissCall(dismissQuestion, 'free text only');
  });

  test('waits for a pending question to arrive via subscribe', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => true);

    let current: PentacleSessionSummary[] = [session({ question: null })];
    const listenerRef: { fn: (() => void) | null } = { fn: null };

    const promise = actions.runDismissQuestion({
      option: 2,
      getSessions: () => current,
      subscribe: (cb) => {
        listenerRef.fn = cb;
        return () => {
          listenerRef.fn = null;
        };
      },
      dismissQuestion,
      timeoutMs: 1000,
    });

    // Nothing pending yet → scheduled must NOT have fired.
    expect(names(seen)).toEqual([]);
    // The question arrives on a live inventory frame.
    current = [session({ question: question() })];
    listenerRef.fn?.();
    await promise;

    expectDismissCall(dismissQuestion, 'Q1 (Pick): 2');
    expect(names(seen)).toEqual([
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SCHEDULED,
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SENT,
    ]);
  });

  test('skips with no_pending_question when no session carries a question', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => true);

    await actions.runDismissQuestion({
      getSessions: () => [session({ question: null })],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 50,
    });

    expect(dismissQuestion).not.toHaveBeenCalled();
    expect(names(seen)).toEqual([actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SKIPPED]);
    expect(seen[0].data).toMatchObject({ reason: 'no_pending_question' });
  });

  test('ignores a question with only meta options (no selectable option)', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => true);

    await actions.runDismissQuestion({
      getSessions: () => [
        session({
          question: question({
            options: [{ index: 1, label: 'Type something.', meta: true }],
          }),
        }),
      ],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 50,
    });

    // A meta-only question is not selectable → treated as "no pending question".
    expect(dismissQuestion).not.toHaveBeenCalled();
    expect(seen[0].data).toMatchObject({ reason: 'no_pending_question' });
  });

  test('skips with dismiss_rejected when the dismiss promise rejects', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn(async () => {
      throw new Error('session gone');
    });

    await actions.runDismissQuestion({
      option: 2,
      getSessions: () => [session({ question: question() })],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 1000,
    });

    expect(names(seen)).toEqual([
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SCHEDULED,
      actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SKIPPED,
    ]);
    expect(seen[1].data).toMatchObject({ reason: 'dismiss_rejected', option: 2 });
  });

  test('spawn flow: does NOT answer an unrelated stale question — waits for the scoped spawned stream', async () => {
    // Regression for the on-device agent_question targeting race: when a
    // spawn/open-chat flow is in play, dismiss_question must target the
    // just-spawned stream (flowContext.streamId), which is set asynchronously.
    // Before this fix it fell back to the first unrelated session carrying a
    // pending question on the shared daemon (stale throwaway-agent debris) and
    // answered the wrong (dead) session. With a spawn action armed and no
    // scoped stream yet, it must wait (never use the unscoped fallback).
    const { actions, telemetry } = loadFreshModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const harnessRuntime = require('../src/utils/harnessRuntime');
    harnessRuntime.applyURL(
      'pentacle://harness?scenario=agent_question&actions=spawn_chat_then_send,dismiss_question',
    );
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const dismissQuestion = jest.fn().mockResolvedValue(true);
    // An UNRELATED session carries a pending question; flowContext.streamId is unset.
    const stale = session({ stream_id: 'hostc:claude:stale', session_name: 'stale', question: question() });

    await actions.runDismissQuestion({
      getSessions: () => [stale],
      subscribe: () => () => undefined,
      dismissQuestion,
      timeoutMs: 50,
    });

    expect(dismissQuestion).not.toHaveBeenCalled();
    expect(names(seen)).not.toContain(actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SCHEDULED);
    const skip = seen.find((p) => p.message === actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SKIPPED);
    expect(skip?.data).toMatchObject({ reason: 'no_pending_question' });
  });

  test('valid dismiss_answers JSON prepares a typed batched run', () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);

    const prepared = actions.prepareDismissQuestionHarnessParams({
      dismissAnswersParam: JSON.stringify([
        { selectedOptionIndices: [1, 3], note: 'include both hosts' },
        { text: 'freeform reply', note: 'text note' },
      ]),
    });

    expect(prepared).toEqual({
      shouldRun: true,
      answers: [
        { selectedOptionIndices: [1, 3], note: 'include both hosts' },
        { text: 'freeform reply', note: 'text note' },
      ],
    });
  });

  test('valid dismiss_answers JSON allows selected options and free text on the same answer', () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);

    const prepared = actions.prepareDismissQuestionHarnessParams({
      dismissAnswersParam: JSON.stringify([
        { selectedOptionIndices: [1, 3], text: 'include a written constraint', note: 'include both hosts' },
      ]),
    });

    expect(prepared).toEqual({
      shouldRun: true,
      answers: [
        {
          selectedOptionIndices: [1, 3],
          text: 'include a written constraint',
          note: 'include both hosts',
        },
      ],
    });
  });

  test('option param drives the single-select shortcut when dismiss_answers are absent', () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);

    expect(actions.prepareDismissQuestionHarnessParams({ optionParam: '2' })).toEqual({
      shouldRun: true,
      option: 2,
    });
  });

  test.each([
    ['truncated JSON', '[{"selectedOptionIndex":1,'],
    ['bad escape', '[{"text":"\\x"}]'],
  ])('dismiss_answers JSON parse failure emits json_parse_error and skips: %s', (_label, dismissAnswersParam) => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));

    const prepared = actions.prepareDismissQuestionHarnessParams({ dismissAnswersParam });

    expect(prepared).toEqual({ shouldRun: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe(actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SKIPPED);
    expect(seen[0].data).toMatchObject({ reason: 'json_parse_error' });
    expect(String(seen[0].data?.detail || '')).toBeTruthy();
  });

  test.each([
    ['empty object', [{}], 'dismiss_answers[0].answer'],
    ['non-integer selectedOptionIndex', [{ selectedOptionIndex: 1.5 }], 'dismiss_answers[0].selectedOptionIndex'],
    ['negative selectedOptionIndex', [{ selectedOptionIndex: -1 }], 'dismiss_answers[0].selectedOptionIndex'],
    ['empty selectedOptionIndices', [{ selectedOptionIndices: [] }], 'dismiss_answers[0].selectedOptionIndices'],
    ['bad selectedOptionIndices value', [{ selectedOptionIndices: [1, -1] }], 'dismiss_answers[0].selectedOptionIndices'],
    ['empty selectedOptionLabel', [{ selectedOptionLabel: '   ' }], 'dismiss_answers[0].selectedOptionLabel'],
    ['empty selectedOptionLabels', [{ selectedOptionLabels: [] }], 'dismiss_answers[0].selectedOptionLabels'],
    ['bad selectedOptionLabels value', [{ selectedOptionLabels: ['One', '   '] }], 'dismiss_answers[0].selectedOptionLabels'],
    ['empty text', [{ text: '   ' }], 'dismiss_answers[0].text'],
    ['empty top-level array', [], 'dismiss_answers'],
  ])('dismiss_answers schema failure emits params_invalid and skips: %s', (_label, value, detail) => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));

    const prepared = actions.prepareDismissQuestionHarnessParams({
      dismissAnswersParam: JSON.stringify(value),
    });

    expect(prepared).toEqual({ shouldRun: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe(actions.DISMISS_QUESTION_TELEMETRY_EVENTS.SKIPPED);
    expect(seen[0].data).toMatchObject({ reason: 'params_invalid', detail });
  });
});
