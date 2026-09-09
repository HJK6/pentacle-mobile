import { parseInline, parseMarkdown } from 'pentacle-chat-core';

test('inline parser preserves text while recognizing safe formatting and links', () => {
  expect(parseInline('before `code` after')).toEqual([
    { type: 'text', value: 'before ' },
    { type: 'code', value: 'code' },
    { type: 'text', value: ' after' },
  ]);
  expect(parseInline('**bold** *em* __strong__ _italic_')).toEqual([
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
    { type: 'text', value: ' ' },
    { type: 'em', children: [{ type: 'text', value: 'em' }] },
    { type: 'text', value: ' ' },
    { type: 'strong', children: [{ type: 'text', value: 'strong' }] },
    { type: 'text', value: ' ' },
    { type: 'em', children: [{ type: 'text', value: 'italic' }] },
  ]);
  expect(parseInline('[site](https://example.com) [mail](mailto:a@example.com) [local](../doc) [anchor](#part)'))
    .toEqual([
      { type: 'link', href: 'https://example.com', children: [{ type: 'text', value: 'site' }] },
      { type: 'text', value: ' ' },
      { type: 'link', href: 'mailto:a@example.com', children: [{ type: 'text', value: 'mail' }] },
      { type: 'text', value: ' ' },
      { type: 'link', href: '../doc', children: [{ type: 'text', value: 'local' }] },
      { type: 'text', value: ' ' },
      { type: 'link', href: '#part', children: [{ type: 'text', value: 'anchor' }] },
    ]);
});

test('inline parser degrades malformed or unsafe markup to visible non-link text', () => {
  expect(parseInline('[unsafe](javascript:alert)')).toEqual([{ type: 'text', value: 'unsafe' }]);
  expect(parseInline('[space](https://example.com/a b)')).toEqual([{ type: 'text', value: 'space' }]);
  expect(parseInline('[empty]()')).toEqual([{ type: 'text', value: 'empty' }]);
  expect(parseInline('[open](https://example.com')).toEqual([{ type: 'text', value: '[open](https://example.com' }]);
  expect(parseInline('[broken] plain')).toEqual([{ type: 'text', value: '[broken] plain' }]);
  expect(parseInline('` open ** ** snake_case _open')).toEqual([
    { type: 'text', value: '` open ** ** snake_case _open' },
  ]);
  expect(parseInline('word_em_ and _em_word')).toEqual([{ type: 'text', value: 'word_em_ and _em_word' }]);
  expect(parseInline('[**safe**](/docs)')).toEqual([
    { type: 'link', href: '/docs', children: [{ type: 'strong', children: [{ type: 'text', value: 'safe' }] }] },
  ]);
});

test('block parser recognizes headings, rules, fenced code, and ordered/unordered lists', () => {
  expect(parseMarkdown('\r\n## Release\r\n---\r\n```ts\r\nconst ok = true;\r\n```\r\n- one\r\n* two\r\n1. first\r\n2) second'))
    .toEqual([
      { type: 'heading', level: 2, children: [{ type: 'text', value: 'Release' }] },
      { type: 'hr' },
      { type: 'code_block', lang: 'ts', text: 'const ok = true;' },
      { type: 'list', ordered: false, items: [[{ type: 'text', value: 'one' }], [{ type: 'text', value: 'two' }]] },
      { type: 'list', ordered: true, items: [[{ type: 'text', value: 'first' }], [{ type: 'text', value: 'second' }]] },
    ]);
  expect(parseMarkdown('```\nunclosed')).toEqual([{ type: 'code_block', lang: null, text: 'unclosed' }]);
  expect(parseMarkdown('***\n___')).toEqual([{ type: 'hr' }, { type: 'hr' }]);
});

test('table parser enforces shape, preserves alignment, and stops before ordinary prose', () => {
  expect(parseMarkdown('| Left | Center | Right | Plain |\n| :--- | :---: | ---: | --- |\n| **A** | B | `C` | D |\nafter')).toEqual([
    {
      type: 'table',
      align: ['left', 'center', 'right', null],
      header: [
        [{ type: 'text', value: 'Left' }],
        [{ type: 'text', value: 'Center' }],
        [{ type: 'text', value: 'Right' }],
        [{ type: 'text', value: 'Plain' }],
      ],
      rows: [[
        [{ type: 'strong', children: [{ type: 'text', value: 'A' }] }],
        [{ type: 'text', value: 'B' }],
        [{ type: 'code', value: 'C' }],
        [{ type: 'text', value: 'D' }],
      ]],
    },
    { type: 'paragraph', children: [{ type: 'text', value: 'after' }] },
  ]);
  expect(parseMarkdown('A | B\n---\nplain')).toEqual([
    { type: 'paragraph', children: [{ type: 'text', value: 'A | B' }] },
    { type: 'hr' },
    { type: 'paragraph', children: [{ type: 'text', value: 'plain' }] },
  ]);
  expect(parseMarkdown('A | B\n--- | nope\nplain')).toEqual([
    { type: 'paragraph', children: [{ type: 'text', value: 'A | B' }, { type: 'break' }, { type: 'text', value: '--- | nope' }, { type: 'break' }, { type: 'text', value: 'plain' }] },
  ]);
  expect(parseMarkdown('A | B\n--- | --- | ---')).toEqual([
    { type: 'paragraph', children: [{ type: 'text', value: 'A | B' }, { type: 'break' }, { type: 'text', value: '--- | --- | ---' }] },
  ]);
});

test('paragraph parser preserves intentional line breaks and separates later block starts', () => {
  expect(parseMarkdown('first line\nsecond **line**\n\n### Next\nparagraph')).toEqual([
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'first line' },
        { type: 'break' },
        { type: 'text', value: 'second ' },
        { type: 'strong', children: [{ type: 'text', value: 'line' }] },
      ],
    },
    { type: 'heading', level: 3, children: [{ type: 'text', value: 'Next' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'paragraph' }] },
  ]);
  expect(parseMarkdown(null as never)).toEqual([]);
});
