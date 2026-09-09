import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act, render, type RenderAPI } from '@testing-library/react-native';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}));
import {
  AnimatedSpinnerGlyph,
  formatWorkingDockLabel,
  formatWorkingTaskLines,
  SPINNER_GLYPHS,
  SPINNER_TICK_MS,
  WorkingDock,
} from '../app/pentacle/session/[streamId]';
import { isSystemEndOfTurnEvent } from 'pentacle-chat-core';

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

const chrome = {
  header: '#102a4a',
  accent: '#4da3ff',
  surface: '#0c1827',
  border: '#2f6ca5',
  title: 'Beta',
};

test('isSystemEndOfTurnEvent detects terminal divider and turn-summary SYSTEM events', () => {
  const base = {
    daemon_seq: 1,
    stream_id: 'hostc:claude:one',
    host: 'hostc',
    provider: 'claude',
    session_id: 'session',
    session_name: 'one',
    timestamp: '2026-05-01T12:00:00Z',
    text: '',
  };

  expect(isSystemEndOfTurnEvent({
    ...base,
    kind: 'SYSTEM',
    text: '─ Worked for 12s ─────────────',
  })).toBe(true);
  expect(isSystemEndOfTurnEvent({
    ...base,
    daemon_seq: 2,
    kind: 'SYSTEM',
    raw: { source: 'claude-jsonl', subtype: 'turn-summary' },
  })).toBe(true);
  expect(isSystemEndOfTurnEvent({
    ...base,
    daemon_seq: 3,
    kind: 'ASSIST',
    text: '─ Worked for 12s ─────────────',
  })).toBe(false);
  expect(isSystemEndOfTurnEvent({
    ...base,
    daemon_seq: 4,
    kind: 'SYSTEM',
    text: 'still working',
  })).toBe(false);
});

function collectText(node: ReturnType<RenderAPI['toJSON']> | ReturnType<RenderAPI['toJSON']>[] | string | null): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  return (node.children || []).map(collectText).join('');
}

function textNodes(renderer: RenderAPI): string[] {
  return renderer.UNSAFE_getAllByType(Text).map((node) => {
    const children = node.props.children;
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) {
      return children.map((child) => typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
    }
    return '';
  });
}

function hasLegacyDotView(renderer: RenderAPI): boolean {
  return renderer.UNSAFE_getAllByType(View).some((node) => {
    const style = StyleSheet.flatten(node.props.style) || {};
    return (style.width === 6 || style.width === 7) && (style.height === 6 || style.height === 7) && style.borderRadius === 999;
  });
}

test('AnimatedSpinnerGlyph cycles through the mirrored 12-frame sequence at 120ms', () => {
  jest.useFakeTimers();
  let renderer: RenderAPI | undefined;

  renderer = render(<AnimatedSpinnerGlyph style={{ fontFamily: 'monospace' }} />);

  const rendered = renderer as RenderAPI;
  const glyph = () => textNodes(rendered)[0];
  expect(glyph()).toBe(SPINNER_GLYPHS[0]);

  for (let index = 1; index <= SPINNER_GLYPHS.length; index += 1) {
    act(() => {
      jest.advanceTimersByTime(SPINNER_TICK_MS);
    });
    expect(glyph()).toBe(SPINNER_GLYPHS[index % SPINNER_GLYPHS.length]);
  }

  act(() => {
    rendered.unmount();
  });
});

test('WorkingDock verbose title is provider-neutral and uses workingStartedAt for elapsed time', () => {
  jest.useFakeTimers({ now: new Date('2026-04-29T12:00:00.000Z') });

  const lastEventAt = new Date(Date.now() - 9_000).toISOString();
  let renderer: RenderAPI | undefined;

  renderer = render(
      <WorkingDock chrome={chrome} workingLabel="" lastEventAt={lastEventAt} workingStartedAt={null} verbose />,
    );

  expect((renderer as RenderAPI).UNSAFE_getAllByType(AnimatedSpinnerGlyph).length).toBe(1);
  expect(textNodes(renderer as RenderAPI)).toEqual(['·', 'Working']);
  expect(hasLegacyDotView(renderer as RenderAPI)).toBe(false);
  expect(collectText((renderer as RenderAPI).toJSON())).toMatch(/^.Working$/);

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(collectText((renderer as RenderAPI).toJSON())).toMatch(/^.Working$/);

  (renderer as RenderAPI).rerender(
    <WorkingDock chrome={chrome} workingLabel="" lastEventAt={lastEventAt} workingStartedAt={Date.now()} verbose />,
  );
  expect(textNodes(renderer as RenderAPI)[1]).toBe('Working · 00:00');

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(textNodes(renderer as RenderAPI)[1]).toBe('Working · 00:01');

  (renderer as RenderAPI).rerender(
    <WorkingDock
      chrome={chrome}
      workingLabel="Waiting for background terminal..."
      lastEventAt={lastEventAt}
      workingStartedAt={Date.now()}
      verbose
    />,
  );
  expect(textNodes(renderer as RenderAPI)[1]).toBe('Working · 00:01');

  (renderer as RenderAPI).rerender(
    <WorkingDock
      chrome={chrome}
      workingLabel="Working (9s • esc to interrupt)"
      lastEventAt={lastEventAt}
      workingStartedAt={Date.now()}
      verbose
    />,
  );
  expect(textNodes(renderer as RenderAPI)[1]).toBe('Working · 00:01');

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('WorkingDock formats token, shell, task, and truncation state', () => {
  const workingState = {
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 1900,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down' as const,
    shell_count_started: 2,
    task_summary: { total: 6, done: 2, in_progress: 1, open: 4 },
    elapsed_ms: 45_000,
    tasks: [
      { id: '1', subject: 'Track A', status: 'in_progress', blocked_by: [] },
      { id: '2', subject: 'Track B', status: 'pending', blocked_by: ['1'] },
      { id: '3', subject: 'Track C', status: 'pending', blocked_by: ['1', '2'] },
      { id: '4', subject: 'Track D', status: 'pending', blocked_by: [] },
    ],
  };
  let renderer: RenderAPI | undefined;

  renderer = render(
      <WorkingDock chrome={chrome} workingLabel="Baked for 45s" lastEventAt="" workingState={workingState} verbose />,
    );

  const text = textNodes(renderer as RenderAPI);
  expect(text[1]).toBe('Working · ↓ 1.9k tokens · 2 shells started');
  expect(text.includes('6 tasks (2 done, 1 in progress, 4 open)')).toBeTruthy();
  expect(text.includes('◼ Track A')).toBeTruthy();
  expect(text.includes('◻ Track B › blocked by #1')).toBeTruthy();
  expect(text.includes('◻ Track C › blocked by #1, #2')).toBeTruthy();
  expect(text.includes('… +2 completed')).toBeTruthy();
  expect(text.includes('… +1 open')).toBeTruthy();

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('WorkingDock defaults to the minimal dock without token suffix or task lines', () => {
  jest.useFakeTimers({ now: new Date('2026-05-01T12:04:21.000Z') });
  const workingState = {
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 1900,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down' as const,
    shell_count_started: 2,
    task_summary: { total: 2, done: 0, in_progress: 1, open: 2 },
    elapsed_ms: 45_000,
    tasks: [
      { id: '1', subject: 'Track A', status: 'in_progress', blocked_by: [] },
      { id: '2', subject: 'Track B', status: 'pending', blocked_by: ['1'] },
    ],
  };

  const renderer = render(
    <WorkingDock
      chrome={chrome}
      workingLabel="Running npm run test:unit"
      lastEventAt="2026-05-01T12:00:00Z"
      workingState={workingState}
      workingStartedAt={Date.now() - 261_000}
    />,
  );

  expect(renderer.UNSAFE_getAllByType(AnimatedSpinnerGlyph).length).toBe(1);
  expect(textNodes(renderer)).toEqual(['·', 'Working · 04:21']);
  expect(collectText(renderer.toJSON())).not.toContain('tokens');
  expect(collectText(renderer.toJSON())).not.toContain('shell');
  expect(collectText(renderer.toJSON())).not.toContain('Track A');

  act(() => {
    renderer.unmount();
  });
});

test('WorkingDock verbose mode renders the full dock while minimal mode can hide the timer', () => {
  jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
  const workingState = {
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 1900,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down' as const,
    shell_count_started: 1,
    task_summary: { total: 1, done: 0, in_progress: 1, open: 1 },
    elapsed_ms: 0,
    tasks: [
      { id: '1', subject: 'Track A', status: 'in_progress', blocked_by: [] },
    ],
  };

  const renderer = render(
    <WorkingDock
      chrome={chrome}
      workingLabel="Running npm run test:unit"
      lastEventAt="2026-05-01T11:59:15Z"
      workingState={workingState}
      workingStartedAt={Date.now()}
      verbose
    />,
  );

  expect(textNodes(renderer)).toEqual([
    '·',
    'Working · 00:00 · ↓ 1.9k tokens · 1 shell started',
    '1 tasks (0 done, 1 in progress, 1 open)',
    '◼ Track A',
  ]);

  renderer.rerender(
    <WorkingDock
      chrome={chrome}
      workingLabel="Running npm run test:unit"
      lastEventAt="2026-05-01T11:59:15Z"
      workingState={workingState}
      verbose={false}
      workingStartedAt={null}
    />,
  );

  expect(textNodes(renderer)).toEqual(['·', 'Working']);

  act(() => {
    renderer.unmount();
  });
});

test('WorkingDock timer is monotonic when the computed elapsed value moves backward', () => {
  jest.useFakeTimers({ now: new Date('2026-05-01T12:04:21.000Z') });
  const renderer = render(
    <WorkingDock
      chrome={chrome}
      workingLabel=""
      lastEventAt=""
      workingStartedAt={Date.now() - 261_000}
    />,
  );

  expect(textNodes(renderer)).toEqual(['·', 'Working · 04:21']);

  renderer.rerender(
    <WorkingDock
      chrome={chrome}
      workingLabel=""
      lastEventAt=""
      workingStartedAt={Date.now() - 1_000}
    />,
  );

  expect(textNodes(renderer)).toEqual(['·', 'Working · 04:21']);

  act(() => {
    renderer.unmount();
  });
});

test('WorkingDock shows animation-only text before the first server event starts the timer', () => {
  jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00.000Z') });
  const renderer = render(
    <WorkingDock chrome={chrome} workingLabel="" lastEventAt="" workingStartedAt={null} />,
  );

  expect(renderer.UNSAFE_getAllByType(AnimatedSpinnerGlyph).length).toBe(1);
  expect(textNodes(renderer)).toEqual(['·', 'Working']);

  renderer.rerender(
    <WorkingDock chrome={chrome} workingLabel="" lastEventAt="" workingStartedAt={Date.now()} />,
  );

  expect(textNodes(renderer)).toEqual(['·', 'Working · 00:00']);

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(textNodes(renderer)).toEqual([SPINNER_GLYPHS[Math.floor(1000 / SPINNER_TICK_MS) % SPINNER_GLYPHS.length], 'Working · 00:01']);

  act(() => {
    renderer.unmount();
  });
});

test('WorkingDock token suffix covers up and idle phases with compact formatting', () => {
  const base = {
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 12_000,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    shell_count_started: 0,
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 0,
    tasks: [],
  };

  expect(formatWorkingDockLabel('Working', { ...base, tokens_phase: 'up' })).toBe('Working · ↑ 12k tokens');
  expect(formatWorkingDockLabel('Working', { ...base, tokens_phase: 'idle' })).toBe('Working');
  expect(formatWorkingDockLabel('Working', { ...base, tokens_phase: 'down', tokens_output: 345 })).toBe('Working · ↓ 345 tokens');
  expect(formatWorkingTaskLines({ ...base, tokens_phase: 'down' })).toEqual([]);
});

test('WorkingDock hides token suffix when output is zero and formats singular shell', () => {
  const state = {
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 1,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down' as const,
    shell_count_started: 1,
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 0,
    tasks: [],
  };

  expect(formatWorkingDockLabel('Working', state)).toBe('Working · 1 shell started');
});

test('WorkingDock task lines omit truncation rows when all open tasks fit', () => {
  const lines = formatWorkingTaskLines({
    stream_id: 'beta:claude-test',
    timestamp: '2026-05-01T12:00:00Z',
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'idle',
    shell_count_started: 0,
    elapsed_ms: 0,
    task_summary: { total: 2, done: 0, in_progress: 1, open: 2 },
    tasks: [
      { id: '1', subject: 'Track A', status: 'in_progress', blocked_by: [] },
      { id: '2', subject: 'Track B', status: 'pending', blocked_by: [] },
    ],
  });

  expect(lines).toEqual([
    '2 tasks (0 done, 1 in progress, 2 open)',
    '◼ Track A',
    '◻ Track B',
  ]);
});

