import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { shareImage } from '../src/services/imageShare';

const source = 'file:///synthetic-image.png';
const bytes = 'synthetic original PNG bytes';
beforeEach(async () => {
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
  jest.mocked(Sharing.shareAsync).mockResolvedValue(undefined);
  await FileSystem.writeAsStringAsync(source, bytes);
});

test('shares the exact source file and content without recompression or source deletion', async () => {
  let received = '';
  jest.mocked(Sharing.shareAsync).mockImplementation(async uri => { received = await FileSystem.readAsStringAsync(uri); });
  await shareImage(source, 'image/png', new AbortController().signal);
  expect(Sharing.shareAsync).toHaveBeenCalledWith(source, expect.objectContaining({ UTI: 'public.png', mimeType: 'image/png' }));
  expect(received).toBe(bytes);
  expect(await FileSystem.readAsStringAsync(source)).toBe(bytes);
});

test('normalizes extension with an owned exact-byte copy retained through cancellation/completion', async () => {
  const original = 'file:///synthetic-without-extension';
  await FileSystem.writeAsStringAsync(original, bytes);
  let finish!: () => void;
  let shared = '';
  jest.mocked(Sharing.shareAsync).mockImplementation(async uri => {
    shared = uri;
    expect(await FileSystem.readAsStringAsync(uri)).toBe(bytes);
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const pending = shareImage(original, 'image/png', new AbortController().signal);
  while (!finish) await Promise.resolve();
  expect(shared).toMatch(/^file:\/\/\/cache\/pentacle-image-share\/.+\/image\.png$/);
  expect((await FileSystem.getInfoAsync(shared)).exists).toBe(true);
  finish();
  await pending;
  expect((await FileSystem.getInfoAsync(shared)).exists).toBe(false);
  expect(await FileSystem.readAsStringAsync(original)).toBe(bytes);
});

test('aborting asynchronous preparation prevents late native presentation', async () => {
  let finish!: (value: any) => void;
  jest.mocked(FileSystem.getInfoAsync).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = shareImage(source, 'image/png', controller.signal);
  while (!finish) await Promise.resolve();
  controller.abort(); finish({ exists: true });
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});

test('unavailable and missing files remain retryable without deleting their sources', async () => {
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValueOnce(false);
  await expect(shareImage(source, 'image/png', new AbortController().signal)).rejects.toThrow('Sharing unavailable');
  await expect(shareImage('file:///missing.png', 'image/png', new AbortController().signal)).rejects.toThrow('Image unavailable');
  await shareImage(source, 'image/png', new AbortController().signal);
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
});

test('concurrent native sheets are suppressed while the first still owns its file', async () => {
  let finish!: () => void;
  jest.mocked(Sharing.shareAsync).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = shareImage(source, 'image/png', new AbortController().signal);
  while (!finish) await Promise.resolve();
  await expect(shareImage(source, 'image/png', new AbortController().signal)).rejects.toThrow('Sharing in progress');
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
  finish(); await pending;
});
