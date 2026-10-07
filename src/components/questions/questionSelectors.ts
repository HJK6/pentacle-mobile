import { selectSmartChatList } from '../../../app/(tabs)/chats';
import type { PentacleStreamState } from 'pentacle-chat-core';

import { MACHINES, Tokens, type MachineName } from '../../../constants/Colors';
import { selectOptimisticQuestionAnswerIdentities } from '../../services/pentacleStream';
import { questionForAction, type SmartQuestionAction } from '../../services/questionSubmit';
import { mobileQuestionItems, type MobileQuestionItem } from '../MobileQuestions';
import { BART_STREAM_ID } from '../status/statusSelectors';

// One page of the Questions overlay: one question item of one open question (docs/QUESTIONS_OVERLAY.md).
export type QuestionDeckEntry = {
  // `${action.id}:${itemIndex}` — the Chats QuestionPanel key.
  key: string;
  streamId: string;
  isBart: boolean;
  machineLabel: string;
  machineName: MachineName;
  sessionTitle: string;
  accent: string;
  action: SmartQuestionAction;
  itemIndex: number;
  question: MobileQuestionItem;
  // The durable item's resolver id (P6 binds a recording to it); null for legacy questions.
  questionId: string | null;
  // A scan-incomplete legacy item that cannot be answered yet; counts as answered like on Chats.
  locked: boolean;
};

type RawQuestionItem = { state?: unknown; answer?: unknown };

function notificationMarksItemAnswered(raw: RawQuestionItem | undefined) {
  if (!raw) return false;
  return (raw.state != null && raw.state !== 'open') || raw.answer != null;
}

function buildDeck(
  chats: ReturnType<typeof selectSmartChatList>,
  identities: ReturnType<typeof selectOptimisticQuestionAnswerIdentities>,
): QuestionDeckEntry[] {
  const covered = new Set(identities.map((identity) => `${identity.notificationId}\n${identity.questionId ?? ''}`));
  const deck: QuestionDeckEntry[] = [];
  for (const chat of chats) {
    const isBart = chat.streamId === BART_STREAM_ID;
    const accent = isBart ? Tokens.palette.green : MACHINES[chat.machineName].accent;
    for (const action of chat.openQuestions) {
      const parent = questionForAction(action);
      const rawItems = action.kind === 'durable'
        ? (action.model.notification.question as { questions?: RawQuestionItem[] } | undefined)?.questions
        : undefined;
      mobileQuestionItems(parent).forEach((question, itemIndex) => {
        let questionId: string | null = null;
        if (action.kind === 'durable') {
          const modelItem = action.model.items[question.index];
          questionId = modelItem?.questionId ?? '';
          // A multi-item notification stays open after a partial answer: drop each item the
          // optimistic projection covers, and each item the notification itself marks answered.
          if (covered.has(`${action.id}\n${questionId}`)) return;
          if (Array.isArray(rawItems) && rawItems.length > 0 && notificationMarksItemAnswered(rawItems[question.index])) return;
        }
        deck.push({
          key: `${action.id}:${itemIndex}`,
          streamId: chat.streamId,
          isBart,
          machineLabel: chat.hostTitle,
          machineName: chat.machineName,
          sessionTitle: chat.title,
          accent,
          action,
          itemIndex,
          question,
          questionId,
          locked: !!(parent.scan_incomplete && question.index !== Number(parent.active_index || 0)),
        });
      });
    }
  }
  return deck;
}

// Legacy actions are rebuilt on every Chats-list pass; compare them by their source question.
function sameAction(left: SmartQuestionAction, right: SmartQuestionAction) {
  if (left === right) return true;
  return left.kind === 'legacy' && right.kind === 'legacy'
    && left.id === right.id
    && left.question === right.question
    && left.host === right.host
    && left.sessionName === right.sessionName;
}

function sameDeck(left: readonly QuestionDeckEntry[], right: readonly QuestionDeckEntry[]) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.key === other.key
      && sameAction(entry.action, other.action)
      && entry.streamId === other.streamId
      && entry.sessionTitle === other.sessionTitle
      && entry.machineLabel === other.machineLabel
      && entry.accent === other.accent
      && entry.locked === other.locked;
  });
}

let cachedDeck: QuestionDeckEntry[] = [];

// Every open durable question item (Bart and every session), in Chats order. Pure function of
// state. The result keeps its reference while its content is unchanged, so it is safe as a
// store selector (the Chats list rebuilds its rows more often than the deck changes).
export function selectQuestionDeck(state: PentacleStreamState): QuestionDeckEntry[] {
  const next = buildDeck(selectSmartChatList(state), selectOptimisticQuestionAnswerIdentities(state));
  if (sameDeck(cachedDeck, next)) return cachedDeck;
  cachedDeck = next;
  return cachedDeck;
}

// The home `?` badge: exactly the number of pages the overlay shows (docs/bart_home_contracts.md v1.4).
export function selectPendingQuestionCount(state: PentacleStreamState): number {
  return selectQuestionDeck(state).length;
}
