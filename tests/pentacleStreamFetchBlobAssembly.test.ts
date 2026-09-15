import { fromByteArray, toByteArray } from 'base64-js';

import { assembleFetchBlobChunks } from '../src/services/pentacleStream';

// The daemon streams a blob >1 MiB as multiple fetch_blob frames, each chunk
// INDEPENDENTLY base64-encoded, splitting on a 1 MiB byte boundary.
const DAEMON_CHUNK_BYTES = 1024 * 1024; // 1048576

function makeBlob(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

// Reproduce the daemon's wire framing: independent base64 per DAEMON_CHUNK_BYTES slice.
function daemonChunks(blob: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let off = 0; off < blob.length; off += DAEMON_CHUNK_BYTES) {
    chunks.push(fromByteArray(blob.subarray(off, Math.min(off + DAEMON_CHUNK_BYTES, blob.length))));
  }
  return chunks;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

describe('assembleFetchBlobChunks', () => {
  it('assembles a >1 MiB blob byte-for-byte across independently base64-encoded chunks', () => {
    const blob = makeBlob(DAEMON_CHUNK_BYTES + 500_000); // ~1.5 MiB -> 2 frames
    const chunks = daemonChunks(blob);
    expect(chunks.length).toBe(2);
    // The first chunk (1048576 bytes, not a multiple of 3) carries base64 padding.
    expect(chunks[0].endsWith('=')).toBe(true);

    const assembled = assembleFetchBlobChunks(chunks);
    const decoded = toByteArray(assembled);
    expect(decoded.length).toBe(blob.length);
    expect(bytesEqual(decoded, blob)).toBe(true);
  });

  it('assembles a blob spanning more than two chunks', () => {
    const blob = makeBlob(DAEMON_CHUNK_BYTES * 3 + 17); // 4 frames, odd tail
    const chunks = daemonChunks(blob);
    expect(chunks.length).toBe(4);
    const decoded = toByteArray(assembleFetchBlobChunks(chunks));
    expect(decoded.length).toBe(blob.length);
    expect(bytesEqual(decoded, blob)).toBe(true);
  });

  it('regression: naive string concatenation truncates the multi-chunk blob', () => {
    // Documents the historical bug: joining the base64 STRINGS then decoding
    // stops at the first padded chunk boundary, so it does NOT round-trip.
    const blob = makeBlob(DAEMON_CHUNK_BYTES + 500_000);
    const chunks = daemonChunks(blob);
    const naive = toByteArray(chunks.join(''));
    expect(naive.length).toBeLessThan(blob.length);
    expect(bytesEqual(naive, blob)).toBe(false);
  });

  it('returns a single sub-1 MiB chunk unchanged (preserves the smaller-image path)', () => {
    const blob = makeBlob(64_000);
    const only = fromByteArray(blob);
    const assembled = assembleFetchBlobChunks([only]);
    expect(assembled).toBe(only);
    expect(bytesEqual(toByteArray(assembled), blob)).toBe(true);
  });

  it('returns an empty string for no chunks', () => {
    expect(assembleFetchBlobChunks([])).toBe('');
  });
});
