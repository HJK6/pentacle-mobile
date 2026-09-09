// optimistic_send_stuck_after_daemon_restart_2026_09 — the upload leg of the
// optimistic unit, exercised at the SEAM(A2) `uploadBlobBase64` boundary with
// the real `uploadStagedAttachments` in between: a socket drop during the blob
// upload fails the row (retryable) instead of leaving it "sending", and the
// staged asset is retained so Retry re-uploads without re-picking.

const mockUploadBlobBase64 = jest.fn();
const mockReadAsStringAsync = jest.fn();

jest.mock('../src/services/pentacleStream', () => ({
  uploadBlobBase64: (...args: unknown[]) => mockUploadBlobBase64(...args),
}));

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: (...args: unknown[]) => mockReadAsStringAsync(...args),
  EncodingType: { Base64: 'base64' },
}));

import { beginStagedUpload, settleUploadLeg, withRenderUris } from '../src/services/optimisticSendUnit';
import type { ProcessedAsset } from '../src/services/imageCapture';

const staged: ProcessedAsset[] = [{
  uri: 'file:///tmp/photo.jpg',
  fileName: 'photo.jpg',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 800,
  bytes: 204800,
}];
const thumbs = [{ uri: 'file:///tmp/photo.jpg', width: 1200, height: 800 }];

function actionsMock() {
  return {
    replaceOptimisticAttachments: jest.fn(),
    markOptimisticFailed: jest.fn(),
    retainUploadForRetry: jest.fn(),
  };
}

beforeEach(() => {
  mockUploadBlobBase64.mockReset();
  mockReadAsStringAsync.mockReset();
  mockReadAsStringAsync.mockResolvedValue('b64');
});

test('a socket drop during the blob upload fails the row (retryable) and rethrows', async () => {
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('Pentacle stream disconnected'));
  const actions = actionsMock();

  await expect(settleUploadLeg({
    optimisticId: 'opt-1',
    optimisticAttachments: [{ key: 'local:0:file:///tmp/photo.jpg', mime: 'image/jpeg' }],
    thumbs,
    upload: beginStagedUpload(staged),
    actions,
  })).rejects.toThrow('Pentacle stream disconnected');

  expect(actions.markOptimisticFailed).toHaveBeenCalledWith('opt-1', 'Pentacle stream disconnected');
  expect(actions.replaceOptimisticAttachments).not.toHaveBeenCalled();
});

test('an explicit upload_blob rejection is terminal too', async () => {
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('upload_blob_unknown_request_id'));
  const actions = actionsMock();
  await expect(settleUploadLeg({ optimisticId: 'opt-2', upload: beginStagedUpload(staged), actions }))
    .rejects.toThrow('upload_blob_unknown_request_id');
  expect(actions.markOptimisticFailed).toHaveBeenCalledWith('opt-2', 'upload_blob_unknown_request_id');
});

test('the staged asset is retained for Retry, and the re-upload reads the compressed file again', async () => {
  mockUploadBlobBase64.mockRejectedValueOnce(new Error('Pentacle stream is not connected'));
  const actions = actionsMock();
  await settleUploadLeg({ optimisticId: 'opt-3', thumbs, upload: beginStagedUpload(staged), actions }).catch(() => {});

  expect(actions.retainUploadForRetry).toHaveBeenCalledWith('opt-3', expect.any(Function));
  const reupload = actions.retainUploadForRetry.mock.calls[0][1] as () => Promise<unknown>;
  mockUploadBlobBase64.mockResolvedValueOnce({ blob_sha: 'a'.repeat(64), size_bytes: 204800 });
  await expect(reupload()).resolves.toEqual([
    expect.objectContaining({ key: 'a'.repeat(64), mime: 'image/jpeg', uri: 'file:///tmp/photo.jpg' }),
  ]);
  expect(mockReadAsStringAsync).toHaveBeenCalledTimes(2);
  expect(mockReadAsStringAsync).toHaveBeenLastCalledWith('file:///tmp/photo.jpg', expect.anything());
});

test('a successful upload swaps the row to blob keys (thumbs kept) and returns the wire attachments', async () => {
  mockUploadBlobBase64.mockResolvedValueOnce({ blob_sha: 'b'.repeat(64), size_bytes: 204800 });
  const actions = actionsMock();
  const wire = await settleUploadLeg({ optimisticId: 'opt-4', thumbs, upload: beginStagedUpload(staged), actions });

  expect(wire).toEqual([expect.objectContaining({ key: 'b'.repeat(64), mime: 'image/jpeg', bytes: 204800 })]);
  expect(wire?.[0]).not.toHaveProperty('uri');
  expect(actions.replaceOptimisticAttachments).toHaveBeenCalledWith('opt-4', [
    expect.objectContaining({ key: 'b'.repeat(64), uri: 'file:///tmp/photo.jpg' }),
  ]);
  expect(actions.markOptimisticFailed).not.toHaveBeenCalled();
});

test('no upload means no retention and the optimistic attachments pass through', async () => {
  const actions = actionsMock();
  await expect(settleUploadLeg({ optimisticId: 'opt-5', optimisticAttachments: undefined, actions })).resolves.toBeUndefined();
  expect(actions.retainUploadForRetry).not.toHaveBeenCalled();
  expect(withRenderUris(undefined, thumbs)).toBeUndefined();
});
