import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function findFunctionBody(source: string, functionSignature: string): string {
  const signatureIndex = source.indexOf(functionSignature);
  expect(signatureIndex).not.toBe(-1);

  const bodyStart = source.indexOf('{', signatureIndex);
  expect(bodyStart).not.toBe(-1);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && prev !== '\\') quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`unterminated function body: ${functionSignature}`);
}

test('PentacleSessionScreen parent body does not call useTicker', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');
  const body = findFunctionBody(source, 'export default function PentacleSessionScreen()');

  expect(body.includes('useTicker(')).toBe(false);
});

test('session screen renders core-owned disclosure and code-block branches', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes("item.displayRule === 'activity:code-block'")).toBe(true);
  expect(source.includes("item.disclosure?.mode === 'collapsed-preview'")).toBe(true);
  expect(source.includes('styles.toolInvocationCard')).toBe(true);
  expect(source.includes('const isBash = invocation.title === \'Bash\';')).toBe(true);
  expect(source.includes('numberOfLines={isBash ? 2 : undefined}')).toBe(true);
  expect(source.includes('ellipsizeMode={isBash ? \'tail\' : undefined}')).toBe(true);
  expect(source.includes('shouldRenderClaudePaneToolCard(item)')).toBe(true);
  expect(source.includes("item.kind === 'TOOL_RESULT'")).toBe(true);
  expect(source.includes('const disclosure = item.disclosure;')).toBe(true);
  expect(source.includes('disclosure?.expandedText')).toBe(true);
  expect(source.includes('truncateTranscriptLines(toolResultText, 1)')).toBe(false);
  expect(source.includes('styles.toolResultGlyph')).toBe(true);
  expect(source.includes("styles.codeBlock")).toBe(true);
  expect(source.includes("item.displayRule.startsWith('activity:')")).toBe(true);
  expect(source.includes("item.displayRule === 'activity:tool-batch'")).toBe(true);
  expect(source.includes('styles.toolBatchRow')).toBe(true);
});

test('session screen has Claude JSONL turn-summary divider branch', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes("item.displayRule === 'activity:turn-summary'")).toBe(true);
  expect(source.includes('styles.terminalDividerLine')).toBe(true);
});

test('session screen uses one combined chat header instead of an in-content hero', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes('headerShown: false')).toBe(true);
  expect(source.includes('testID="combined-session-header"')).toBe(true);
  expect(source.includes('testID="session-hero"')).toBe(false);
  expect(source.includes('<ProviderTag provider={session.provider}')).toBe(true);
  expect(source.includes('status={headerStatus}')).toBe(true);
});

test('session screen keeps WorkingDock provider-neutral title and verbose details wired', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes('export function AnimatedSpinnerGlyph')).toBe(true);
  expect(source.includes('SPINNER_TICK_MS = 120')).toBe(true);
  expect(source.includes('<AnimatedSpinnerGlyph style={[styles.activityDockGlyph')).toBe(true);
  expect(source.includes('const baseLabel = `Working${displayedSeconds !== null ?')).toBe(true);
  expect(source.includes('formatWorkingDockLabel(baseLabel, workingState)')).toBe(true);
  expect(source.includes('formatTerminalElapsed')).toBe(false);
  expect(source.includes('formatWorkingTaskLines(workingState)')).toBe(true);
  expect(source.includes('numberOfLines={2}>{label}</Text>')).toBe(true);
  expect(source.includes('task_summary')).toBe(true);
});

test('session screen keeps preformatted and thinking polish helpers wired', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes('export function normalizePipeTable')).toBe(true);
  expect(source.includes('normalizePipeTableRun')).toBe(true);
  expect(source.includes('const normalizedText = normalizePipeTable')).toBe(true);
  expect(source.includes('export function computeActiveThinkingRowId')).toBe(true);
  expect(source.includes('latestThinkingRowId')).toBe(true);
  expect(source.includes('isLatestThinking={item.id === latestThinkingRowId}')).toBe(true);
  expect(source.includes('item.displayRule === \'activity:thinking\'')).toBe(true);
});

test('session screen tracks sticky-bottom unread state without initial-load pills', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes('const NEAR_BOTTOM_OFFSET = 2;')).toBe(true);
  expect(source.includes('const hasInitializedLastSeenRef = useRef(false);')).toBe(true);
  expect(source.includes('if (!hasInitializedLastSeenRef.current)')).toBe(true);
  expect(source.includes('testID="new-messages-pill"')).toBe(true);
  expect(source.includes('onScroll={(event) => {')).toBe(true);
  expect(source.includes('setUnreadCount(delta);')).toBe(true);
});

test('session screen delegates reconnect redirect and bounded scroll decisions to helpers', () => {
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');

  expect(source.includes("from '../../../src/services/sessionScreenRedirect'")).toBe(true);
  expect(source.includes("from '../../../src/services/sessionScreenScroll'")).toBe(true);
  expect(source.includes('shouldArmRedirectTimer(inputs)')).toBe(true);
  expect(source.includes('MISSING_SESSION_REDIRECT_MS')).toBe(true);
  expect(source.includes('planScroll({')).toBe(true);
  expect(source.includes('previousLengthRef.current = 0;')).toBe(true);
  expect(source.includes('previousLengthRef.current = transcriptData.length;')).toBe(true);
  expect(source.includes("scrollPlan.kind === 'cold-start'")).toBe(true);
  expect(source.includes("scrollPlan.kind === 'growth'")).toBe(true);
  expect(source.includes('}, 120);')).toBe(true);
  expect(source.includes('}, 260);')).toBe(false);
  expect(source.includes('[0, 120, 360, 720]')).toBe(false);
});
