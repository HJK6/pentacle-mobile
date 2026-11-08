import { createImageGallery } from '../src/services/imageGallery';

const image = { key: 'same-bytes', mime: 'image/png', uri: 'file:///same.png', width: 10, height: 20 };
test('snapshot uses chronological rows and original attachment indexes, preserving repeated occurrences', () => {
  const rows = [
    { id: 'new', attachments: [image] },
    { id: 'old', attachments: [{ key: 'file', mime: 'application/pdf' }, image, { ...image, uri: 'file:///other.png' }] },
  ];
  const gallery = createImageGallery(rows, 'old', 2)!;
  expect(gallery.images.map(x => [x.rowId, x.attachmentIndex])).toEqual([['old', 1], ['old', 2], ['new', 0]]);
  expect(gallery.initialIndex).toBe(1);
  expect(new Set(gallery.images.map(x => x.id)).size).toBe(3);
  rows.unshift({ id: 'live', attachments: [image] });
  rows[1].attachments[0].key = 'reconciled';
  expect(gallery.images).toHaveLength(3);
  expect(gallery.images[2].attachment.key).toBe('same-bytes');
  expect(createImageGallery(rows, 'new', 0)!.images).toHaveLength(4);
});
test('non-image selection and empty transcripts cannot open an unrelated image', () => {
  expect(createImageGallery([], 'missing', 0)).toBeNull();
  expect(createImageGallery([{ id: 'row', attachments: [{ key: 'pdf', mime: 'application/pdf' }, image] }], 'row', 0)).toBeNull();
});
