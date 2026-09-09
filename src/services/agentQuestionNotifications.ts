import type {
  PentacleAgentQuestionPayload,
  PentacleNotification,
  PentacleQuestion,
} from 'pentacle-chat-core';

export const AGENT_QUESTION_PRODUCER = 'agent_question.v1';

export type DurableQuestionItemModel = {
  question: PentacleQuestion;
  questionId: string;
  optionValues: Map<number, string>;
  allowCustom: boolean;
  responseMode: string;
};

export type DurableQuestionCardModel = {
  notification: PentacleNotification;
  question: PentacleQuestion;
  items: DurableQuestionItemModel[];
  optionValues: Map<number, string>;
  allowCustom: boolean;
  responseMode: string;
};

export type DurableQuestionAnswerDisplayInput = {
  notificationId: string;
  actionKind: string;
  questionId?: string;
  text?: string;
  selections?: string[];
  customText?: string;
  note?: string;
};

export type DurableQuestionAnswerInput = {
  text?: string;
  selectedOptionIndex?: number;
  selectedOptionIndices?: readonly number[];
  customText?: string;
  note?: string;
};

export type DurableQuestionResolution = {
  notification_id: string;
  action_kind: PentacleNotification['actions'][number]['kind'];
  question_id?: string;
  text?: string;
  selections?: string[];
  custom_text?: string;
  note?: string;
};

export function buildDurableQuestionResolution(
  model: DurableQuestionCardModel,
  item: DurableQuestionItemModel,
  answer: DurableQuestionAnswerInput,
): DurableQuestionResolution {
  const actionKind = model.notification.actions[0]?.kind || 'ack';
  const questionId = item.questionId;
  const note = typeof answer.note === 'string' && answer.note.trim() ? answer.note : undefined;
  const text = typeof answer.text === 'string' && answer.text.trim() ? answer.text : undefined;
  if (item.responseMode === 'free_text') {
    if (!text) throw new Error('Enter an answer before submitting.');
    return {
      notification_id: model.notification.notification_id,
      action_kind: actionKind,
      ...(questionId ? { question_id: questionId } : {}),
      text,
      ...(note ? { note } : {}),
    };
  }

  const selectedIndices = Array.isArray(answer.selectedOptionIndices)
    ? answer.selectedOptionIndices
    : (typeof answer.selectedOptionIndex === 'number' ? [answer.selectedOptionIndex] : []);
  const selections = selectedIndices
    .map((optionIndex) => item.optionValues.get(optionIndex))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const customText = item.allowCustom && typeof answer.customText === 'string' && answer.customText.trim()
    ? answer.customText
    : undefined;
  if (selections.length > 0 && customText) {
    throw new Error('Choose a predefined answer or Custom, not both.');
  }
  if (selections.length === 0 && !customText) {
    throw new Error('Choose an answer before submitting.');
  }
  return {
    notification_id: model.notification.notification_id,
    action_kind: actionKind,
    ...(questionId ? { question_id: questionId } : {}),
    ...(selections.length > 0 ? { selections } : {}),
    ...(customText ? { custom_text: customText } : {}),
    ...(!customText && note ? { note } : {}),
  };
}

export function durableQuestionDisplaySelections(
  item: DurableQuestionItemModel,
  answer: DurableQuestionAnswerInput,
) {
  const selectedIndices = Array.isArray(answer.selectedOptionIndices)
    ? answer.selectedOptionIndices
    : (typeof answer.selectedOptionIndex === 'number' ? [answer.selectedOptionIndex] : []);
  return selectedIndices.map((selectedIndex) => (
    item.question.options?.find((option) => option.index === selectedIndex)?.label ||
    item.optionValues.get(selectedIndex) ||
    ''
  )).filter(Boolean);
}

export function buildDurableQuestionAnswerText(input: DurableQuestionAnswerDisplayInput) {
  const displayText = String(input.text || input.customText || '').trim();
  const note = String(input.note || '').trim();
  return JSON.stringify({
    type: 'notification.answer',
    notification_id: input.notificationId,
    ...(input.questionId ? { question_id: input.questionId } : {}),
    answer: {
      action_kind: input.actionKind,
      ...(displayText ? { text: displayText } : {}),
      ...(input.selections?.length ? { selections: input.selections } : {}),
      ...(note ? { note } : {}),
    },
  });
}

export function isAgentQuestionNotification(notification: Pick<PentacleNotification, 'producer'> | null | undefined) {
  return notification?.producer === AGENT_QUESTION_PRODUCER;
}

const QUESTION_IDENTITY_FIELDS = ['question_id', 'request_id', 'tool_use_id', 'question_key', 'question_nonce'] as const;

function questionIdentitySets(value: unknown) {
  const identities = new Map<string, Set<string>>();
  const seen = new Set<object>();
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate as object)) return;
    seen.add(candidate as object);
    const row = candidate as Record<string, unknown>;
    for (const field of QUESTION_IDENTITY_FIELDS) {
      const identity = typeof row[field] === 'string' ? row[field].trim() : '';
      if (!identity) continue;
      const values = identities.get(field) ?? new Set<string>();
      values.add(identity);
      identities.set(field, values);
    }
    visit(row.envelope);
    visit(row.question);
    if (Array.isArray(row.questions)) row.questions.forEach(visit);
  };
  visit(value);
  return identities;
}

export function agentQuestionMatchesSessionQuestion(
  notification: PentacleNotification,
  sessionQuestion: PentacleQuestion | null | undefined,
) {
  if (!isAgentQuestionNotification(notification) || !sessionQuestion) {
    return false;
  }
  const durable = questionIdentitySets(notification.question);
  const pane = questionIdentitySets(sessionQuestion);
  let matched = false;
  for (const field of QUESTION_IDENTITY_FIELDS) {
    const durableValues = durable.get(field);
    const paneValues = pane.get(field);
    if (!durableValues?.size || !paneValues?.size) continue;
    if (durableValues.size > 1 || paneValues.size > 1) {
      if (
        durableValues.size !== paneValues.size ||
        [...durableValues].some((value) => !paneValues.has(value))
      ) return false;
    } else if (![...durableValues].some((value) => paneValues.has(value))) {
      return false;
    }
    matched = true;
  }
  return matched;
}

export function terminalAgentQuestionMatchesSessionQuestion(
  notification: PentacleNotification,
  sessionQuestion: PentacleQuestion | null | undefined,
) {
  return !isOpenAgentQuestionNotification(notification) &&
    agentQuestionMatchesSessionQuestion(notification, sessionQuestion);
}

export function fullyCoveredOptimisticQuestionNotificationIds(
  notifications: readonly PentacleNotification[],
  optimisticAnswers: readonly { notificationId: string; questionId?: string }[],
) {
  const answersByNotification = new Map<string, Set<string>>();
  for (const answer of optimisticAnswers) {
    const questionIds = answersByNotification.get(answer.notificationId) ?? new Set<string>();
    if (answer.questionId) questionIds.add(answer.questionId);
    answersByNotification.set(answer.notificationId, questionIds);
  }
  const covered = new Set<string>();
  for (const notification of notifications) {
    if (!isAgentQuestionNotification(notification) || !isOpenAgentQuestionNotification(notification)) continue;
    const model = durableQuestionCardModel(notification);
    if (!model) continue;
    const optimisticQuestionIds = answersByNotification.get(notification.notification_id);
    const clientPending = (notification as PentacleNotification & { client_resolution_pending?: boolean })
      .client_resolution_pending === true;
    if (model.items.length === 1 && (clientPending || optimisticQuestionIds)) {
      covered.add(notification.notification_id);
      continue;
    }
    const expectedQuestionIds = model.items.map((item) => item.questionId).filter(Boolean);
    if (
      expectedQuestionIds.length === model.items.length &&
      new Set(expectedQuestionIds).size === model.items.length &&
      expectedQuestionIds.every((questionId) => optimisticQuestionIds?.has(questionId))
    ) {
      covered.add(notification.notification_id);
    }
  }
  return covered;
}

export function filterUpdatesNotifications(notifications: readonly PentacleNotification[] | null | undefined) {
  return notifications || [];
}

export function agentQuestionStreamId(notification: PentacleNotification) {
  return notification.question?.producer_stream_id || notification.answer_to_stream_id || '';
}

export function isOpenAgentQuestionNotification(notification: PentacleNotification) {
  return notification.state === 'open' && (!notification.question || notification.question.state === 'open');
}

export function selectOpenAgentQuestionStreamIds(
  notifications: readonly PentacleNotification[] | null | undefined,
) {
  const streamIds = new Set<string>();
  for (const notification of notifications || []) {
    if (!isAgentQuestionNotification(notification) || !isOpenAgentQuestionNotification(notification)) continue;
    const streamId = agentQuestionStreamId(notification);
    if (streamId) streamIds.add(streamId);
  }
  return streamIds;
}

export function selectOpenAgentQuestionNotificationsForStream(
  notifications: readonly PentacleNotification[] | null | undefined,
  streamId: string,
) {
  return (notifications || []).filter(
    (notification) =>
      isAgentQuestionNotification(notification) &&
      isOpenAgentQuestionNotification(notification) &&
      agentQuestionStreamId(notification) === streamId &&
      !!notification.question,
  );
}

type ExtendedAgentQuestionPayload = PentacleAgentQuestionPayload & {
  allow_custom?: boolean;
  header?: string;
  title?: string;
  prompt?: string;
  body?: string;
  questions?: ExtendedAgentQuestionPayload[];
};

function optionsForQuestion(question: ExtendedAgentQuestionPayload) {
  if (String(question.response_mode) === 'free_text') {
    return { options: [], optionValues: new Map<number, string>() };
  }
  const sourceOptions = question.options.length > 0
    ? question.options
    : [{ label: 'Acknowledge', value: 'ack' }];
  const optionValues = new Map<number, string>();
  const options = sourceOptions.map((option, index) => {
    const typedOption = option as typeof option & { description?: string };
    const cardIndex = index + 1;
    optionValues.set(cardIndex, option.value);
    return {
      index: cardIndex,
      label: option.label || option.value,
      ...(typeof typedOption.description === 'string' && typedOption.description.trim()
        ? { description: typedOption.description }
        : {}),
      meta: false,
    };
  });
  return { options, optionValues };
}

export function durableQuestionCardModel(
  notification: PentacleNotification,
): DurableQuestionCardModel | null {
  const agentQuestion = notification.question;
  if (!agentQuestion) return null;
  const contractQuestion = agentQuestion as ExtendedAgentQuestionPayload;
  const rawItems = Array.isArray(contractQuestion.questions) && contractQuestion.questions.length > 0
    ? contractQuestion.questions
    : [contractQuestion];
  const items = rawItems.map((raw, index): DurableQuestionItemModel => {
    const responseMode = String(raw.response_mode || contractQuestion.response_mode);
    const normalized = {
      ...raw,
      response_mode: responseMode,
      options: Array.isArray(raw.options) ? raw.options : contractQuestion.options,
    } as ExtendedAgentQuestionPayload;
    const { options, optionValues } = optionsForQuestion(normalized);
    const allowCustom = raw.allow_custom === true || contractQuestion.allow_custom === true;
    const question: PentacleQuestion = {
      header: raw.header || raw.title || notification.title || 'Agent question',
      prompt: raw.prompt || raw.body || (rawItems.length === 1 ? notification.body : '') || `Question ${index + 1}`,
      options,
      multiSelect: responseMode === 'multi_choice',
      free_text: responseMode === 'free_text',
      response_mode: responseMode,
      allow_custom: allowCustom,
      question_id: raw.question_id || contractQuestion.question_id,
      min_select: 1,
    } as PentacleQuestion;
    return {
      question,
      questionId: String(raw.question_id || contractQuestion.question_id || ''),
      optionValues,
      allowCustom,
      responseMode,
    };
  });
  const first = items[0];
  const question: PentacleQuestion = items.length === 1
    ? first.question
    : ({
      header: notification.title || 'Agent questions',
      prompt: notification.body || 'Answer each question.',
      options: [],
      multi: true,
      questions: items.map((item, index) => ({ ...item.question, index })),
    } as PentacleQuestion);
  return {
    notification,
    question,
    items,
    optionValues: first.optionValues,
    allowCustom: first.allowCustom,
    responseMode: first.responseMode,
  };
}
