import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, render, type RenderAPI } from '@testing-library/react-native';
import {
  AnimatedSpinnerGlyph,
  computeActiveThinkingRowId,
  FileActionCard,
  isPreformattedText,
  normalizePipeTable,
  parseAssistantBlocks,
  PreformattedScrollBlock,
  TranscriptRow,
} from '../app/pentacle/session/[streamId]';
import type { PentacleTranscriptItem } from 'pentacle-chat-core';
import { collapsedDisclosurePresentation } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

function expectPresent<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeTruthy();
}
(globalThis as typeof globalThis & { requestAnimationFrame?: (callback: FrameRequestCallback) => number }).requestAnimationFrame = (callback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
(globalThis as typeof globalThis & { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame = (handle) => {
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

type TestNode = ReturnType<RenderAPI['UNSAFE_getByType']>;

const chrome = {
  header: '#102a4a',
  accent: '#4da3ff',
  surface: '#0c1827',
  border: '#2f6ca5',
  title: 'Beta',
};

function textOf(node: TestNode): string {
  const children = node.props.children;
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return '';
    }).join('');
  }
  return '';
}

function findTextNode(renderer: RenderAPI, pattern: RegExp): TestNode {
  const match = renderer.UNSAFE_getAllByType(Text).find((node) => pattern.test(textOf(node)));
  expectPresent(match);
  return match;
}

function allText(renderer: RenderAPI): string {
  return renderer.UNSAFE_getAllByType(Text).map((node) => textOf(node)).join('\n');
}

function hasTranscriptActivityDot(renderer: RenderAPI): boolean {
  return renderer.UNSAFE_getAllByType(View).some((node) => {
    const style = StyleSheet.flatten(node.props.style) || {};
    return style.width === 6 && style.height === 6 && style.borderRadius === 999;
  });
}

function transcriptItem(overrides: Partial<PentacleTranscriptItem>): PentacleTranscriptItem {
  const item: PentacleTranscriptItem = {
    id: 'row-1',
    timestampLabel: '',
    label: 'Tool',
    tone: 'tool',
    provider: 'claude',
    source: 'claude-jsonl',
    text: '',
    kind: 'TOOL_USE',
    isUser: false,
    eventCase: 'tool-use',
    displayRule: 'activity:command',
    ...overrides,
  };
  if (!item.disclosure && (item.kind === 'TOOL_USE' || item.displayRule === 'activity:tool-output') && item.text.trim()) {
    item.disclosure = collapsedDisclosurePresentation(item.text);
  }
  return item;
}

test('parseAssistantBlocks recognizes Codex file actions with diff bodies', () => {
  expect(parseAssistantBlocks('Added foo.ts (+12 -0)\n1 +line\n2 +line')).toEqual([
    {
      type: 'edit',
      title: 'Added foo.ts',
      meta: '+12 -0',
      body: '1 +line\n2 +line',
    },
  ]);

  expect(parseAssistantBlocks('Edited foo.ts (+1 -1)\n1 -old\n1 +new')).toEqual([
    {
      type: 'edit',
      title: 'Edited foo.ts',
      meta: '+1 -1',
      body: '1 -old\n1 +new',
    },
  ]);
});

test('FileActionCard expands from the non-selectable header and keeps body selectable', () => {
  const body = Array.from({ length: 8 }, (_, index) => `${index + 1} +line-${index + 1}`).join('\n');
  let renderer: RenderAPI | undefined;

  renderer = render(
      <FileActionCard title="Added foo.ts" meta="+8 -0" body={body} chrome={chrome} />,
    );

  const rendered = renderer as RenderAPI;
  expect(findTextNode(rendered, /Added foo\.ts/).props.selectable).toBe(false);
  expect(findTextNode(rendered, /1 \+line-1/).props.selectable).toBe(true);
  expect(textOf(findTextNode(rendered, /\+2 lines?/))).toMatch(/\+2 lines?/);
  expect(() => findTextNode(rendered, /8 \+line-8/)).toThrow();

  const header = rendered.UNSAFE_getByProps({ testID: 'file-action-header' });
  act(() => {
    header.props.onPress();
  });

  expect(findTextNode(rendered, /8 \+line-8/).props.selectable).toBe(true);
  expect(() => findTextNode(rendered, /\+2 lines?/)).toThrow();

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow bounds activity file-change diff detail', () => {
  const body = Array.from({ length: 55 }, (_, index) => `${index + 1} +line-${String(index + 1).padStart(2, '0')}`).join('\n');
  const item: PentacleTranscriptItem = {
    id: 'file-change-1',
    timestampLabel: '',
    label: 'Agent',
    tone: 'assistant',
    provider: 'codex',
    source: 'tmux-pane',
    text: `Added ~/foo/bar.ts (+55 -0)\n${body}`,
    kind: 'ASSIST',
    isUser: false,
    eventCase: 'write-action',
    displayRule: 'activity:file-change',
  };
  let renderer: RenderAPI | undefined;

  renderer = render(<TranscriptRow item={item} chrome={chrome} />);

  const rendered = renderer as RenderAPI;
  const detail = findTextNode(rendered, /line-01/);
  const detailText = textOf(detail);
  expect(detailText.length < 400).toBeTruthy();
  expect(detailText).toMatch(/(\.\.\.|…)$/);
  expect(detailText.includes('line-55')).toBe(false);

  act(() => {
    rendered.unmount();
  });
});

const jsonlToolCases = [
  ['Bash', 'Bash(npm run test:unit -- --watch)', 'npm run test:unit -- --watch', 'activity:command'],
  ['Read', 'Read /tmp/synthetic/repos/pentacle-mobile/app.tsx', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:explored'],
  ['Edit', 'Edit /tmp/synthetic/repos/pentacle-mobile/app.tsx', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:file-change'],
  ['Write', 'Write /tmp/synthetic/repos/pentacle-mobile/app.tsx', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:file-change'],
  ['Grep', 'Grep: pattern: "TranscriptRow" · path: "app/pentacle/session"', 'pattern: "TranscriptRow"', 'activity:explored'],
  ['Glob', 'Glob: pattern: "**/*.tsx" · path: "tests"', 'pattern: "**/*.tsx"', 'activity:explored'],
  ['Agent', 'Agent: Audit ws view mapping\n1 child event', 'Audit ws view mapping', 'activity:collapsed-tool'],
  ['TodoWrite', 'TodoWrite {"todos":[{"content":"ship tests"}]}', '{"todos":[{"content":"ship tests"}]}', 'activity:command'],
] as const;

for (const [title, text, body, displayRule] of jsonlToolCases) {
  test(`TranscriptRow renders JSONL ${title} TOOL_USE as a tool card`, () => {
    let renderer: RenderAPI | undefined;
    const item = transcriptItem({
      id: `jsonl-${title}`,
      text,
      displayRule,
    });

    renderer = render(
        <TranscriptRow
          item={item}
          chrome={chrome}
        />,
      );

    const rendered = renderer as RenderAPI;
    const card = rendered.getByTestId(`tool-result-card-jsonl-${title}`);
    expect(card.props.accessibilityLabel).toContain(item.disclosure?.previewText);
    expect(item.disclosure?.expandedText).toContain(body);
    if (item.disclosure?.expandable) {
      fireEvent.press(card);
      expect(allText(rendered)).toContain(body);
    } else {
      expect(allText(rendered)).toContain(body);
    }
    expect(allText(rendered).includes('⏺')).toBe(false);

    act(() => {
      rendered.unmount();
    });
  });
}

const paneToolCases = [
  ['Bash', 'Bash(npm run typecheck)', 'npm run typecheck', 'activity:command'],
  ['Read', 'Read(/tmp/synthetic/repos/pentacle-mobile/app.tsx)', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:explored'],
  ['Edit', 'Edit(/tmp/synthetic/repos/pentacle-mobile/app.tsx)', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:file-change'],
  ['Write', 'Write(/tmp/synthetic/repos/pentacle-mobile/app.tsx)', '/tmp/synthetic/repos/pentacle-mobile/app.tsx', 'activity:file-change'],
  ['Grep', 'Grep(pattern: "TranscriptRow", path: "app/pentacle/session")', 'pattern: "TranscriptRow"', 'activity:explored'],
  ['Glob', 'Glob(pattern: "**/*.tsx", path: "tests")', 'pattern: "**/*.tsx"', 'activity:explored'],
  ['Agent', 'Agent(Audit ws view mapping)', 'Audit ws view mapping', 'activity:command'],
  ['TodoWrite', 'TodoWrite({"todos":[{"content":"ship tests"}]})', '{"todos":[{"content":"ship tests"}]}', 'activity:command'],
] as const;

for (const [title, text, body, displayRule] of paneToolCases) {
  test(`TranscriptRow renders pane-scrape Claude ${title} activity as a tool card`, () => {
    let renderer: RenderAPI | undefined;

    renderer = render(
        <TranscriptRow
          item={transcriptItem({
            id: `pane-${title}`,
            kind: 'ASSIST',
            eventCase: 'tool-command',
            source: 'tmux-pane',
            text,
            displayRule,
          })}
          chrome={chrome}
        />,
      );

    const rendered = renderer as RenderAPI;
    expect(textOf(findTextNode(rendered, new RegExp(`^${title}$`)))).toBe(title);
    expect(allText(rendered)).toMatch(new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(allText(rendered).includes('⏺')).toBe(false);

    act(() => {
      rendered.unmount();
    });
  });
}

for (const text of ['Explored src/services/pentacleChatModel.ts', 'Edited app/pentacle/session/[streamId].tsx', 'Wrote tests/sessionFileAction.test.tsx']) {
  test(`TranscriptRow keeps past-tense activity as a dotless pill: ${text.split(' ')[0]}`, () => {
    let renderer: RenderAPI | undefined;

    renderer = render(
        <TranscriptRow
          item={transcriptItem({
            id: `past-${text}`,
            kind: 'ASSIST',
            eventCase: text.startsWith('Explored') ? 'explore-action' : text.startsWith('Edited') ? 'edit-action' : 'write-action',
            source: 'tmux-pane',
            text,
            displayRule: text.startsWith('Explored') ? 'activity:explored' : 'activity:file-change',
          })}
          chrome={chrome}
        />,
      );

    const rendered = renderer as RenderAPI;
    expect(textOf(findTextNode(rendered, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))).toBe(text);
    expect(allText(rendered).includes('Tool')).toBe(false);
    expect(hasTranscriptActivityDot(rendered)).toBe(false);

    act(() => {
      rendered.unmount();
    });
  });
}

test('TranscriptRow leaves Codex activity text as a dotless pill instead of a Claude tool card', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'codex-activity',
          provider: 'codex',
          source: 'tmux-pane',
          kind: 'ASSIST',
          eventCase: 'tool-command',
          text: 'Bash(npm run test:unit)',
          displayRule: 'activity:command',
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  expect(textOf(findTextNode(rendered, /^Bash\(npm run test:unit\)$/))).toBe('Bash(npm run test:unit)');
  expect(allText(rendered).includes('npm run test:unit\n')).toBe(false);
  expect(hasTranscriptActivityDot(rendered)).toBe(false);

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow renders non-tool activity without a leading dot element', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'thinking-activity',
          provider: 'claude',
          source: 'claude-jsonl',
          kind: 'THINKING',
          eventCase: 'thinking',
          text: 'Considering the next edit',
          displayRule: 'activity:thinking',
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  expect(textOf(findTextNode(rendered, /Considering the next edit/))).toBe('Considering the next edit');
  expect(hasTranscriptActivityDot(rendered)).toBe(false);

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow animates only the latest thinking activity row', () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  (globalThis as typeof globalThis & { setInterval: typeof setInterval }).setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    intervalCount += 1;
    return originalSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  let renderer: RenderAPI | undefined;

  try {
    renderer = render(
        <>
          <TranscriptRow
            item={transcriptItem({
              id: 'thinking-historical',
              provider: 'claude',
              source: 'claude-jsonl',
              kind: 'THINKING',
              eventCase: 'thinking',
              text: 'Historical thinking',
              displayRule: 'activity:thinking',
            })}
            chrome={chrome}
            isLatestThinking={false}
          />
          <TranscriptRow
            item={transcriptItem({
              id: 'thinking-latest',
              provider: 'claude',
              source: 'claude-jsonl',
              kind: 'THINKING',
              eventCase: 'thinking',
              text: 'Latest thinking',
              displayRule: 'activity:thinking',
            })}
            chrome={chrome}
            isLatestThinking
          />
        </>,
      );

    const rendered = renderer as RenderAPI;
    expect(rendered.UNSAFE_getAllByType(AnimatedSpinnerGlyph).length).toBe(1);
    expect(intervalCount).toBe(1);
    expect(textOf(findTextNode(rendered, /^Historical thinking$/))).toBe('Historical thinking');
    expect(textOf(findTextNode(rendered, /^Latest thinking$/))).toBe('Latest thinking');
    expect(rendered.UNSAFE_getAllByType(Text).filter((node) => textOf(node) === '✻').length).toBe(1);
  } finally {
    act(() => {
      (renderer as RenderAPI | undefined)?.unmount();
    });
    (globalThis as typeof globalThis & { setInterval: typeof setInterval }).setInterval = originalSetInterval;
  }
});

test('TranscriptRow hides empty TOOL_RESULT rows', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'empty-tool-result',
          kind: 'TOOL_RESULT',
          eventCase: 'tool-result',
          text: '   \n  ',
          displayRule: 'activity:tool-output',
        })}
        chrome={chrome}
      />,
    );

  expect((renderer as RenderAPI).toJSON()).toBe(null);

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('TranscriptRow renders TOOL_BATCH_SUMMARY as plain indented summary text', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        chrome={chrome}
        item={transcriptItem({
          kind: 'TOOL_BATCH_SUMMARY',
          eventCase: 'tool-batch',
          displayRule: 'activity:tool-batch',
          text: 'Searched for 1 pattern, read 3 files',
        })}
      />,
    );

  const text = allText(renderer as RenderAPI);
  expect(text).toMatch(/Searched for 1 pattern, read 3 files/);
  expect(text).not.toMatch(/⎿/);

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('TranscriptRow renders multi-line TOOL_RESULT as one native-clipped body line without a literal tail', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'multiline-tool-result',
          kind: 'TOOL_RESULT',
          eventCase: 'tool-result',
          text: 'first line\nsecond line\nthird line',
          displayRule: 'activity:tool-output',
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  const preview = findTextNode(rendered, /^first line$/);
  expect(textOf(preview)).toBe('first line');
  expect(preview.props.numberOfLines).toBe(1);
  expect(allText(rendered)).not.toMatch(/… \+2 lines|more/i);
  expect(rendered.UNSAFE_getAllByType(Text).filter((node) => textOf(node) === 'first line').length).toBe(1);
  expect(() => findTextNode(rendered, /second line/)).toThrow();

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow hides activity code-block TOOL_RESULT rows', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'read-tool-result',
          kind: 'TOOL_RESULT',
          eventCase: 'code-block',
          text: '1\tconst value = 1;',
          displayRule: 'activity:code-block',
        })}
        chrome={chrome}
      />,
    );

  expect((renderer as RenderAPI).toJSON()).toBe(null);

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('TranscriptRow renders file-tool error output as one-line tool result', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'file-tool-error-result',
          kind: 'TOOL_RESULT',
          eventCase: 'tool-result',
          text: 'File must be read first',
          displayRule: 'activity:tool-output',
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  expect(textOf(findTextNode(rendered, /^⎿$/))).toBe('⎿');
  expect(textOf(findTextNode(rendered, /^File must be read first$/))).toBe('File must be read first');

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow previews TOOL_RESULT text without the manage suffix and preserves exact expansion', () => {
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'manage-suffix-tool-result',
          kind: 'TOOL_RESULT',
          eventCase: 'tool-result',
          text: 'Running in the background',
          displayRule: 'activity:tool-output',
          disclosure: collapsedDisclosurePresentation(
            'Running in the background',
            'Running in the background (↓ to manage)',
          ),
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  expect(textOf(findTextNode(rendered, /^Running in the background$/))).toBe('Running in the background');
  expect(allText(rendered).includes('(↓ to manage)')).toBe(false);
  fireEvent.press(rendered.getByTestId('tool-result-card-manage-suffix-tool-result'));
  expect(allText(rendered).includes('(↓ to manage)')).toBe(true);

  act(() => {
    rendered.unmount();
  });
});

test('isPreformattedText detects box-drawing tables, pipe tables, and ignores plain prose', () => {
  expect(isPreformattedText('plain prose with no box drawing')).toBe(false);
  expect(isPreformattedText('one line | with one pipe')).toBe(false);
  expect(isPreformattedText('| col a | col b |\n| ----- | ----- |\n| 1     | 2     |')).toBe(true);
  expect(isPreformattedText('┌──────┬──────┐\n│ a    │ b    │\n└──────┴──────┘')).toBe(true);
  expect(isPreformattedText('a ─ b')).toBe(true);
});

test('normalizePipeTable aligns a 3-row pipe table and leaves non-table text unchanged', () => {
  const table = [
    '| # | Stage | Driver |',
    '|---|---|---|',
    '| 1 | Stage 1 QA (JSONL-grounded) | codex |',
  ].join('\n');
  const normalized = normalizePipeTable(table);
  const pipePositions = normalized.split('\n').map((line) => {
    const positions: number[] = [];
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '|') positions.push(index);
    }
    return positions;
  });

  expect(pipePositions[0]).toEqual(pipePositions[1]);
  expect(pipePositions[1]).toEqual(pipePositions[2]);
  expect(normalized.split('\n')[1] || '').toMatch(/^\|-+\|-+\|-+\|$/);

  const prose = 'const value = "a|b";\nconsole.log(value);';
  expect(normalizePipeTable(prose)).toBe(prose);
});

test('PreformattedScrollBlock renders pipe-table input as aligned non-wrapping line nodes', () => {
  const table = [
    '| # | Stage | Driver |',
    '|---|---|---|',
    '| 1 | Stage 1 QA (JSONL-grounded) | codex |',
  ].join('\n');
  let renderer: RenderAPI | undefined;

  renderer = render(<PreformattedScrollBlock text={table} textStyle={{ fontFamily: 'monospace' }} />);

  const rendered = renderer as RenderAPI;
  expect(rendered.UNSAFE_getAllByType(ScrollView).length).toBe(1);
  const textNodesOnly = rendered.UNSAFE_getAllByType(Text);
  expect(textNodesOnly).toHaveLength(3);
  expect(textNodesOnly.every((node) => node.props.numberOfLines === 1)).toBe(true);
  const output = textNodesOnly.map(textOf).join('\n');
  const pipePositions = output.split('\n').map((line) => {
    const positions: number[] = [];
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '|') positions.push(index);
    }
    return positions;
  });
  expect(pipePositions[0]).toEqual(pipePositions[1]);
  expect(pipePositions[1]).toEqual(pipePositions[2]);

  act(() => {
    rendered.unmount();
  });
});

test('PreformattedScrollBlock renders non-pipe preformatted input as byte-identical non-wrapping lines', () => {
  const code = [
    'function run() {',
    '  const value = 1;',
    '  return value;',
    '}',
    'run();',
  ].join('\n');
  let renderer: RenderAPI | undefined;

  renderer = render(<PreformattedScrollBlock text={code} textStyle={{ fontFamily: 'monospace' }} />);

  const rendered = renderer as RenderAPI;
  const textNodesOnly = rendered.UNSAFE_getAllByType(Text);
  expect(textNodesOnly).toHaveLength(5);
  expect(textNodesOnly.every((node) => node.props.numberOfLines === 1)).toBe(true);
  expect(textNodesOnly.map(textOf).join('\n')).toBe(code);

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow collapses a multi-line Bash invocation and expands the exact body', () => {
  const command = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n');
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({ id: 'bash-10-lines', text: `Bash(${command})` })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  const card = rendered.getByTestId('tool-result-card-bash-10-lines');
  expect(card.props.accessibilityState).toEqual({ expanded: false });
  expect(allText(rendered)).not.toContain('line-10');
  fireEvent.press(card);
  expect(allText(rendered)).toContain(command);

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow collapses a long single-line Bash invocation and expands it exactly', () => {
  const command = 'export PATH=/opt/homebrew/bin:$PATH; cd /tmp/synthetic/workspace/scratch/post_clutter_polish && codex exec --dangerously-bypass-approvals-and-sandbox -C /tmp/synthetic/workspace/scratch/post_clutter_polish "$(cat stage2_prompt.md)" 2>&1';
  expect(command.length).toBeGreaterThan(200);
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({ id: 'bash-long-single-line', text: `Bash(${command})` })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  const card = rendered.getByTestId('tool-result-card-bash-long-single-line');
  expect(card.props.accessibilityState).toEqual({ expanded: false });
  expect(rendered.getByText(`Bash(${command})`).props.numberOfLines).toBe(1);
  fireEvent.press(card);
  expect(rendered.getByText(`Bash(${command})`).props.numberOfLines).toBeUndefined();

  act(() => {
    rendered.unmount();
  });
});

test('TranscriptRow collapses a non-Bash tool invocation and expands it exactly', () => {
  const bodyText = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n');
  let renderer: RenderAPI | undefined;

  renderer = render(
      <TranscriptRow
        item={transcriptItem({
          id: 'edit-10-lines',
          text: `Edit(${bodyText})`,
          displayRule: 'activity:file-change',
        })}
        chrome={chrome}
      />,
    );

  const rendered = renderer as RenderAPI;
  const card = rendered.getByTestId('tool-result-card-edit-10-lines');
  expect(card.props.accessibilityState).toEqual({ expanded: false });
  expect(allText(rendered)).not.toContain('line-10');
  fireEvent.press(card);
  expect(allText(rendered)).toContain(bodyText);

  act(() => {
    rendered.unmount();
  });
});

test('computeActiveThinkingRowId returns the latest THINKING id only when it is the final transcript row', () => {
  const item = (id: string, kind: PentacleTranscriptItem['kind']): PentacleTranscriptItem => transcriptItem({ id, kind, eventCase: kind === 'THINKING' ? 'thinking' : 'tool_use', text: id });

  expect(computeActiveThinkingRowId(undefined)).toBe(null);
  expect(computeActiveThinkingRowId([])).toBe(null);
  expect(computeActiveThinkingRowId([item('think-1', 'THINKING')])).toBe('think-1');
  expect(computeActiveThinkingRowId([item('think-1', 'THINKING'), item('tool-1', 'TOOL_USE')])).toBe(null);
  expect(computeActiveThinkingRowId([
      item('think-1', 'THINKING'),
      item('tool-1', 'TOOL_USE'),
      item('think-2', 'THINKING'),
    ])).toBe('think-2');
});
