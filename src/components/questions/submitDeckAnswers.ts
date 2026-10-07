import type { MobileQuestionAnswer } from '../MobileQuestions';
import {
  submitQuestionSubmission,
  type QuestionSubmission,
  type QuestionSubmitActions,
} from '../../services/questionSubmit';
import type { QuestionDeckEntry } from './questionSelectors';

export type DeckSubmitResult = {
  // Keys counted as sent: the call resolved without onLegacySendFailed.
  sent: string[];
  // Keys whose submission threw; the item stays in the deck with its draft.
  failed: Array<{ key: string; message: string }>;
  // Legacy actions dismissed by key whose answer message failed to send; the transcript holds the retry.
  legacyFailed: Array<{ actionId: string; streamId: string; keys: string[] }>;
};

const FALLBACK_MESSAGE = 'Question answer could not be submitted.';

// The answered keys that can be sent now: every answered durable item, and a legacy action only
// when all of its items are answered.
export function sendableKeys(deck: readonly QuestionDeckEntry[], answered: ReadonlySet<string>): Set<string> {
  const sendable = new Set<string>();
  for (const entry of deck) {
    if (!answered.has(entry.key)) continue;
    if (entry.action.kind === 'durable') {
      sendable.add(entry.key);
      continue;
    }
    const group = deck.filter((other) => other.action.id === entry.action.id);
    if (group.every((other) => answered.has(other.key))) sendable.add(entry.key);
  }
  return sendable;
}

// Sends the answered deck items serially in deck order: one submission per answered durable item
// (one prompt.answer behind an optimistic answer) and one per fully answered legacy action.
// Never throws; a failure marks that item and the remaining items are still attempted.
export async function submitDeckAnswers({ actions, deck, answers }: {
  actions: QuestionSubmitActions;
  deck: readonly QuestionDeckEntry[];
  answers: ReadonlyMap<string, MobileQuestionAnswer>;
}): Promise<DeckSubmitResult> {
  const result: DeckSubmitResult = { sent: [], failed: [], legacyFailed: [] };
  const sendable = sendableKeys(deck, new Set(answers.keys()));
  const handledLegacy = new Set<string>();
  for (const entry of deck) {
    if (!sendable.has(entry.key)) continue;
    const { action } = entry;
    let keys: string[];
    let submission: QuestionSubmission;
    if (action.kind === 'durable') {
      keys = [entry.key];
      submission = {
        action,
        answers: [answers.get(entry.key) as MobileQuestionAnswer],
        items: [action.model.items[entry.question.index]],
      };
    } else {
      if (handledLegacy.has(action.id)) continue;
      handledLegacy.add(action.id);
      const group = deck.filter((other) => other.action.id === action.id);
      keys = group.map((other) => other.key);
      submission = { action, answers: group.map((other) => answers.get(other.key) as MobileQuestionAnswer) };
    }
    let legacySendFailed = false;
    try {
      await submitQuestionSubmission(actions, entry.streamId, submission, {
        onLegacySendFailed: () => { legacySendFailed = true; },
      });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : FALLBACK_MESSAGE;
      for (const key of keys) result.failed.push({ key, message });
      continue;
    }
    if (legacySendFailed) {
      result.legacyFailed.push({ actionId: action.id, streamId: entry.streamId, keys });
    } else {
      result.sent.push(...keys);
    }
  }
  return result;
}
