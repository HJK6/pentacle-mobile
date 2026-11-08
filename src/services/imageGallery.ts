import type { ChatAttachment } from 'pentacle-chat-core';
import { isImageAttachment } from './fileAttachmentShare';

export type ViewerAttachment = ChatAttachment & { uri?: string };
export interface GalleryImage {
  id: string;
  rowId: string;
  attachmentIndex: number;
  attachment: ViewerAttachment;
}
export interface ImageGallery {
  openingId: number;
  images: readonly GalleryImage[];
  initialIndex: number;
}
let openingId = 0;

/** The inverted transcript is newest first. Snapshot occurrences, never URIs. */
export function createImageGallery(
  newestFirst: readonly { id: string; attachments?: ChatAttachment[] }[],
  rowId: string,
  attachmentIndex: number,
): ImageGallery | null {
  const images: GalleryImage[] = [];
  for (const row of [...newestFirst].reverse()) {
    row.attachments?.forEach((attachment, index) => {
      if (!isImageAttachment(attachment.mime)) return;
      images.push({
        id: JSON.stringify([row.id, index]), rowId: row.id, attachmentIndex: index,
        attachment: { ...attachment },
      });
    });
  }
  const initialIndex = images.findIndex(image => image.rowId === rowId && image.attachmentIndex === attachmentIndex);
  return initialIndex < 0 ? null : { openingId: ++openingId, images, initialIndex };
}
