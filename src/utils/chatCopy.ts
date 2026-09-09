import * as Clipboard from 'expo-clipboard';

import { logTelemetry, TELEMETRY_EVENTS } from 'pentacle-chat-core';

export type ChatCopyKind = 'message' | 'code';

export type ChatCopyRequest = {
  streamId: string;
  targetId: string;
  copyKind: ChatCopyKind;
  text: string;
};

export type ChatCopyResult = {
  identity: string;
  copiedLength: number;
};

export function chatCopyIdentity(text: string): string {
  const value = String(text || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function handleChatCopy(request: ChatCopyRequest): Promise<ChatCopyResult> {
  const text = String(request.text || '');
  await Clipboard.setStringAsync(text);
  const identity = chatCopyIdentity(text);
  logTelemetry(TELEMETRY_EVENTS.CHAT_COPY_INVOKED, {
    stream_id: request.streamId,
    target_id: request.targetId,
    copy_kind: request.copyKind,
    copied_length: text.length,
    identity,
  });
  return { identity, copiedLength: text.length };
}
