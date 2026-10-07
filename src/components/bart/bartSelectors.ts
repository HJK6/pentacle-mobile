import type { PentacleStreamState } from 'pentacle-chat-core';
import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';
import { BART_STREAM_ID } from '../status/statusSelectors';

// Chats remains authoritative for membership, ordering, and needs-you semantics.
export function selectOthersNeedingYou(state: PentacleStreamState) {
  return selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID && smartChatAttention(chat));
}
