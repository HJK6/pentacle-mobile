import { buildPentacleQuestionAnswerText, type PentacleQuestion } from 'pentacle-chat-core';
import type { MobileQuestionAnswer } from '../components/MobileQuestions';
import {
  buildDurableQuestionAnswerText,
  buildDurableQuestionResolution,
  durableQuestionDisplaySelections,
  type DurableQuestionCardModel,
  type DurableQuestionItemModel,
} from './agentQuestionNotifications';
import type { usePentacleStreamActions } from './pentacleStream';

// One open question on a chat: a durable agent-question notification, or a legacy
// keyed session question. Shared by the Chats rows and the Questions overlay
// (docs/bart_home_contracts.md).
export type SmartQuestionAction =
  | { kind: 'durable'; id: string; model: DurableQuestionCardModel }
  | { kind: 'legacy'; id: string; question: PentacleQuestion; host: string; sessionName: string };

export type QuestionSubmission = {
  action: SmartQuestionAction;
  answers: MobileQuestionAnswer[];
  items?: DurableQuestionItemModel[];
};

export type QuestionSubmitActions = Pick<
  ReturnType<typeof usePentacleStreamActions>,
  | 'beginOptimisticQuestionAnswer'
  | 'answerPrompt'
  | 'queueOptimisticQuestionAnswer'
  | 'discardOptimisticQuestionAnswer'
  | 'dismissQuestion'
  | 'sendMessage'
>;

export type QuestionSubmitHooks = {
  // A durable answer's optimistic row exists, so a failure is retryable from the caller.
  onDurableAnswerQueued?: () => void;
  // The daemon rejected a durable answer with an error code; it is not retryable.
  onDurableAnswerRejected?: () => void;
  // A legacy answer was dismissed but its message send failed; the transcript holds the retry.
  onLegacySendFailed?: () => void;
};

export function questionForAction(action: SmartQuestionAction) {
  return action.kind === 'durable' ? action.model.question : action.question;
}

// Answers one submission exactly as the Chats row always has: each durable item is a
// prompt.answer frame behind an optimistic answer; a legacy question is dismissed by
// key and answered with one message. Throws on the first failure that is not
// recoverable from the transcript.
export async function submitQuestionSubmission(
  actions: QuestionSubmitActions,
  streamId: string,
  submission: QuestionSubmission,
  hooks: QuestionSubmitHooks = {},
): Promise<void> {
  if (submission.action.kind === 'durable') {
    const action = submission.action;
    for (const [index, answer] of submission.answers.entries()) {
      const item = submission.items?.[index] || action.model.items[index];
      if (!item) throw new Error('Question is missing its durable resolver identity.');
      const resolution = buildDurableQuestionResolution(action.model, item, answer);
      const optimisticId = actions.beginOptimisticQuestionAnswer({
        streamId,
        text: buildDurableQuestionAnswerText({
          notificationId: resolution.notification_id,
          actionKind: resolution.action_kind,
          ...(item.questionId ? { questionId: item.questionId } : {}),
          ...(resolution.text ? { text: resolution.text } : {}),
          ...(resolution.selections ? { selections: durableQuestionDisplaySelections(item, answer) } : {}),
          ...(resolution.custom_text ? { customText: resolution.custom_text } : {}),
          ...(resolution.note ? { note: resolution.note } : {}),
        }),
        notificationId: resolution.notification_id,
        ...(item.questionId ? { questionId: item.questionId } : {}),
      });
      if (!optimisticId) throw new Error('Question answer could not be queued. Try again.');
      hooks.onDurableAnswerQueued?.();
      try {
        if (!item.questionId) throw new Error('Question is missing its durable prompt identity.');
        await actions.answerPrompt({
          questionId: item.questionId,
          ...(resolution.selections ? { selections: resolution.selections } : {}),
          ...(resolution.text || resolution.custom_text || resolution.note
            ? { text: resolution.text || resolution.custom_text || resolution.note }
            : {}),
        });
        actions.queueOptimisticQuestionAnswer(optimisticId);
      } catch (error) {
        actions.discardOptimisticQuestionAnswer(optimisticId);
        if (String((error as { errorCode?: string })?.errorCode || '')) hooks.onDurableAnswerRejected?.();
        throw error;
      }
    }
    return;
  }
  const keyedQuestion = submission.action.question as PentacleQuestion & { question_key?: string; questionKey?: string };
  const questionKey = String(keyedQuestion.question_key ?? keyedQuestion.questionKey ?? '');
  if (!questionKey) throw new Error('Question is missing its server key.');
  const answerText = buildPentacleQuestionAnswerText({
    question: submission.action.question,
    answers: submission.answers.map((answer) => (
      answer.customText && answer.selectedOptionIndex === undefined && !answer.selectedOptionIndices?.length
        ? { text: answer.customText }
        : answer
    )),
  });
  const optimisticId = actions.beginOptimisticQuestionAnswer({ streamId, text: answerText });
  if (!optimisticId) throw new Error('Question answer could not be queued. Try again.');
  try {
    await actions.dismissQuestion({
      host: submission.action.host,
      sessionName: submission.action.sessionName,
      questionKey,
    });
  } catch (error) {
    if (String((error as { errorCode?: string })?.errorCode || '') !== 'stale_question') {
      actions.discardOptimisticQuestionAnswer(optimisticId);
      throw error;
    }
  }
  try {
    await actions.sendMessage({
      host: submission.action.host,
      sessionName: submission.action.sessionName,
      text: answerText,
      optimisticId,
    });
  } catch {
    hooks.onLegacySendFailed?.();
  }
}
