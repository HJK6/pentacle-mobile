import type { ChatAttachment } from 'pentacle-chat-core';

export interface RenderAttachment {
  uri: string;
  kind?: 'file';
  attachment?: ChatAttachment;
  width?: number;
  height?: number;
}
