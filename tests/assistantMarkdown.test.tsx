// Mobile markdown rendering parity (chat UI hardening batch 1).
//
// FormattedAssistantText now renders assistant prose via the shared chat-core
// `parseMarkdown`/`parseInline`, so `## Done` / `**bold**` render formatted
// instead of literally. These assert the RN element tree, not pixels (visual
// confirmation is the emulator smoke in the spec's validation plan).

import React from 'react';
import { render } from '@testing-library/react-native';
import { ScrollView, View } from 'react-native';
import { parseMarkdown } from 'pentacle-chat-core';

import { deriveMdTableGrid, FormattedAssistantText } from '../app/pentacle/session/[streamId]';

jest.mock('pentacle-chat-core', () => {
  const actual = jest.requireActual('pentacle-chat-core');
  return {
    ...actual,
    parseMarkdown: jest.fn((text: string) => {
      if (text === '__TABLE_TOKEN_FIXTURE__') {
        return [
          {
            type: 'table',
            align: ['left', 'right'],
            header: [[{ type: 'text', value: 'Name' }], [{ type: 'text', value: 'Score' }]],
            rows: [
              [[{ type: 'strong', children: [{ type: 'text', value: 'Ada' }] }], [{ type: 'text', value: '42' }]],
              [[{ type: 'text', value: 'Lin' }], [{ type: 'code', value: '7' }]],
            ],
          },
        ];
      }
      if (text === '__WIDE_TABLE_TOKEN_FIXTURE__') {
        return [
          {
            type: 'table',
            align: ['left', 'center', 'right', null, null],
            header: [
              [{ type: 'text', value: 'Spec' }],
              [{ type: 'text', value: 'State' }],
              [{ type: 'text', value: 'Decision baked in' }],
              [{ type: 'text', value: 'Evidence path' }],
              [{ type: 'text', value: 'Device-build note' }],
            ],
            rows: [
              [
                [{ type: 'code', value: 'spec_pentacle_mobile__chat_table_horizontal_scroll' }],
                [{ type: 'text', value: 'In progress' }],
                [{ type: 'text', value: 'Render parsed cells as a real grid, not flattened text' }],
                [{ type: 'text', value: '.ui-review/mobile-screens/session__wide_table_after.png' }],
                [{ type: 'text', value: 'Driver owns Release build after this report' }],
              ],
            ],
          },
        ];
      }
      return actual.parseMarkdown(text);
    }),
  };
});

// Flatten a RNTL JSON tree to the list of string text leaves + a flat list of
// every style object applied anywhere in the tree.
function collect(node: any, texts: string[], styles: any[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    texts.push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, texts, styles));
    return;
  }
  const s = node.props?.style;
  if (Array.isArray(s)) s.forEach((x) => x && styles.push(x));
  else if (s) styles.push(s);
  collect(node.children, texts, styles);
}

function inspect(text: string) {
  const tree = render(<FormattedAssistantText text={text} />).toJSON();
  const texts: string[] = [];
  const styles: any[] = [];
  collect(tree, texts, styles);
  return { joined: texts.join(''), texts, styles };
}

function styleWidth(style: any): number | null {
  if (!style) return null;
  if (Array.isArray(style)) {
    for (const entry of style) {
      const width = styleWidth(entry);
      if (typeof width === 'number') return width;
    }
    return null;
  }
  return typeof style.width === 'number' ? style.width : null;
}

function cellText(cell: any[]): string {
  return cell.map((node) => {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'code') return node.value || '';
    if (Array.isArray(node.children)) return cellText(node.children);
    return '';
  }).join('');
}

test('heading: "## Done" renders "Done" without the literal "##" markers', () => {
  const { joined } = inspect('## Done');
  expect(joined).toContain('Done');
  expect(joined).not.toContain('## Done');
  expect(joined).not.toContain('##');
});

test('bold: "**bold**" renders "bold" with fontWeight 700 and no asterisks', () => {
  const { joined, styles } = inspect('a **bold** b');
  expect(joined).toContain('bold');
  expect(joined).not.toContain('**');
  expect(styles.some((s) => s.fontFamily === 'Rajdhani_700Bold')).toBe(true);
});

test('italic: "_it_" renders italic without underscores', () => {
  const { joined, styles } = inspect('say _it_ now');
  expect(joined).toContain('it');
  expect(joined).not.toContain('_it_');
  expect(styles.some((s) => s.fontStyle === 'italic')).toBe(true);
});

test('inline code: "`x`" renders without backticks and with code styling', () => {
  const { joined, styles } = inspect('run `npm test` ok');
  expect(joined).toContain('npm test');
  expect(joined).not.toContain('`');
  expect(styles.some((s) => s.backgroundColor === '#3dff661c')).toBe(true);
});

test('snake_case is NOT italicized (boundary rule)', () => {
  const { joined } = inspect('call foo_bar_baz here');
  expect(joined).toContain('foo_bar_baz');
});

test('table block token preserves all visible cell text', () => {
  const { joined } = inspect('__TABLE_TOKEN_FIXTURE__');
  expect(joined).toContain('Name');
  expect(joined).toContain('Score');
  expect(joined).toContain('Ada');
  expect(joined).toContain('42');
  expect(joined).toContain('Lin');
  expect(joined).toContain('7');
});

test('wide table grid derives columns, text, and per-column alignment', () => {
  const [table] = parseMarkdown([
    '| Spec | State | Decision baked in | Evidence path | Owner |',
    '| :--- | :---: | ---: | --- | --- |',
    '| `spec_mobile` | In progress | Real cell grid, no flattened monospace table | .ui-review/mobile-screens/session__wide_table_after.png | hostc Codex |',
  ].join('\n'));

  const grid = deriveMdTableGrid(table);

  expect(grid?.columns).toHaveLength(5);
  expect(grid?.columns.map((column) => column.align)).toEqual(['left', 'center', 'right', null, null]);
  expect(cellText(grid?.header[2] || [])).toBe('Decision baked in');
  expect(cellText(grid?.rows[0]?.[0] || [])).toBe('spec_mobile');
  expect(grid?.totalMinWidth).toBeGreaterThan(390);
});

test('narrow table grid stays below a phone viewport instead of forcing overflow', () => {
  const [table] = parseMarkdown([
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
  ].join('\n'));

  const grid = deriveMdTableGrid(table);

  expect(grid?.columns).toHaveLength(2);
  expect(grid?.totalMinWidth).toBeLessThan(390);
});

test('wide table renders horizontal scroll content wider than the phone viewport', () => {
  const rendered = render(<FormattedAssistantText text="__WIDE_TABLE_TOKEN_FIXTURE__" />);
  const tableScroll = rendered.UNSAFE_getAllByType(ScrollView).find((node) => node.props.horizontal);
  expect(tableScroll).toBeTruthy();

  const contentWidths = rendered.UNSAFE_getAllByType(View)
    .map((node) => styleWidth(node.props.style))
    .filter((width): width is number => typeof width === 'number');
  expect(Math.max(...contentWidths)).toBeGreaterThan(390);
});
