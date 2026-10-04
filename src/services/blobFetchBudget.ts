/** Bound retained wire chunks before decoding or full-body assembly. */
export const GENERIC_BLOB_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_BLOB_CHUNKS = 4096;
export type BlobFetchBudget = { maxBytes: number; bytes: number; chars: number; chunks: number };
export function newBlobFetchBudget(maxBytes = GENERIC_BLOB_MAX_BYTES): BlobFetchBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > GENERIC_BLOB_MAX_BYTES) {
    throw new Error('Invalid blob byte budget');
  }
  return { maxBytes, bytes: 0, chars: 0, chunks: 0 };
}
export function acceptBlobChunk(budget: BlobFetchBudget, chunk: string): void {
  const maxChars = Math.ceil(budget.maxBytes / 3) * 4 + 4 * MAX_BLOB_CHUNKS;
  // Check lengths first: do not retain/decode an oversized frame, even if its
  // final size hint claims something smaller. Independent chunks have padding.
  if (budget.chunks >= MAX_BLOB_CHUNKS || budget.chars + chunk.length > maxChars) {
    throw Object.assign(new Error('blob_too_large'), { code: 'blob_too_large' });
  }
  if (chunk.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)) {
    throw Object.assign(new Error('blob_invalid_encoding'), { code: 'blob_invalid_encoding' });
  }
  const padding = chunk.endsWith('==') ? 2 : chunk.endsWith('=') ? 1 : 0;
  const size = chunk.length / 4 * 3 - padding;
  if (budget.bytes + size > budget.maxBytes) {
    throw Object.assign(new Error('blob_too_large'), { code: 'blob_too_large' });
  }
  budget.bytes += size;
  budget.chars += chunk.length;
  budget.chunks += 1;
}
