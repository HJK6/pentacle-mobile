import { transcriptOrderChunks } from '../src/utils/harnessTranscriptOrder';

test('long exact transcript order survives bounded native log records', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `${i}`);
  ids.splice(3, 0, 'session-question-answer-durable:6dfbbd2e-8a1c-49b8-9149-2893d9e9ba98:q-live-20260908T001207Z');
  const chunks = transcriptOrderChunks('hostc:v2-3748a0ff', 'generation-1', ids);
  expect(chunks.flatMap(c => c.row_ids)).toEqual(ids);
  chunks.forEach((chunk, offset) => {
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(700);
    expect(chunk).toMatchObject({ offset, row_count: ids.length, order_id: 'generation-1' });
  });
});

test('oversize identity fails closed without truncating or publishing a partial order', () => {
  expect(transcriptOrderChunks('owned', 'g', ['first', '界'.repeat(700)])).toEqual([]);
});
