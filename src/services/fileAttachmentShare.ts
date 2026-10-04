import * as FileSystem from 'expo-file-system/legacy';
import { toByteArray } from 'base64-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ChatAttachment } from 'pentacle-chat-core';
import { fetchBlobBase64 } from './pentacleStream';

export const FILE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const TYPES: Record<string, { extension: string; uti: string }> = {
  'application/pdf': { extension: 'pdf', uti: 'com.adobe.pdf' },
  'application/zip': { extension: 'zip', uti: 'public.zip-archive' },
  'model/3mf': { extension: '3mf', uti: 'public.data' },
  'model/stl': { extension: 'stl', uti: 'public.data' },
  'model/step': { extension: 'step', uti: 'public.data' },
  'application/x-openscad': { extension: 'scad', uti: 'public.data' },
};
let operation = 0;
export function isImageAttachment(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg';
}
export function fileType(mime: string) { return Object.prototype.hasOwnProperty.call(TYPES, mime) ? TYPES[mime] : undefined; }
function refusal(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
export function fileDisplayName(attachment: ChatAttachment): string {
  const type = fileType(attachment.mime);
  const name = String(attachment.filename || '').normalize('NFKC').split(/[\\/]/).pop()!
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_').trim();
  const extension = name.split('.').pop()?.toLowerCase();
  const matches = extension === type?.extension || (attachment.mime === 'model/step' && extension === 'stp');
  return name && name.length <= 180 && matches ? name : `attachment.${type?.extension || 'bin'}`;
}
function verifiedBytes(base64: string, attachment: ChatAttachment): Uint8Array {
  const size = attachment.size ?? attachment.bytes;
  if (!Number.isSafeInteger(size) || !size || size > FILE_ATTACHMENT_MAX_BYTES || size < 0
      || !/^[0-9a-f]{64}$/.test(attachment.key) || typeof base64 !== 'string'
      || base64.length > Math.ceil(FILE_ATTACHMENT_MAX_BYTES / 3) * 4
      || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw refusal('attachment_invalid');
  const bytes = toByteArray(base64);
  if (bytes.length !== size || bytesToHex(sha256(bytes)) !== attachment.key) throw refusal('attachment_integrity_failed');
  return bytes;
}

/** User-triggered native share/save; always reauthorizes through the live bridge.
 * No URI from event metadata or stale file cache can bypass that fetch.
 */
export async function downloadAndShareAttachment(attachment: ChatAttachment, signal?: AbortSignal): Promise<void> {
  const current = () => { if (signal?.aborted) throw refusal('cancelled'); };
  current();
  const type = fileType(attachment.mime);
  const size = attachment.size ?? attachment.bytes;
  if (!type || !/^[0-9a-f]{64}$/.test(attachment.key) || !Number.isSafeInteger(size)
      || !size || size < 0 || size > FILE_ATTACHMENT_MAX_BYTES) throw refusal('attachment_invalid');
  // Load the new native capability only for a file action; older binaries can
  // still render existing images and report unavailable sharing honestly.
  let Sharing: typeof import('expo-sharing');
  try { Sharing = require('expo-sharing') as typeof import('expo-sharing'); } catch { throw refusal('sharing_unavailable'); }
  if (!FileSystem.cacheDirectory || !await Sharing.isAvailableAsync()) throw refusal('sharing_unavailable');
  current();
  let fetched;
  try { fetched = await fetchBlobBase64(attachment.key); }
  catch (error) {
    if ((error as { code?: string })?.code === 'blob_unknown') throw refusal('blob_unknown');
    throw refusal('file_fetch_failed');
  }
  current();
  if (fetched.blob_sha !== attachment.key || fetched.size_bytes !== size) throw refusal('attachment_integrity_failed');
  verifiedBytes(fetched.content_b64, attachment);
  const directory = `${FileSystem.cacheDirectory}pentacle-file-delivery/${Date.now()}-${++operation}/`;
  const uri = directory + fileDisplayName(attachment);
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.writeAsStringAsync(uri, fetched.content_b64, { encoding: FileSystem.EncodingType.Base64 });
    const readback = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    verifiedBytes(readback, attachment);
    current();
    await Sharing.shareAsync(uri, { mimeType: attachment.mime, UTI: type.uti, dialogTitle: fileDisplayName(attachment) });
  } finally {
    // Only this operation's scratch directory; the server source is untouched.
    await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
  }
}
