import type { TelemetryPayload } from 'pentacle-chat-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeAll(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
});

afterAll(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
});

test('runAllChatsRegression gates five ordered actions on ready/commit telemetry', async () => {
  jest.resetModules();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const seen: TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));
  const requests: Array<{ action_id: string; action: string; burst: number }> = [];
  const daemonSeqBarriers: number[] = [];
  let currentDaemonSeq = 0;
  let returnCount = 0;
  let unreadCount = 16;
  let openQuestionCount = 16;
  const controlTimeline: string[] = [];

  const promise = actions.runAllChatsRegression({
    timeoutMs: 500,
    streamId: 'mock-host:freeze-00',
    waitForDaemonSeq: async (expectedDaemonSeq) => {
      controlTimeline.push(`barrier:${expectedDaemonSeq}`);
      daemonSeqBarriers.push(expectedDaemonSeq);
      currentDaemonSeq = expectedDaemonSeq;
      return true;
    },
    getFixtureState: () => ({
      eventCount: currentDaemonSeq,
      maxDaemonSeq: currentDaemonSeq,
      unreadCount,
      openQuestionCount,
      sessionSummaryCount: 64,
      perStreamRetainedMax: 300,
    }),
    seedFixtureState: async () => {
      controlTimeline.push('seed:16');
    },
    applyFixtureState: async (burst) => {
      controlTimeline.push(`apply:${burst}`);
      unreadCount -= 1;
      openQuestionCount -= 1;
    },
    returnToAllChats: async () => {
      returnCount += 1;
    },
    dispatch: async (request) => {
      controlTimeline.push(`dispatch:${request.burst}`);
      requests.push(request);
      telemetry.logTelemetry('harness:all_chats_action_started' as never, {
        ...request,
        state_revision: request.burst,
        action_at_ms: request.burst,
      });
      telemetry.logTelemetry('harness:all_chats_row_committed' as never, {
        ...request,
        state_revision: request.burst,
        row_digest: `digest-${request.burst}`,
        committed_at_ms: request.burst,
        newest_event_ms: request.burst,
        unread_count: unreadCount,
        working: false,
        open_question_count: openQuestionCount,
      });
      telemetry.logTelemetry('harness:all_chats_action_settled' as never, {
        ...request,
        state_revision: request.burst,
        settled_at_ms: request.burst,
      });
      return { status: 'ok' };
    },
  });
  telemetry.logTelemetry('harness:all_chats_ready' as never, {
    state_revision: 1,
    row_count: 64,
  });
  await promise;

  expect(requests).toHaveLength(5);
  expect(requests.map(({ action, burst }) => [action, burst])).toEqual([
    ['scroll', 1],
    ['open_return', 2],
    ['scroll', 3],
    ['pull_refresh', 4],
    ['scroll', 5],
  ]);
  expect(seen.filter((payload) => String(payload.message) === 'harness:all_chats_row_committed')).toHaveLength(5);
  expect(daemonSeqBarriers).toEqual([1120, 1136, 1152, 1168, 1184, 1200]);
  expect(returnCount).toBe(1);
  const advances = seen.filter(
    (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'all_chats_fixture_advance',
  );
  const applied = seen.filter(
    (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'all_chats_fixture_applied',
  );
  expect(advances.map((payload) => payload.data.expected_daemon_seq)).toEqual([1136, 1152, 1168, 1184, 1200]);
  expect(applied.map((payload) => [payload.data.store_event_count, payload.data.max_daemon_seq])).toEqual([
    [1136, 1136],
    [1152, 1152],
    [1168, 1168],
    [1184, 1184],
    [1200, 1200],
  ]);
  expect(applied.map((payload) => payload.data.unread_count)).toEqual([15, 14, 13, 12, 11]);
  expect(applied.map((payload) => payload.data.open_question_count)).toEqual([15, 14, 13, 12, 11]);
  expect(controlTimeline).toEqual([
    'barrier:1120',
    'seed:16',
    'barrier:1136', 'apply:1', 'dispatch:1',
    'barrier:1152', 'apply:2', 'dispatch:2',
    'barrier:1168', 'apply:3', 'dispatch:3',
    'barrier:1184', 'apply:4', 'dispatch:4',
    'barrier:1200', 'apply:5', 'dispatch:5',
  ]);
  telemetry.setTelemetrySink(null);
});

test('runAllChatsRegression accepts the mounted-screen readiness witness after listener setup', async () => {
  jest.resetModules();
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  let ready = false;
  setTimeout(() => { ready = true; }, 0);
  const daemonSeqBarriers: number[] = [];

  await actions.runAllChatsRegression({
    timeoutMs: 200,
    isReady: () => ready,
    waitForDaemonSeq: async (daemonSeq) => {
      daemonSeqBarriers.push(daemonSeq);
      return daemonSeq === 1120;
    },
    dispatch: async () => ({ status: 'ok' }),
  });

  expect(daemonSeqBarriers).toEqual([1120, 1136]);
});

test('stress setup gets ingestion allowance without changing action timeouts', async () => {
  jest.resetModules();
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const barriers: Array<[number, number]> = [];

  await actions.runAllChatsRegression({
    timeoutMs: 200,
    setupEventCount: 19_120,
    isReady: () => true,
    waitForDaemonSeq: async (daemonSeq, timeoutMs) => {
      barriers.push([daemonSeq, timeoutMs]);
      return daemonSeq === 19_120;
    },
    dispatch: async () => ({ status: 'ok' }),
  });

  expect(barriers).toEqual([[19_120, 180_000], [19_136, 200]]);
  const source = readFileSync(resolve(__dirname, '../src/services/harnessActions.ts'), 'utf8');
  expect(source).toContain('waitForCondition(deps.isReady, timeoutMs)');
  expect(source).toContain('waitForTelemetry((payload) => payload.message === ALL_CHATS_READY, timeoutMs)');
});

test('mountAllChatsRegressionScreen mounts the real Chats route and is fail-closed', () => {
  jest.resetModules();
  const navigationTelemetry = jest.fn();
  jest.doMock('../src/services/mobileTabsTelemetry', () => ({ logMobileTabsTelemetry: navigationTelemetry }));
  const actions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const registry = require('../src/services/mobileTelemetryEvents') as typeof import('../src/services/mobileTelemetryEvents');
  const routes: string[] = [];
  expect(actions.mountAllChatsRegressionScreen({ push: jest.fn(), replace: (route: string) => routes.push(route) })).toBe(true);
  expect(routes).toEqual(['/chats']);
  expect(actions.mountAllChatsRegressionScreen({ push: jest.fn() })).toBe(false);
  expect(actions.mountAllChatsRegressionScreen({ push: jest.fn(), replace: () => { throw new Error('unmounted'); } })).toBe(false);
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_NAVIGATION_ATTEMPT).toBe('harness:all_chats_navigation_attempt');
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_NAVIGATION_RESULT).toBe('harness:all_chats_navigation_result');
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_READY).toBe('harness:all_chats_ready');
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ACTION_STARTED).toBe('harness:all_chats_action_started');
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ROW_COMMITTED).toBe('harness:all_chats_row_committed');
  expect(registry.MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ACTION_SETTLED).toBe('harness:all_chats_action_settled');
  expect(navigationTelemetry.mock.calls.map(([event]) => event)).toEqual([
    'harness:all_chats_navigation_attempt',
    'harness:all_chats_navigation_result',
    'harness:all_chats_navigation_attempt',
    'harness:all_chats_navigation_result',
    'harness:all_chats_navigation_attempt',
    'harness:all_chats_navigation_result',
  ]);
  expect(navigationTelemetry.mock.calls.map(([, payload]) => payload)).toEqual([{}, {}, {}, {}, {}, {}]);
});

test('all chats navigation markers are registry-only and action/harness gated', () => {
  const root = resolve(__dirname, '..');
  const actionsSource = readFileSync(resolve(root, 'src/services/harnessActions.ts'), 'utf8');
  const layoutSource = readFileSync(resolve(root, 'app/_layout.tsx'), 'utf8');
  const chatsSource = readFileSync(resolve(root, 'app/(tabs)/chats.tsx'), 'utf8');
  const registrySource = readFileSync(resolve(root, 'src/services/mobileTelemetryEvents.ts'), 'utf8');
  const navigationHelper = actionsSource.slice(
    actionsSource.indexOf('export function mountAllChatsRegressionScreen'),
    actionsSource.indexOf('export async function runAllChatsRegression'),
  );
  expect(registrySource.match(/harness:all_chats_navigation_(attempt|result)/g)).toHaveLength(2);
  expect(navigationHelper).not.toMatch(/harness:all_chats_navigation_/);
  expect(navigationHelper).not.toMatch(/(token|url|stream_id|ws_url)\s*:/);
  expect(layoutSource.indexOf("if (!harnessRuntime.hasAction('all_chats_regression')) return;")).toBeLessThan(
    layoutSource.indexOf('mountAllChatsRegressionScreen'),
  );
  expect(layoutSource.indexOf('harnessActions.runAllChatsRegression')).toBeLessThan(
    layoutSource.indexOf('mountAllChatsRegressionScreen'),
  );
  expect(layoutSource.indexOf("process.env.EXPO_PUBLIC_HARNESS === '1'")).toBeLessThan(
    layoutSource.indexOf('dispatchAllChatsRegression();'));
  expect(chatsSource).toMatch(/allChatsHarnessCommitMatches\(pending, unreadCount, openQuestionCount\)/);
  expect(chatsSource).toMatch(/allChatsHarnessActive[\s\S]*mock-host:freeze-/);
  expect(chatsSource).toMatch(/expected_unread_count === undefined[\s\S]*expected_open_question_count === undefined/);
  const fixtureNotification = layoutSource.slice(
    layoutSource.indexOf('const fixtureNotification'),
    layoutSource.indexOf('const fixtureReportFrame'),
  );
  expect(fixtureNotification).toMatch(/question:\s*\{[\s\S]*?\bstate,/);
});

test('reconnect preserves the event store only for the armed All Chats regression', () => {
  const root = resolve(__dirname, '..');
  const streamSource = readFileSync(resolve(root, 'src/services/pentacleStream.ts'), 'utf8');
  const reconnectSource = streamSource.slice(
    streamSource.indexOf('export function reconnectPentacleStream'),
    streamSource.indexOf('export function registerFocusedPentacleStream'),
  );
  expect(reconnectSource).toMatch(/preserveHarnessEvents = process\.env\.EXPO_PUBLIC_HARNESS === '1'/);
  expect(reconnectSource).toMatch(/harnessRuntime\.isArmed\(\).*harnessRuntime\.hasAction\('all_chats_regression'\)/s);
  // main refactored reconnect onto mutatePentacleEventBuckets: the armed harness
  // preserves the store via a snapshot-replace, all other reconnects reset.
  expect(reconnectSource).toMatch(/preserveHarnessEvents[\s\S]*\{ type: 'snapshot-replace', events: state\.events \}/);
  expect(reconnectSource).toMatch(/\{ type: 'reset', reason \}/);
});

test('the real All Chats screen witness waits for the complete locked corpus', () => {
  const root = resolve(__dirname, '..');
  const chatsSource = readFileSync(resolve(root, 'app/(tabs)/chats.tsx'), 'utf8');
  expect(chatsSource).toMatch(/ALL_CHATS_HARNESS_SESSION_COUNT = 64/);
  expect(chatsSource).toMatch(/chats\.length !== ALL_CHATS_HARNESS_SESSION_COUNT/);
});

test('harness reconnect snapshots merge prior events before reducer replacement', () => {
  const root = resolve(__dirname, '..');
  const streamSource = readFileSync(resolve(root, 'src/services/pentacleStream.ts'), 'utf8');
  const snapshotSource = streamSource.slice(
    streamSource.indexOf("if (message.type === 'snapshot')"),
    streamSource.indexOf("if (message.type === 'chat.event')"),
  );
  expect(snapshotSource).toMatch(/snapshotEvents/);
  expect(snapshotSource).toMatch(/state\.events/);
});
