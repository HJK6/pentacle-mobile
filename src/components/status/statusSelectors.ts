import { peekEventsForStream, type PentacleStreamState } from 'pentacle-chat-core';
import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';

export const BART_STREAM_ID = 'bart:assistant';

export function selectStatusUpdates(state: PentacleStreamState) {
  return peekEventsForStream(state, BART_STREAM_ID)
    .filter((event) => event.publish_kind === 'status')
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)
      || b.daemon_seq - a.daemon_seq);
}

export function selectOpenLanes(state: PentacleStreamState) {
  const sessions = new Map(state.sessions.map((session) => [session.stream_id, session]));
  return selectSmartChatList(state)
    .filter((chat) => chat.streamId !== BART_STREAM_ID && (chat.status === 'working' || smartChatAttention(chat)))
    .map((chat) => {
      const session = sessions.get(chat.streamId);
      const card = chat.status_card;
      const step = card?.plan?.find((item) => item.status === 'active')?.text?.trim()
        || card?.update?.trim() || session?.working_label?.trim() || chat.statusLabel;
      return { chat, session, step, needsYou: smartChatAttention(chat) };
    });
}

export type StatusLane = ReturnType<typeof selectOpenLanes>[number];
