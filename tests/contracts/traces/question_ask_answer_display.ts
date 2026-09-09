// Full question ask/answer/display contract.
//
// Scenario: a daemon summary carries a pending AskUserQuestion; the card renders;
// the operator selects an option with a preview, adds a note, submits; dismiss
// succeeds; the committed USER echo lands; the answer renders as a structured
// answer bubble. The preview assertions replay Bug E: option previews must not
// be interleaved inside option rows.

import type { TraceContract } from './types';

export const QUESTION_ASK_ANSWER_DISPLAY: TraceContract = {
  name: 'question_ask_answer_display',
  fixture: 'question_ask_answer_display_v1',
  description:
    'Pending AskUserQuestion summary renders a card; submit succeeds; committed USER echo renders as a structured answer bubble, with Bug E preview separation.',
  steps: [
    {
      actor: 'daemon',
      event: 'QUESTION_SUMMARY',
      payload: { questionKey: 'server-question-key' },
      fixtureRow: 0,
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_card_renders',
      assert: (snap) => snap.observers.screen.isMountedByTestID('question-card'),
      assertLabel: 'pending daemon question renders question-card',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_preview_not_interleaved',
      assert: (snap) => {
        const preview = snap.observers.screen.queryTextByTestID('question-option-preview-text-0');
        return preview === null || {
          ok: false,
          msg: `preview should not render before selection, got ${JSON.stringify(preview)}`,
        };
      },
      assertLabel: 'Bug E red replay: preview is not shown before selection',
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'question_select_option',
      payload: { optionIndex: 2 },
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_preview_block_renders',
      assert: (snap) => {
        const preview = snap.observers.screen.queryTextByTestID('question-option-preview-text-0');
        return (preview?.includes('Option B selected.') ?? false) || {
          ok: false,
          msg: `selected option preview block should show Option B preview, got ${JSON.stringify(preview)}`,
        };
      },
      assertLabel: 'Bug E red replay: selected preview renders in the preview block',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_preview_stays_out_of_option_rows',
      assert: (snap) => snap.observers.screen.isMountedByTestID('question-preview-separated-from-options'),
      assertLabel: 'Bug E red replay: preview text must not be interleaved in option rows',
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'question_enter_note',
      payload: { text: 'Use option B.' },
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'question_submit',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_card_dismissed',
      assert: (snap) => !snap.observers.screen.isMountedByTestID('question-card'),
      assertLabel: 'question card is locally dismissed after dismiss success',
      t: '<50ms',
    },
    {
      actor: 'daemon',
      event: 'USER',
      payload: { optimisticId: 'question-answer-echo-1' },
      fixtureRow: 1,
      t: '<200ms',
    },
    {
      actor: 'reducer',
      effect: 'committed_user_echo',
      assert: (snap) =>
        snap.state.events.some((event) => event.kind === 'USER' && event.text.includes('Answering your question')) || {
          ok: false,
          msg: 'committed USER echo with question-answer wire text should be in reducer state',
        },
      assertLabel: 'committed USER echo lands in reducer state',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'structured_answer_bubble_renders',
      assert: (snap) => snap.observers.screen.isMountedByTestID('answer-bubble'),
      assertLabel: 'answer wire text renders as structured answer-bubble',
      t: '<50ms',
    },
    {
      actor: 'screen',
      effect: 'raw_answer_grammar_hidden',
      assert: (snap) => snap.observers.screen.isMountedByTestID('answer-grammar-hidden'),
      assertLabel: 'raw Answering-your-question grammar is hidden in the rendered row',
      t: 'sameTick',
    },
  ],
};

export const DURABLE_QUESTION_NOTIFICATION_DISPLAY: TraceContract = {
  name: 'durable_question_notification_display',
  fixture: 'question_ask_answer_display_v1',
  description:
    'Durable agent_question.v1 notification for the focused stream renders in-chat; option tap does not resolve; Submit calls prompt.answer with selections and free text.',
  steps: [
    {
      actor: 'daemon',
      event: 'QUESTION_NOTIFICATION',
      synthetic: true,
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'question_card_renders',
      assert: (snap) => snap.observers.screen.isMountedByTestID('question-card'),
      assertLabel: 'durable question notification renders question-card',
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'durable_question_select_option',
      payload: { optionIndex: 2 },
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'bare_tap_does_not_resolve',
      assert: (snap) =>
        !snap.observed.some((event) => event.name === 'actions.answerPrompt') || {
          ok: false,
          msg: 'option tap must not answer the durable prompt',
        },
      assertLabel: 'bare option tap never resolves durable question',
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'durable_question_enter_note',
      payload: { text: 'Use option B.' },
      t: 'sameTick',
    },
    {
      actor: 'user',
      action: 'durable_question_submit',
      t: 'sameTick',
    },
    {
      actor: 'screen',
      effect: 'durable_question_resolved',
      assert: (snap) =>
        snap.observed.some((event) => event.name === 'actions.answerPrompt') || {
          ok: false,
          msg: 'Submit should call prompt.answer for durable questions',
        },
      assertLabel: 'Submit uses prompt.answer durable path',
      t: '<50ms',
    },
  ],
};
