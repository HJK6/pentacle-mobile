import type { PentacleStreamState } from 'pentacle-chat-core';
import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';
import { BART_STREAM_ID } from '../status/statusSelectors';

// Chats remains authoritative for membership, ordering, and needs-you semantics.
export function selectOthersNeedingYou(state: PentacleStreamState) {
  return selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID && smartChatAttention(chat));
}

export function selectDrawerGroups(state: PentacleStreamState) {
  const others = selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID);
  return [
    { title: 'NEEDS YOU' as const, chats: others.filter(smartChatAttention) },
    { title: 'WORKING' as const, chats: others.filter((chat) => !smartChatAttention(chat) && chat.status === 'working') },
    { title: 'IDLE' as const, chats: others.filter((chat) => !smartChatAttention(chat) && chat.status !== 'working') },
  ];
}
