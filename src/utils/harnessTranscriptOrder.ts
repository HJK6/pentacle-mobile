/** Small records preserve exact order when the native log transport caps a line. */
export function transcriptOrderChunks(streamId: string, orderId: string, ids: string[]) {
  const chunks = ids.map((id, offset) => ({
    kind: 'transcript_order_chunk', stream_id: streamId, order_id: orderId,
    row_count: ids.length, offset, row_ids: [id],
  }));
  // encodeURIComponent counts UTF-8 bytes without depending on a native encoder.
  const bytes = (value: unknown) => encodeURIComponent(JSON.stringify(value)).replace(/%[A-F0-9]{2}/g, 'x').length;
  return chunks.every(chunk => bytes(chunk) <= 700) ? chunks : [];
}
