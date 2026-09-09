// The one canonical durable-question answer serializer, shared by both mobile question surfaces
// (NotificationCard and MobileQuestions). Every durable agent_questions answer (a question that
// carries a question_id) is a D3 `prompt.answer` frame: {request_id, question_id, selections?, text?}.
// The free-text box maps to `text`; selected options map to `selections`; a custom typed option also
// maps to `text`. Never emit `custom_text` or `note` wire aliases, and never vary the shape by mode.
// Pinned by pentacle-chat-core tests/fixtures/daemon_updates_v1.json answer_cases.
// public_behavior_spec.

export type DaemonQuestionAnswerInput = {
  request_id: string;
  question_id: string;
  // Selected predefined option values (free_text-mode questions have none).
  selections?: string[];
  // The free-text box content (or a custom typed option). Whitespace-only counts as absent.
  text?: string;
};

export type DaemonQuestionAnswer = {
  type: 'prompt.answer';
  request_id: string;
  question_id: string;
  selections?: string[];
  text?: string;
};

export function buildDaemonQuestionAnswer(input: DaemonQuestionAnswerInput): DaemonQuestionAnswer {
  const selections = Array.isArray(input.selections) && input.selections.length > 0
    ? input.selections
    : undefined;
  const text = typeof input.text === 'string' && input.text.trim().length > 0
    ? input.text
    : undefined;
  if (!selections && !text) {
    throw new Error('An answer needs a selection or typed text before submitting.');
  }
  return {
    type: 'prompt.answer',
    request_id: input.request_id,
    question_id: input.question_id,
    ...(selections ? { selections } : {}),
    ...(text ? { text } : {}),
  };
}

