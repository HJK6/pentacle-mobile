import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type * as TS from 'typescript';
import {
  performChatOpenNavigation,
  type ChatOpenNavigator,
} from '../../src/services/chatOpenNavigation';
import { setChatOpenPaintSink, type ChatOpenPaintSignal } from '../../src/services/chatOpenPaintSignals';
import {
  acknowledgeChatRowNavigationIntent,
  resetChatOpenNavigationIntents,
  createChatOpenNavigationCoordinator,
} from '../../src/services/chatOpenNavigationIntent';

function recordingNavigator(): ChatOpenNavigator & { pushed: string[]; replaced: string[] } {
  const pushed: string[] = [];
  const replaced: string[] = [];
  return {
    pushed,
    replaced,
    push: (href) => pushed.push(href),
    replace: (href) => replaced.push(href),
  };
}

let paint: ChatOpenPaintSignal[];

beforeEach(() => {
  paint = [];
  resetChatOpenNavigationIntents();
  setChatOpenPaintSink((signal) => paint.push(signal));
});

afterEach(() => {
  setChatOpenPaintSink(null);
  resetChatOpenNavigationIntents();
});

test('a fresh open pushes, emits tap + router-dispatch-return, and seeds the intent', () => {
  const nav = recordingNavigator();
  const result = performChatOpenNavigation('hostc:a', nav);

  expect(result.action).toBe('push');
  expect(result.navigated).toBe(true);
  expect(nav.pushed).toEqual(['/pentacle/session/hostc%3Aa']);
  expect(nav.replaced).toEqual([]);
  expect(paint.map((s) => s.phase)).toEqual(['tap', 'router-dispatch-return']);
  expect(acknowledgeChatRowNavigationIntent('hostc:a')).toBe(result.correlationId);
});

test('a second pending open to a different stream REPLACES (does not stack a push)', () => {
  const nav = recordingNavigator();
  performChatOpenNavigation('hostc:a', nav); // seeds pending for :a
  const result = performChatOpenNavigation('hostc:b', nav); // pending exists -> replace

  expect(result.action).toBe('replace');
  expect(nav.pushed).toEqual(['/pentacle/session/hostc%3Aa']);
  expect(nav.replaced).toEqual(['/pentacle/session/hostc%3Ab']);
});

test('rapid distinct opens preserve each correlation through out-of-order acknowledgement', () => {
  const nav = recordingNavigator();
  const first = performChatOpenNavigation('hostc:a', nav);
  const second = performChatOpenNavigation('hostc:b', nav);

  expect(first.correlationId).toBeTruthy();
  expect(second.correlationId).toBeTruthy();
  expect(second.correlationId).not.toBe(first.correlationId);
  expect(acknowledgeChatRowNavigationIntent('hostc:b')).toBe(second.correlationId);
  expect(acknowledgeChatRowNavigationIntent('hostc:a')).toBe(first.correlationId);
});

type Coordinator = ReturnType<typeof createChatOpenNavigationCoordinator>;

const DECISION_TABLE_CASES: ReadonlyArray<{ name: string; run: (coordinator: Coordinator) => void }> = [
  {
    name: 'none + any X pushes and creates a live correlation',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      expect(coordinator.pendingTarget()).toBe('stream-x');
      expect(coordinator.ack('stream-x')).toBe('x');
    },
  },
  {
    name: 'pending unacked X + same X noops and keeps the original correlation',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x-duplicate' })).toBe('noop');
      expect(coordinator.ack('stream-x')).toBe('x');
      expect(coordinator.ack('stream-x')).toBeNull();
    },
  },
  {
    name: 'pending unacked X + distinct Y cancels X and replaces with Y',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      expect(coordinator.open({ streamId: 'stream-y', correlationId: 'y' })).toBe('replace');
      expect(coordinator.pendingTarget()).toBe('stream-y');
      expect(coordinator.ack('stream-x')).toBe('x');
      expect(coordinator.ack('stream-y')).toBe('y');
    },
  },
  {
    // Once the destination has acknowledged, navigation is complete and the
    // user is free to leave and come
    // back, so the next open of the same stream is a new intent and must push.
    // Rapid double-tap is still covered by the pending-same-stream row above:
    // the second tap of a burst lands before the destination can focus and ack.
    name: 'acked X + same X pushes a NEW intent (re-open after the visit ended)',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      expect(coordinator.ack('stream-x')).toBe('x');
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x-again' })).toBe('push');
      expect(coordinator.pendingTarget()).toBe('stream-x');
      expect(coordinator.ack('stream-x')).toBe('x-again');
    },
  },
  {
    name: 'pending acked X + distinct Y pushes',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      expect(coordinator.ack('stream-x')).toBe('x');
      expect(coordinator.open({ streamId: 'stream-y', correlationId: 'y' })).toBe('push');
      expect(coordinator.ack('stream-y')).toBe('y');
    },
  },
  {
    name: 'pending expired X + any Z marks X expired and pushes Z',
    run: (coordinator) => {
      expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
      jest.advanceTimersByTime(20);
      expect(coordinator.pendingTarget()).toBeNull();
      expect(coordinator.open({ streamId: 'stream-z', correlationId: 'z' })).toBe('push');
      expect(coordinator.ack('stream-x')).toBeNull();
      expect(coordinator.ack('stream-z')).toBe('z');
    },
  },
];

test.each(DECISION_TABLE_CASES)('locked decision table: $name', ({ run }) => {
  jest.useFakeTimers();
  try {
    run(createChatOpenNavigationCoordinator(20));
  } finally {
    jest.useRealTimers();
  }
});

test('same-stream noop does not reset the original TTL', () => {
  jest.useFakeTimers();
  try {
    const coordinator = createChatOpenNavigationCoordinator(20);
    expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
    jest.advanceTimersByTime(19);
    expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x-duplicate' })).toBe('noop');
    jest.advanceTimersByTime(1);
    expect(coordinator.pendingTarget()).toBeNull();
    expect(coordinator.ack('stream-x')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('correlations remain unique and rapid distinct unacked opens keep the route stack bounded', () => {
  const nav = recordingNavigator();
  const results = Array.from({ length: 64 }, (_, index) =>
    performChatOpenNavigation(`hostc:rapid-${index}`, nav),
  );

  expect(new Set(results.map((result) => result.correlationId)).size).toBe(64);
  expect(nav.pushed).toHaveLength(1);
  expect(nav.replaced).toHaveLength(63);
  expect(nav.pushed.length + nav.replaced.length).toBe(64);
  expect(acknowledgeChatRowNavigationIntent('hostc:rapid-63')).toBe(results[63].correlationId);
});

test('a correlationId cannot be reused for a later open', () => {
  const coordinator = createChatOpenNavigationCoordinator();

  expect(coordinator.open({ streamId: 'stream-x', correlationId: 'x' })).toBe('push');
  expect(coordinator.open({ streamId: 'stream-y', correlationId: 'x' })).toBe('noop');
  expect(coordinator.pendingTarget()).toBe('stream-x');
  expect(coordinator.ack('stream-x')).toBe('x');
});

test('the shared product path and direct coordinator use one default TTL', () => {
  jest.useFakeTimers();
  try {
    const direct = createChatOpenNavigationCoordinator();
    direct.open({ streamId: 'stream-direct', correlationId: 'direct' });
    const nav = recordingNavigator();
    const shared = performChatOpenNavigation('stream-shared', nav);

    jest.advanceTimersByTime(2499);
    expect(direct.pendingTarget()).toBe('stream-direct');
    expect(acknowledgeChatRowNavigationIntent('stream-shared')).toBe(shared.correlationId);

    const directExact = createChatOpenNavigationCoordinator();
    directExact.open({ streamId: 'stream-direct-exact', correlationId: 'direct-exact' });
    resetChatOpenNavigationIntents();
    const sharedExact = performChatOpenNavigation('stream-shared-exact', nav);
    jest.advanceTimersByTime(2500);
    expect(directExact.pendingTarget()).toBeNull();
    expect(acknowledgeChatRowNavigationIntent('stream-shared-exact')).toBeNull();
    expect(sharedExact.correlationId).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test('a repeat open of the SAME still-pending stream is a NOOP: no navigation, no mark', () => {
  const nav = recordingNavigator();
  performChatOpenNavigation('hostc:a', nav); // pending :a
  paint.length = 0;
  const result = performChatOpenNavigation('hostc:a', nav); // same stream, still pending

  expect(result.action).toBe('noop');
  expect(result.navigated).toBe(false);
  expect(nav.pushed).toEqual(['/pentacle/session/hostc%3Aa']); // unchanged
  expect(nav.replaced).toEqual([]);
  // No router-dispatch-return on a noop (the interactive handler returned early
  // before marking, so the shared unit must too).
  expect(paint.map((s) => s.phase)).toEqual(['tap']);
});

// Regression scenario: open A, let the destination acknowledge on focus, return
// to the list, and tap A again. This drives the shared singleton without a
// test-only reset in between.
test('re-opening the SAME stream after its destination acked navigates again', () => {
  const nav = recordingNavigator();
  const first = performChatOpenNavigation('hostc:reopen', nav);
  expect(first.action).toBe('push');
  // Destination focus effect: acknowledge, completing the intent.
  expect(acknowledgeChatRowNavigationIntent('hostc:reopen')).toBe(first.correlationId);

  // User taps back to the Chats list and re-taps the same row.
  const second = performChatOpenNavigation('hostc:reopen', nav);
  expect(second.action).toBe('push');
  expect(second.navigated).toBe(true);
  expect(second.correlationId).not.toBe(first.correlationId);
  expect(nav.pushed).toEqual([
    '/pentacle/session/hostc%3Areopen',
    '/pentacle/session/hostc%3Areopen',
  ]);
  expect(acknowledgeChatRowNavigationIntent('hostc:reopen')).toBe(second.correlationId);
});

// The suppression that survives is IN-FLIGHT only: a completed terminal is a
// record for late/out-of-order ack resolution, never a navigation veto.
test('a completed terminal still resolves a late ack exactly once', () => {
  const nav = recordingNavigator();
  const first = performChatOpenNavigation('hostc:late', nav);
  expect(acknowledgeChatRowNavigationIntent('hostc:late')).toBe(first.correlationId);
  expect(acknowledgeChatRowNavigationIntent('hostc:late')).toBeNull();
});

test('onBeforeNavigate runs on a real navigation but NOT on a noop', () => {
  const nav = recordingNavigator();
  const onBefore = jest.fn();
  performChatOpenNavigation('hostc:a', nav, onBefore);
  expect(onBefore).toHaveBeenCalledTimes(1);
  performChatOpenNavigation('hostc:a', nav, onBefore); // noop
  expect(onBefore).toHaveBeenCalledTimes(1);
});

test('empty streamId is a noop with no paint and no navigation', () => {
  const nav = recordingNavigator();
  const result = performChatOpenNavigation('', nav);
  expect(result).toEqual({ action: 'noop', correlationId: null, navigated: false });
  expect(paint).toEqual([]);
  expect(nav.pushed).toEqual([]);
});

// ---------------------------------------------------------------------------
// Drift guard: the two paths must continue to share one implementation.
//
// A simple two-file guard would be too weak — it only checks that two files
// mention performChatOpenNavigation and avoid the primitives, so a raw
// `router.push('/pentacle/session/...')` added anywhere (as the harness poll
// override was) slipped straight past it and reproduced the 0-paint defect.
//
// Guard 1 is an AST CENSUS (see collectNavCalls): every push/replace/navigate
// call in src/ + app/ whose receiver is router-ish OR whose argument references
// the session route must be either the shared unit itself or an explicitly
// ALLOWLISTED site. A new session/dynamic navigation fails this test until
// someone classifies it. The census replaced a regex sweep that missed dynamic
// forms (variable/builder/concat/navigate, bracket access, aliases).
//
// Guard 2 pins every HARNESS open path to the shared unit (calls the shared
// helper, never the low-level primitives) so none re-implements the branch.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(__dirname, '../..');

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

// The regex sweep this replaces only understood same-line literal navigations,
// so it missed bracket access (router['push']), aliases, multi-call lines,
// whitespace/comments between receiver and method, and comment-blessed markers
// This census parses each file's TypeScript AST and inspects
// EVERY push/replace/navigate CallExpression. Call shape is considered a
// navigation candidate before receiver or argument classification: an unknown
// receiver or opaque argument is a failure until positively classified. A
// candidate is cleared only by a non-session literal, a receiver type proven to
// be a string/array data structure, or an exact-site allowlist entry matched
// against the call's ACTUAL ARGUMENT text (never a surrounding line/comment).
// With a checker, the census also follows router-object and router-method
// aliases, including destructured method aliases, so a fully renamed call does
// not disappear merely because its argument is opaque.

type NavClass = 'non-session-literal' | 'session-literal' | 'dynamic';
type NavCall = {
  line: number;
  argText: string;
  receiverText: string;
  klass: NavClass;
  provenNonNavigation: boolean;
};

type NavMethod = 'push' | 'replace' | 'navigate';

function isDefinitelyNonNavigationType(
  type: TS.Type,
  checker: TS.TypeChecker,
  ts: typeof import('typescript'),
): boolean {
  if (type.isUnion()) return type.types.length > 0 && type.types.every((part) => isDefinitelyNonNavigationType(part, checker, ts));
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return true;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
  return false;
}

function collectNavCallsFromSourceFile(sf: TS.SourceFile, checker?: TS.TypeChecker): NavCall[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const calls: NavCall[] = [];
  const unwrap = (n: TS.Node | undefined): TS.Node | undefined =>
    n && (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n))
      ? unwrap(n.expression)
      : n && ts.isParenthesizedExpression(n) ? unwrap(n.expression)
        : n && ts.isNonNullExpression(n) ? unwrap(n.expression)
        : n;

  const navMethodFromCallee = (callee: TS.Node | undefined): NavMethod | null => {
    if (!callee) return null;
    let method: string | undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      method = callee.name.text;
    } else if (ts.isElementAccessExpression(callee)) {
      const key = unwrap(callee.argumentExpression);
      if (key && ts.isStringLiteralLike(key)) method = key.text;
    }
    return method === 'push' || method === 'replace' || method === 'navigate' ? method : null;
  };

  const isRouterExpression = (
    expression: TS.Node | undefined,
    seen = new Set<TS.Symbol>(),
  ): boolean => {
    const target = unwrap(expression);
    if (!target) return false;

    if (ts.isIdentifier(target)) {
      if (target.text === 'router') return true;
      if (!checker) return false;
      const symbol = checker.getSymbolAtLocation(target);
      if (!symbol) return false;
      const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
      if (seen.has(resolved)) return false;
      const nextSeen = new Set(seen).add(resolved);
      for (const declaration of resolved.declarations ?? symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer
          && isRouterExpression(declaration.initializer, nextSeen)) return true;
        if (ts.isBindingElement(declaration)) {
          const pattern = declaration.parent;
          const variable = pattern.parent;
          if (ts.isVariableDeclaration(variable) && variable.initializer
            && isRouterExpression(variable.initializer, nextSeen)) return true;
        }
      }
      return false;
    }

    if (ts.isCallExpression(target)) {
      const callee = unwrap(target.expression);
      if (callee && ts.isIdentifier(callee) && callee.text === 'useRouter') return true;
      if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'useRouter') return true;
    }
    return false;
  };

  const navigationMethodFromExpression = (
    expression: TS.Node | undefined,
    seen = new Set<TS.Symbol>(),
  ): NavMethod | null => {
    const target = unwrap(expression);
    if (!target) return null;

    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const method = navMethodFromCallee(target);
      return method && isRouterExpression(target.expression) ? method : null;
    }

    if (!checker || !ts.isIdentifier(target)) return null;
    const symbol = checker.getSymbolAtLocation(target);
    if (!symbol) return null;
    const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    if (seen.has(resolved)) return null;
    const nextSeen = new Set(seen).add(resolved);

    for (const declaration of resolved.declarations ?? symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const method = navigationMethodFromExpression(declaration.initializer, nextSeen);
        if (method) return method;
      }
      if (ts.isBindingElement(declaration)) {
        const property = declaration.propertyName ?? declaration.name;
        let method: string | undefined;
        if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) method = property.text;
        const pattern = declaration.parent;
        const variable = pattern.parent;
        if (method && (method === 'push' || method === 'replace' || method === 'navigate')
          && ts.isVariableDeclaration(variable)
          && isRouterExpression(variable.initializer)) {
          return method;
        }
      }
    }
    return null;
  };

  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      let method: string | null = null;
      let receiverNode: TS.Node | undefined;
      let aliasedMethodCall = false;
      if (callee && ts.isPropertyAccessExpression(callee)) {
        method = callee.name.text;
        receiverNode = callee.expression;
      } else if (callee && ts.isElementAccessExpression(callee)) {
        const elementKey = unwrap(callee.argumentExpression);
        if (elementKey && ts.isStringLiteralLike(elementKey)) {
          method = elementKey.text;
        }
        receiverNode = callee.expression;
      } else if (callee && checker && ts.isIdentifier(callee)) {
        method = navigationMethodFromExpression(callee);
        receiverNode = callee;
        aliasedMethodCall = method !== null;
      }
      if (receiverNode && (method === 'push' || method === 'replace' || method === 'navigate')) {
        const arg = node.arguments[0];
        const argText = arg ? arg.getText(sf) : '';
        const argHasSession = argText.includes('/pentacle/session');
        const inner = unwrap(arg);
        const klass: NavClass = argHasSession
            ? 'session-literal'
            : inner && (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))
              ? 'non-session-literal'
              : 'dynamic';
      const unwrappedReceiver = unwrap(receiverNode) ?? receiverNode;
      const receiverText = unwrappedReceiver.getText(sf);
      const routerShapedReceiver =
        receiverText === 'router'
        || /(?:^|\.)router$/u.test(receiverText)
        || aliasedMethodCall
        || isRouterExpression(unwrappedReceiver);
        calls.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          argText,
          receiverText: unwrappedReceiver.getText(sf),
          klass,
          provenNonNavigation: checker
            ? !routerShapedReceiver &&
              isDefinitelyNonNavigationType(
                checker.getTypeAtLocation(receiverNode),
                checker,
                ts,
              )
            : false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

export function collectNavCalls(source: string, fileName: string): NavCall[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return collectNavCallsFromSourceFile(sf);
}

function createSourceProgram(files: string[]): TS.Program {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const config = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
  return ts.createProgram(files, parsed.options);
}

function collectTypedProbeCalls(source: string): NavCall[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const fileName = join(REPO_ROOT, 'nav-census-probe.ts');
  const options = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.CommonJS, strict: true };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name: string) => name === fileName ? source : readFile(name);
  host.fileExists = (name: string) => name === fileName || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error('TypeScript did not load the probe source');
  return collectNavCallsFromSourceFile(sourceFile, program.getTypeChecker());
}

// Grants bind exact (file, argument expression, count) triples, not source locations.
// A same-expression positional swap is outside this guard; import/blank-line shifts are harmless.
// Constants are reviewed classifications, never derived from the source during the census.
const NAV_ALLOWLIST: { file: string; argExpression: string; count: number; reason: string }[] = [
  { file: "src/services/chatOpenNavigation.ts", argExpression: "href", count: 4, reason: "shared navigation unit owns its push/replace calls" },
  { file: "app/(tabs)/chats.tsx", argExpression: "href as any", count: 2, reason: "shared-unit navigator adapter (openChat push+replace)" },
  { file: "app/(tabs)/chats.tsx", argExpression: "{ pathname: '/pentacle/session/[streamId]', params: { streamId, openStatus: '1' } } as any", count: 1, reason: "product: status open" },
  { file: "app/(tabs)/chats.tsx", argExpression: "{\n      pathname: '/pentacle/session/[streamId]',\n      params: {\n        streamId: parent.streamId,\n        openStatus: '1',\n        agentHistory: child.stream_id,\n        agentHistoryGeneration: child.session_generation,\n      },\n    } as any", count: 1, reason: "product: routeAgentHistoryId direct-child history enters the status stack" },
  { file: "app/pentacle/session/[streamId].tsx", argExpression: "`/pentacle/session/${encodeURIComponent(nextStreamId)}` as any", count: 1, reason: "harness: in-session next" },
  { file: "app/pentacle/session/[streamId].tsx", argExpression: "`/pentacle/session/${encodeURIComponent(returnStreamId)}` as any", count: 1, reason: "harness: in-session return" },
  { file: "app/_layout.tsx", argExpression: "{\n      pathname: '/pentacle/session/[streamId]',\n      params: { streamId, reportHarness: '1' },\n    } as never", count: 1, reason: "harness report viewer (not a chat open)" },
  { file: "src/services/pentacleAssets.ts", argExpression: "{\n    pathname: \"/pentacle/session/[streamId]\",\n    params: { streamId, reports: \"1\" },\n  } as never", count: 1, reason: "product: reports viewer" },
  { file: "src/hooks/usePushNotifications.ts", argExpression: "route as any", count: 1, reason: "product: notification tap deep-link" },
  { file: "app/(tabs)/unified.tsx", argExpression: "streamPath(streamId)", count: 1, reason: "product: unified-tab open" },
  { file: "src/services/harnessActions.ts", argExpression: "ROUTE", count: 1, reason: "harness tab nav (updates); non-session" },
  { file: "src/services/harnessActions.ts", argExpression: "route", count: 1, reason: "harness tab nav smoke; non-session" },
];

function allowlistIndex(
  rel: string,
  argText: string,
  grants = NAV_ALLOWLIST,
): number {
  return grants.findIndex((grant) => rel === grant.file && argText.trim() === grant.argExpression);
}

type NavCensusResult = { offenders: string[]; stale: string[] };

function censusNavCalls(
  entries: { rel: string; call: NavCall }[],
  grants = NAV_ALLOWLIST,
): NavCensusResult {
  const offenders: string[] = [];
  const hits = grants.map(() => 0);
  for (const { rel, call } of entries) {
    if (call.provenNonNavigation || call.klass === 'non-session-literal') continue;
    const idx = allowlistIndex(rel, call.argText, grants);
    if (idx === -1) offenders.push(`${rel}:${call.line} [${call.klass}]: ${call.argText}`);
    else {
      hits[idx] += 1;
      if (hits[idx] > grants[idx].count) {
        offenders.push(`${rel}:${call.line} [excess grant occurrence]: ${call.argText}`);
      }
    }
  }
  return {
    offenders,
    stale: grants.filter((grant, idx) => hits[idx] < grant.count)
      .map((grant) => `${grant.file}:${grant.argExpression}`),
  };
}

function scanNavCensus(files: string[]): NavCensusResult {
  const program = createSourceProgram(files);
  const checker = program.getTypeChecker();
  const entries: { rel: string; call: NavCall }[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) throw new Error(`TypeScript did not load ${rel}`);
    for (const call of collectNavCallsFromSourceFile(sourceFile, checker)) entries.push({ rel, call });
  }
  return censusNavCalls(entries);
}

test('drift guard 1: AST census — every session / dynamic router navigation is classified', () => {
  const files = [...walkSource(join(REPO_ROOT, 'src')), ...walkSource(join(REPO_ROOT, 'app'))];
  const { offenders, stale } = scanNavCensus(files);
  expect(offenders).toEqual([]);
  // No stale grant may linger (a stale entry could later bless a new nav).
  expect(stale).toEqual([]);
});

test('drift guard 1 (AST negatives): dynamic / aliased / bracket / multi-call session navs are caught', () => {
  const cls = (src: string) => collectNavCalls(src, 'probe.tsx').map((c) => c.klass);
  // Safe non-session literals auto-pass:
  expect(cls("router.push('/(tabs)/chats' as any);")).toEqual(['non-session-literal']);
  expect(cls("router.replace('/');")).toEqual(['non-session-literal']);
  // Dynamic forms via a router receiver are flagged (variable, builder, navigate, conditional):
  expect(cls('router.push(route as any);')).toEqual(['dynamic']);
  expect(cls('router.push(streamPath(id));')).toEqual(['dynamic']);
  expect(cls('router.navigate(href);')).toEqual(['dynamic']);
  expect(cls('router.push(cond ? a : b);')).toEqual(['dynamic']);
  // Bracket access is caught:
  expect(cls("router['push'](href);")).toEqual(['dynamic']);
  // Whitespace / newline between receiver and method does not hide it:
  expect(cls('router\n  .push(x);')).toEqual(['dynamic']);
  // Session literals via any form/receiver are caught — template, object, and an
  // ALIASED receiver used with a concatenated session literal:
  expect(cls('router.push(`/pentacle/session/${id}`);')).toEqual(['session-literal']);
  expect(cls("router.push({ pathname: '/pentacle/session/[streamId]', params: { streamId } });")).toEqual(['session-literal']);
  expect(cls("myNav.push('/pentacle/session/' + id);")).toEqual(['session-literal']);
  // TWO navigations on one line are both seen:
  expect(cls('router.push(a); router.replace(b);')).toEqual(['dynamic', 'dynamic']);
  // A non-session literal is a positive dismissal even on an unrecognized receiver.
  expect(cls("items.push('value');")).toEqual(['non-session-literal']);
  // An opaque argument on that same unrecognized receiver remains a candidate.
  expect(cls('items.push(value);')).toEqual(['dynamic']);
});

test('drift guard 1 (QA3 red): parenthesized router receiver with opaque arg is a candidate', () => {
  const calls = collectNavCalls('(router).push(opaque);', 'probe.tsx');
  expect(calls.map((call) => call.klass)).toEqual(['dynamic']);
  expect(calls[0].receiverText).toBe('router');
});

test('drift guard 1 (QA3 red): non-null router receiver with opaque arg is a candidate', () => {
  const calls = collectNavCalls('router!.push(opaque);', 'probe.tsx');
  expect(calls.map((call) => call.klass)).toEqual(['dynamic']);
  expect(calls[0].receiverText).toBe('router');
});

test('drift guard 1 (QA3 red): asserted router receiver with opaque arg is a candidate', () => {
  const calls = collectNavCalls('(router as X).push(opaque);', 'probe.tsx');
  expect(calls.map((call) => call.klass)).toEqual(['dynamic']);
  expect(calls[0].receiverText).toBe('router');
});

test('drift guard 1 (falsifiability): wrapped static element keys remain candidates', () => {
  const calls = collectNavCalls(`
    router['push' as const](opaque);
    router[('replace')](opaque);
    ((router as X).navigate)(opaque);
  `, 'wrapped-static-keys.ts');

  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.klass === 'dynamic')).toBe(true);
  expect(calls.every((call) => call.receiverText === 'router')).toBe(true);
});

test('drift guard 1 (falsifiability): asserted router types cannot pass as non-navigation', () => {
  const calls = collectTypedProbeCalls(`
    declare const router: unknown;
    (router as string[]).push(opaque);
  `);

  expect(calls).toHaveLength(1);
  expect(calls[0].klass).toBe('dynamic');
  expect(calls[0].provenNonNavigation).toBe(false);

  const customTypeCalls = collectTypedProbeCalls(`
    export {};
    class Array {
      push(value: unknown): void {}
    }
    declare const opaque: unknown;
    const custom = new Array();
    custom.push(opaque);
  `);

  expect(customTypeCalls).toHaveLength(1);
  expect(customTypeCalls[0].klass).toBe('dynamic');
  expect(customTypeCalls[0].provenNonNavigation).toBe(false);
});

test('drift guard 1 (dataflow residual): a fully renamed router method with an opaque route is a candidate', () => {
  const calls = collectTypedProbeCalls(`
    declare const router: {
      replace(value: unknown): void;
    };
    declare const opaqueRoute: unknown;
    const renamedRouter = router;
    const { replace: fullyRenamed } = renamedRouter;
    fullyRenamed(opaqueRoute);
  `);

  expect(calls).toHaveLength(1);
  expect(calls[0].receiverText).toBe('fullyRenamed');
  expect(calls[0].klass).toBe('dynamic');
  expect(calls[0].provenNonNavigation).toBe(false);
});

test('drift guard 1 (falsifiability): every candidate dismissal has a failing counterexample', () => {
  const opaqueCandidates = [
    '(router).push(opaque);',
    'router!.push(opaque);',
    '(router as X).push(opaque);',
    "router['push'](opaque);",
    'renamedRouter.replace(opaque);',
    'unknown.navigate(opaque);',
    'router.push();',
  ];
  for (const source of opaqueCandidates) {
    expect(collectNavCalls(source, 'probe.tsx').map((call) => call.klass)).toEqual(['dynamic']);
  }

  const typed = collectTypedProbeCalls('const items: string[] = []; items.push(opaque); router.push(opaque);');
  expect(typed.find((call) => call.receiverText === 'items')?.provenNonNavigation).toBe(true);
  expect(typed.find((call) => call.receiverText === 'router')?.provenNonNavigation).toBe(false);
});

test('drift guard 1 (falsifiability): grants bind to file and actual argument text', () => {
  const calls = collectNavCalls('router.push(route as any); router.push(otherRoute as any);', 'probe.tsx');
  expect(calls).toHaveLength(2);
  expect(allowlistIndex('src/hooks/usePushNotifications.ts', calls[0].argText)).toBeGreaterThanOrEqual(0);
  expect(allowlistIndex('src/hooks/usePushNotifications.ts', calls[1].argText)).toBe(-1);
  expect(allowlistIndex('other/file.ts', calls[0].argText)).toBe(-1);
  expect(allowlistIndex('src/hooks/usePushNotifications.ts', 'route as any /* altered */')).toBe(-1);
  expect(allowlistIndex('app/(tabs)/chats.tsx', 'openStatusExtra')).toBe(-1);
  expect(allowlistIndex('src/services/chatOpenNavigation.ts', 'href')).toBeGreaterThanOrEqual(0);
  expect(allowlistIndex('src/services/chatOpenNavigation.ts', 'href + suffix')).toBe(-1);
});

test('drift guard 1 (insertion regression): imports and blank lines do not change real session grants', () => {
  const rel = 'app/pentacle/session/[streamId].tsx';
  const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const grants = NAV_ALLOWLIST.filter((grant) => grant.file === rel);
  const entries = (text: string) => collectNavCalls(text, rel)
    .filter((call) => grants.some((grant) => call.argText === grant.argExpression))
    .map((call) => ({ rel, call }));
  const original = entries(source);
  const shifted = entries("import 'navigation-census-insertion-probe';\n\n// unrelated insertion\n" + source);
  expect(original).toHaveLength(2);
  expect(shifted.map(({ call }) => call.line)).toEqual(original.map(({ call }) => call.line + 3));
  expect(censusNavCalls(original, grants)).toEqual({ offenders: [], stale: [] });
  expect(censusNavCalls(shifted, grants)).toEqual({ offenders: [], stale: [] });
});

test('drift guard 1 (count falsifier): an extra identical grant occurrence is rejected', () => {
  const grant = NAV_ALLOWLIST.find((entry) => entry.file === 'src/services/chatOpenNavigation.ts')!;
  const entries = (count: number) => collectNavCalls(Array(count).fill('navigator.push(href);').join('\n'), grant.file)
    .map((call) => ({ rel: grant.file, call }));
  expect(censusNavCalls(entries(grant.count), [grant])).toEqual({ offenders: [], stale: [] });
  expect(censusNavCalls(entries(grant.count + 1), [grant]).offenders).not.toEqual([]);
});

test('drift guard 1 (count falsifier): partial loss of a multi-call grant is stale', () => {
  const grant = NAV_ALLOWLIST.find((entry) => entry.file === 'src/services/chatOpenNavigation.ts')!;
  const entries = collectNavCalls(Array(grant.count - 1).fill('navigator.push(href);').join('\n'), grant.file)
    .map((call) => ({ rel: grant.file, call }));
  expect(censusNavCalls(entries, [grant]).stale).toEqual([`${grant.file}:${grant.argExpression}`]);
});

test.each([
  ['src/services/chatOpenNavigation.ts', 'navigator.push(href + suffix);'],
  ['other/file.ts', 'navigator.push(href);'],
])('drift guard 1 (binding falsifier): rejects an ungranted expression/file %s %s', (rel, source) => {
  const grant = NAV_ALLOWLIST.find((entry) => entry.file === 'src/services/chatOpenNavigation.ts')!;
  const entries = collectNavCalls(source, rel).map((call) => ({ rel, call }));
  expect(censusNavCalls(entries, [grant]).offenders).not.toEqual([]);
});

test('drift guard 1 (falsifiability): removing a granted site exposes a stale grant', () => {
  const files = [...walkSource(join(REPO_ROOT, 'src')), ...walkSource(join(REPO_ROOT, 'app'))];
  const withoutNotificationHandler = files.filter(
    (file) => relative(REPO_ROOT, file) !== 'src/hooks/usePushNotifications.ts',
  );
  const result = scanNavCensus(withoutNotificationHandler);
  expect(result.stale).toContain('src/hooks/usePushNotifications.ts:route as any');
});

// The coordinator reset must not be gated behind a test-only environment branch:
// tests and the app must execute identical chat-open code, including the
// re-open-after-ack path.
test('drift guard 3: no NODE_ENV branch on the chat-open path', () => {
  const CHAT_OPEN_SURFACE = [
    'app/(tabs)/chats.tsx',
    'src/services/chatOpenNavigation.ts',
    'src/services/chatOpenNavigationIntent.ts',
  ];
  const offenders = CHAT_OPEN_SURFACE.filter(
    (rel) => /process\.env\.NODE_ENV/.test(readFileSync(join(REPO_ROOT, rel), 'utf8')),
  );
  expect(offenders).toEqual([]);
});

describe('drift guard 2: harness + interactive open paths route through the shared unit', () => {
  const paths = {
    interactive: 'app/(tabs)/chats.tsx',
    'harness:openExisting': 'src/services/harnessOpenExistingChat.ts',
    'harness:actions': 'src/services/harnessActions.ts',
    'harness:awaitNewStream': 'src/services/harnessAwaitNewStream.ts',
  };
  const PRIMITIVES = [
    'beginChatOpenPaint(',
    'markChatOpenRouterDispatchReturned(',
    'openChatRowNavigationIntent(',
  ];
  for (const [label, rel] of Object.entries(paths)) {
    test(`${label} routes through the shared navigation unit`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(src).toMatch(/performChatOpenNavigation\(|performHarnessChatOpen\(/);
      for (const primitive of PRIMITIVES) {
        expect(src.includes(primitive)).toBe(false);
      }
    });
  }
});
