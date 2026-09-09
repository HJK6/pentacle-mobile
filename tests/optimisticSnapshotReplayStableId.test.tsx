import React from 'react';
import { act, render } from '@testing-library/react-native';

import {
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  reconcileOptimisticSendWithServerEvent,
  selectSessionDetail,
  sendOptimisticMessage,
  setTelemetrySink,
  TELEMETRY_EVENTS,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
  type TelemetryPayload,
} from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

const STREAM_ID = 'hostc:codex:a';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_a_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-05-27T12:00:00.000Z');

const chrome = {
  header: '#07110d',
  accent: '#7ef0ba',
  surface: '#0e1814',
  border: '#253f34',
  title: 'hostc',
};

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'a',
    last_event_at: '2026-05-27T12:00:01.000Z',
    last_text: 'match me',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    connected: true,
    hasHydrated: true,
    sessions: [session()],
    ...overrides,
  };
}

function serverUserEvent(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 41,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'a',
    stream_id: STREAM_ID,
    timestamp: '2026-05-27T12:00:01.000Z',
    kind: 'USER',
    text: 'match me',
    ...overrides,
  };
}

function armHarness() {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=optimistic_snapshot_replay&scenario_run_id=run-stable-id');
}

// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../app/pentacle/session/[streamId]'));

beforeEach(() => {
  jest.useFakeTimers({ now: CREATED_AT + 2_000 });
  armHarness();
});

afterEach(() => {
  setTelemetrySink(null);
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('snapshot replay after live reconcile preserves the optimistic row id without remounting it', async () => {
  const serverEcho = serverUserEvent();
  const optimistic = sendOptimisticMessage(buildState(), {
    streamId: STREAM_ID,
    text: 'match me',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
  const liveReconciled = reconcileOptimisticSendWithServerEvent(
    optimistic,
    OPTIMISTIC_ID,
    serverEcho,
  );
  const liveRow = selectSessionDetail(liveReconciled, STREAM_ID, { visibleCount: 'all' })
    ?.transcriptItems.find((item) => item.text === 'match me');
  expect(liveRow).toMatchObject({
    id: OPTIMISTIC_ID,
    optimisticId: OPTIMISTIC_ID,
    correlatedDaemonSeq: 41,
  });

  const snapshotReplayed = applySnapshotWithOptimisticReconciliation(liveReconciled, {
    sessions: [session()],
    events: [serverEcho],
  }, CREATED_AT + 2_000);
  const snapshotRows = selectSessionDetail(snapshotReplayed, STREAM_ID, { visibleCount: 'all' })
    ?.transcriptItems.filter((item) => item.text === 'match me') || [];
  expect(snapshotRows).toHaveLength(1);
  expect(snapshotRows[0]).toMatchObject({
    id: OPTIMISTIC_ID,
    optimisticId: OPTIMISTIC_ID,
    correlatedDaemonSeq: 41,
  });

  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const { TranscriptRow } = require('../app/pentacle/session/[streamId]') as typeof import('../app/pentacle/session/[streamId]');

  const rendered = render(
    <TranscriptRow key={liveRow!.id} item={liveRow!} chrome={chrome} streamId={STREAM_ID} />,
  );
  await act(async () => {});
  rendered.rerender(
    <TranscriptRow key={snapshotRows[0].id} item={snapshotRows[0]} chrome={chrome} streamId={STREAM_ID} />,
  );
  await act(async () => {});

  const mountEvents = seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ITEM_MOUNTED);
  expect(mountEvents).toHaveLength(1);
  expect(mountEvents[0].data).toMatchObject({
    id: OPTIMISTIC_ID,
    mount_generation: 1,
    stream_id: STREAM_ID,
  });
});
