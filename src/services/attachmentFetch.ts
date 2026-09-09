import * as FileSystem from 'expo-file-system/legacy';
import type { ChatAttachment } from 'pentacle-chat-core';

import { fetchBlobBase64 } from './pentacleStream';
import type { RenderAttachment } from '../types/renderAttachment';

type AttachmentWithLocalUri = ChatAttachment & { uri?: unknown };

const CACHE_DIR = `${FileSystem.cacheDirectory || ''}pentacle-chat-attachments/`;
const memoryCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function extensionForMime(mime: string) {
  return mime === 'image/png' ? 'png' : 'jpg';
}

function cachePath(attachment: ChatAttachment) {
  return `${CACHE_DIR}${attachment.key}.${extensionForMime(attachment.mime)}`;
}

async function ensureCacheDir() {
  await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }).catch(() => undefined);
}

async function fetchAttachmentUri(attachment: ChatAttachment): Promise<string> {
  const key = String(attachment.key || '').trim();
  if (!key) throw new Error('Missing attachment key');
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    await ensureCacheDir();
    const uri = cachePath(attachment);
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      memoryCache.set(key, uri);
      return uri;
    }
    const fetched = await fetchBlobBase64(key);
    if (!fetched.content_b64) throw new Error('Fetched attachment was empty');
    await FileSystem.writeAsStringAsync(uri, fetched.content_b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    memoryCache.set(key, uri);
    return uri;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export function renderAttachmentsWithLocalUris(attachments?: ChatAttachment[]): RenderAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  const renderAttachments = attachments.flatMap((attachment) => {
    const uri = (attachment as AttachmentWithLocalUri).uri;
    return typeof uri === 'string'
      ? [{ uri, width: attachment.width, height: attachment.height }]
      : [];
  });
  return renderAttachments.length > 0 ? renderAttachments : undefined;
}

export async function fetchRenderAttachments(attachments?: ChatAttachment[]): Promise<RenderAttachment[] | undefined> {
  if (!attachments?.length) return undefined;
  const renderAttachments = await Promise.all(attachments.map(async (attachment) => ({
    uri: await fetchAttachmentUri(attachment),
    width: attachment.width,
    height: attachment.height,
  })));
  return renderAttachments.length > 0 ? renderAttachments : undefined;
}

export function clearAttachmentFetchCacheForTests() {
  memoryCache.clear();
  inFlight.clear();
}
