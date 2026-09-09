import * as FileSystem from 'expo-file-system/legacy';
import type { ChatAttachment } from 'pentacle-chat-core';

import { uploadBlobBase64 } from './pentacleStream';
import type { ProcessedAsset } from './imageCapture';

/**
 * Upload leg of the A1 photo/camera send.
 *
 * Flow per Transport v2: compress → read file bytes as base64 → upload each image
 * to the daemon via the chunked blob RPC → return `ChatAttachment[]` with the
 * daemon-returned `blob_sha` echoed as `key`, FIFO, for the `send` payload.
 *
 * SDK54 note: `readAsStringAsync` lives on the `expo-file-system/legacy` surface
 * (the package-root default export is the new File/Paths API), so we import from
 * `/legacy` here.
 */

// SEAM(A2): jest mocks `uploadBlobBase64`, so upload unit tests assert the mobile
// flow without touching the live daemon.

async function readAttachmentBase64(fileUri: string): Promise<string> {
  return FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Upload a batch of compressed assets, returning the wire `ChatAttachment[]`
 * FIFO-aligned to `assets`. All-or-nothing: any read/upload error rejects, so the
 * caller aborts the whole send (no partial message).
 *
 * Keys are daemon-generated blob sha refs, echoed verbatim into the send payload.
 * `localPath` is never produced here (it is daemon-side only).
 */
export async function uploadStagedAttachments(
  assets: ProcessedAsset[],
): Promise<ChatAttachment[]> {
  if (assets.length === 0) return [];

  const attachments: ChatAttachment[] = [];
  for (const asset of assets) {
    const dataBase64 = await readAttachmentBase64(asset.uri);
    const uploaded = await uploadBlobBase64(dataBase64, asset.bytes);
    attachments.push({
      key: uploaded.blob_sha,
      mime: asset.mimeType,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      bytes: asset.bytes,
    });
  }
  return attachments;
}
