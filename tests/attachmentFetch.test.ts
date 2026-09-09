const mockFetchBlobBase64 = jest.fn();
const mockMakeDirectoryAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockWriteAsStringAsync = jest.fn();

jest.mock('../src/services/pentacleStream', () => ({
  fetchBlobBase64: (...args: unknown[]) => mockFetchBlobBase64(...args),
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: (...args: unknown[]) => mockMakeDirectoryAsync(...args),
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
  writeAsStringAsync: (...args: unknown[]) => mockWriteAsStringAsync(...args),
  EncodingType: { Base64: 'base64' },
}));

import {
  clearAttachmentFetchCacheForTests,
  fetchRenderAttachments,
  renderAttachmentsWithLocalUris,
} from '../src/services/attachmentFetch';

beforeEach(() => {
  clearAttachmentFetchCacheForTests();
  jest.clearAllMocks();
  mockMakeDirectoryAsync.mockResolvedValue(undefined);
  mockGetInfoAsync.mockResolvedValue({ exists: false });
  mockFetchBlobBase64.mockResolvedValue({ blob_sha: 'f'.repeat(64), content_b64: 'aGVsbG8=', size_bytes: 5 });
});

test('renderAttachmentsWithLocalUris returns local optimistic image URIs without fetching', () => {
  const rendered = renderAttachmentsWithLocalUris([
    { key: 'local:1', mime: 'image/jpeg', width: 100, height: 200, uri: 'file:///tmp/a.jpg' } as any,
  ]);

  expect(rendered).toEqual([{ uri: 'file:///tmp/a.jpg', width: 100, height: 200 }]);
  expect(mockFetchBlobBase64).not.toHaveBeenCalled();
});

test('fetchRenderAttachments fetches URI-less daemon blob refs and caches them as files', async () => {
  const rendered = await fetchRenderAttachments([
    { key: 'f'.repeat(64), mime: 'image/jpeg', width: 320, height: 240 },
  ]);

  expect(mockFetchBlobBase64).toHaveBeenCalledWith('f'.repeat(64));
  expect(mockMakeDirectoryAsync).toHaveBeenCalledWith('file:///cache/pentacle-chat-attachments/', { intermediates: true });
  expect(mockWriteAsStringAsync).toHaveBeenCalledWith(
    `file:///cache/pentacle-chat-attachments/${'f'.repeat(64)}.jpg`,
    'aGVsbG8=',
    { encoding: 'base64' },
  );
  expect(rendered).toEqual([{
    uri: `file:///cache/pentacle-chat-attachments/${'f'.repeat(64)}.jpg`,
    width: 320,
    height: 240,
  }]);

  await fetchRenderAttachments([{ key: 'f'.repeat(64), mime: 'image/jpeg' }]);
  expect(mockFetchBlobBase64).toHaveBeenCalledTimes(1);
});

test('attachment render helpers omit absent and non-local media instead of fabricating URIs', async () => {
  expect(renderAttachmentsWithLocalUris()).toBeUndefined();
  expect(renderAttachmentsWithLocalUris([])).toBeUndefined();
  expect(renderAttachmentsWithLocalUris([{ key: 'remote', mime: 'image/jpeg' }])).toBeUndefined();
  expect(renderAttachmentsWithLocalUris([{ key: 'bad', mime: 'image/jpeg', uri: 42 } as any])).toBeUndefined();
  await expect(fetchRenderAttachments()).resolves.toBeUndefined();
  await expect(fetchRenderAttachments([])).resolves.toBeUndefined();
});

test('existing PNG cache entries are reused from disk without daemon or write I/O', async () => {
  mockMakeDirectoryAsync.mockRejectedValueOnce(new Error('already exists'));
  mockGetInfoAsync.mockResolvedValueOnce({ exists: true });
  await expect(fetchRenderAttachments([{ key: 'cached', mime: 'image/png', width: 10, height: 20 }])).resolves.toEqual([
    { uri: 'file:///cache/pentacle-chat-attachments/cached.png', width: 10, height: 20 },
  ]);
  expect(mockFetchBlobBase64).not.toHaveBeenCalled();
  expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
});

test('concurrent requests for the same key share one daemon fetch', async () => {
  let resolveFetch!: (value: { blob_sha: string; content_b64: string; size_bytes: number }) => void;
  mockFetchBlobBase64.mockReturnValueOnce(new Promise((resolve) => {
    resolveFetch = resolve;
  }));
  const first = fetchRenderAttachments([{ key: 'shared', mime: 'image/jpeg' }]);
  const second = fetchRenderAttachments([{ key: 'shared', mime: 'image/jpeg' }]);
  await Promise.resolve();
  await Promise.resolve();
  resolveFetch({ blob_sha: 'shared', content_b64: 'YQ==', size_bytes: 1 });
  await expect(Promise.all([first, second])).resolves.toEqual([
    [{ uri: 'file:///cache/pentacle-chat-attachments/shared.jpg', width: undefined, height: undefined }],
    [{ uri: 'file:///cache/pentacle-chat-attachments/shared.jpg', width: undefined, height: undefined }],
  ]);
  expect(mockFetchBlobBase64).toHaveBeenCalledTimes(1);
});

test('missing keys and empty daemon payloads fail before exposing unusable attachments', async () => {
  await expect(fetchRenderAttachments([{ key: ' ', mime: 'image/jpeg' }])).rejects.toThrow('Missing attachment key');
  mockFetchBlobBase64.mockResolvedValueOnce({ blob_sha: 'empty', content_b64: '', size_bytes: 0 });
  await expect(fetchRenderAttachments([{ key: 'empty', mime: 'image/jpeg' }])).rejects.toThrow('Fetched attachment was empty');
  expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
});
