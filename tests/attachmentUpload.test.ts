// A1 (photo/camera send) — upload leg unit tests. The daemon blob RPC is mocked
// at the pentacleStream seam; the old direct-upload leg is intentionally absent.

const mockUploadBlobBase64 = jest.fn();
const mockReadAsStringAsync = jest.fn();

jest.mock('../src/services/pentacleStream', () => ({
  uploadBlobBase64: (...args: unknown[]) => mockUploadBlobBase64(...args),
}));

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...args),
  EncodingType: { Base64: 'base64' },
}));

import { uploadStagedAttachments } from '../src/services/attachmentUpload';
import type { ProcessedAsset } from '../src/services/imageCapture';

function asset(overrides: Partial<ProcessedAsset> = {}): ProcessedAsset {
  return {
    uri: 'file:///tmp/a.jpg',
    fileName: 'a.jpg',
    mimeType: 'image/jpeg',
    width: 1200,
    height: 800,
    bytes: 204800,
    ...overrides,
  };
}

function sha(label: string) {
  return label.padEnd(64, label).slice(0, 64);
}

beforeEach(() => {
  mockUploadBlobBase64.mockReset();
  mockReadAsStringAsync.mockReset();
  mockReadAsStringAsync.mockImplementation(async (uri: string) => `b64:${uri}`);
  mockUploadBlobBase64.mockImplementation(async (dataBase64: string) => ({
    blob_sha: sha(dataBase64.replace(/[^a-z0-9]/gi, '') || '0'),
    size_bytes: 123,
  }));
});

test('empty asset list short-circuits without reading or uploading', async () => {
  const out = await uploadStagedAttachments([]);
  expect(out).toEqual([]);
  expect(mockReadAsStringAsync).not.toHaveBeenCalled();
  expect(mockUploadBlobBase64).not.toHaveBeenCalled();
});

test('uploads each asset through the blob RPC and returns FIFO ChatAttachment keys', async () => {
  const assets = [
    asset({ uri: 'file:///tmp/1.jpg', bytes: 1000, width: 100, height: 200 }),
    asset({ uri: 'file:///tmp/2.jpg', bytes: 2000, width: 300, height: 400 }),
  ];
  mockUploadBlobBase64
    .mockResolvedValueOnce({ blob_sha: sha('first'), size_bytes: 1000 })
    .mockResolvedValueOnce({ blob_sha: sha('second'), size_bytes: 2000 });

  const out = await uploadStagedAttachments(assets);

  expect(mockReadAsStringAsync).toHaveBeenNthCalledWith(1, 'file:///tmp/1.jpg', { encoding: 'base64' });
  expect(mockReadAsStringAsync).toHaveBeenNthCalledWith(2, 'file:///tmp/2.jpg', { encoding: 'base64' });
  expect(mockUploadBlobBase64).toHaveBeenNthCalledWith(1, 'b64:file:///tmp/1.jpg', 1000);
  expect(mockUploadBlobBase64).toHaveBeenNthCalledWith(2, 'b64:file:///tmp/2.jpg', 2000);

  expect(out).toEqual([
    { key: sha('first'), mime: 'image/jpeg', width: 100, height: 200, bytes: 1000 },
    { key: sha('second'), mime: 'image/jpeg', width: 300, height: 400, bytes: 2000 },
  ]);
  expect(JSON.stringify(out)).not.toContain('localPath');
});

test('a single blob upload failure rejects the batch before later assets upload', async () => {
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('upload_blob_disk_full'));

  await expect(uploadStagedAttachments([asset(), asset({ uri: 'file:///tmp/b.jpg' })]))
    .rejects.toThrow(/upload_blob_disk_full/);
  expect(mockReadAsStringAsync).toHaveBeenCalledTimes(1);
  expect(mockUploadBlobBase64).toHaveBeenCalledTimes(1);
});

test('a file read failure rejects before starting the blob RPC', async () => {
  mockReadAsStringAsync.mockRejectedValueOnce(new Error('file unavailable'));

  await expect(uploadStagedAttachments([asset()])).rejects.toThrow(/file unavailable/);
  expect(mockUploadBlobBase64).not.toHaveBeenCalled();
});
