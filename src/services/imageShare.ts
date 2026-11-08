import * as FileSystem from 'expo-file-system/legacy';

type ImageMime = 'image/jpeg' | 'image/png';
export type ShareAnchor = { x: number; y: number; width: number; height: number };
let operation = 0;
let nativeSheetOpen = false;
const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

/** Share attachment bytes without conversion. Only operation-owned scratch is removed. */
export async function shareImage(
  uri: string, mime: string, signal: AbortSignal, anchor?: ShareAnchor,
): Promise<void> {
  const current = () => { if (signal.aborted) throw cancelled(); };
  current();
  if (!uri.startsWith('file://') || (mime !== 'image/jpeg' && mime !== 'image/png')) {
    throw new Error('Image unavailable');
  }
  let sharing: typeof import('expo-sharing');
  try { sharing = require('expo-sharing') as typeof import('expo-sharing'); }
  catch { throw new Error('Sharing unavailable'); }
  if (!await sharing.isAvailableAsync()) throw new Error('Sharing unavailable');
  current();
  const info = await FileSystem.getInfoAsync(uri);
  current();
  if (!info.exists || info.isDirectory) throw new Error('Image unavailable');
  const extension = mime === 'image/png' ? 'png' : 'jpg';
  const matches = mime === 'image/png' ? /\.png$/i.test(uri) : /\.jpe?g$/i.test(uri);
  let directory: string | undefined;
  try {
    let sharedUri = uri;
    if (!matches) {
      if (!FileSystem.cacheDirectory) throw new Error('Image unavailable');
      directory = `${FileSystem.cacheDirectory}pentacle-image-share/${Date.now()}-${++operation}/`;
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      current();
      sharedUri = `${directory}image.${extension}`;
      await FileSystem.copyAsync({ from: uri, to: sharedUri });
    }
    current();
    if (nativeSheetOpen) throw new Error('Sharing in progress');
    nativeSheetOpen = true;
    try {
      await sharing.shareAsync(sharedUri, {
        mimeType: mime as ImageMime, UTI: mime === 'image/png' ? 'public.png' : 'public.jpeg', anchor,
      });
    } finally { nativeSheetOpen = false; }
  } finally {
    if (directory) await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
  }
}
