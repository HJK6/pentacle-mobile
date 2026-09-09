import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { act, render } from '@testing-library/react-native';

import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleTranscriptItem } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from '../src/services/mobileTelemetryEvents';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

// Warm transforms outside timed bodies without retaining a pre-harness module instance.
jest.isolateModules(() => require('../app/pentacle/session/[streamId]'));

const STREAM_ID = 'hostc:codex:render';
const chrome = {
  header: '#07110d',
  accent: '#7ef0ba',
  surface: '#0e1814',
  border: '#253f34',
  title: 'hostc',
};

const transcriptItem: PentacleTranscriptItem = {
  id: '12',
  timestampLabel: '',
  label: 'Codex',
  tone: 'assistant',
  provider: 'codex',
  source: '',
  text: 'Rendered assistant text with enough characters to prove prefix truncation works.',
  kind: 'ASSIST',
  isUser: false,
  eventCase: 'assistant',
  displayRule: 'bubble:assistant',
  eventKey: `${STREAM_ID}:12`,
  optimisticId: 'optimistic_render_1',
};

const workingState = {
  stream_id: STREAM_ID,
  timestamp: '2026-05-16T12:00:00Z',
  tokens_input: 0,
  tokens_output: 0,
  tokens_cache_read: 0,
  tokens_cache_creation: 0,
  tokens_phase: 'idle' as const,
  shell_count_started: 0,
  tasks: [],
  task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
  elapsed_ms: 0,
};

function armHarness() {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=render_confirmation&scenario_run_id=run-123');
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
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

test('TranscriptRow emits bounded harness row_rendered payload and dedupes while mounted', async () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const { TranscriptRow } = require('../app/pentacle/session/[streamId]') as typeof import('../app/pentacle/session/[streamId]');

  const rendered = render(<TranscriptRow item={transcriptItem} chrome={chrome} streamId={STREAM_ID} />);
  await act(async () => {});

  const rowEvents = () => seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_ROW_RENDERED);
  expect(rowEvents()).toHaveLength(1);
  expect(rowEvents()[0].data).toMatchObject({
    scenario_run_id: 'run-123',
    stream_id: STREAM_ID,
    row_id: '12',
    row_kind: 'ASSIST',
    displayRule: 'bubble:assistant',
    display_rule: 'bubble:assistant',
    text_prefix: 'Rendered assistant text with enough char',
    text_digest: expect.any(String),
    event_key: `${STREAM_ID}:12`,
    optimistic_id: 'optimistic_render_1',
    component_name: 'TranscriptRow',
    lifecycle: 'mount',
    mount_generation: 0,
    viewport_visible: true,
  });
  const standardRowEvents = seen.filter((event) => event.message === MOBILE_TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED);
  expect(standardRowEvents).toHaveLength(1);
  expect(standardRowEvents[0].data).toMatchObject({
    stream_id: STREAM_ID,
    row_id: '12',
    row_kind: 'ASSIST',
    display_rule: 'bubble:assistant',
    text_digest: rowEvents()[0].data.text_digest,
  });

  rendered.rerender(<TranscriptRow item={{ ...transcriptItem, text: `${transcriptItem.text} updated` }} chrome={chrome} streamId={STREAM_ID} />);
  await act(async () => {});
  expect(rowEvents()).toHaveLength(1);

  rendered.unmount();
  render(<TranscriptRow item={transcriptItem} chrome={chrome} streamId={STREAM_ID} />);
  await act(async () => {});

  expect(rowEvents()).toHaveLength(2);
  expect(rowEvents()[1].data).toMatchObject({
    row_id: '12',
    component_name: 'TranscriptRow',
    lifecycle: 'mount',
    mount_generation: 1,
  });
});

test('TranscriptRow suppresses turn duration rows only when the preference is off', async () => {
  const { TranscriptRow } = require('../app/pentacle/session/[streamId]') as typeof import('../app/pentacle/session/[streamId]');
  const divider: PentacleTranscriptItem = {
    ...transcriptItem,
    id: 'divider-1',
    displayRule: 'terminal:divider',
    text: 'Worked for 1m 02s',
  };
  const summary: PentacleTranscriptItem = {
    ...transcriptItem,
    id: 'summary-1',
    displayRule: 'activity:turn-summary',
    text: 'Worked for 1m 02s',
  };

  expect(render(<TranscriptRow item={divider} chrome={chrome} streamId={STREAM_ID} showTurnDuration={false} />).toJSON()).toBeNull();
  expect(render(<TranscriptRow item={summary} chrome={chrome} streamId={STREAM_ID} showTurnDuration={false} />).toJSON()).toBeNull();
  expect(render(<TranscriptRow item={divider} chrome={chrome} streamId={STREAM_ID} showTurnDuration />).getByTestId('terminal-divider-row')).toBeTruthy();
  expect(render(<TranscriptRow item={summary} chrome={chrome} streamId={STREAM_ID} showTurnDuration />).getByTestId('turn-summary-divider-row')).toBeTruthy();
});

test('WorkingDock emits mount/unmount row telemetry plus label render changes', async () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const { WorkingDock } = require('../app/pentacle/session/[streamId]') as typeof import('../app/pentacle/session/[streamId]');

  const rendered = render(
    <WorkingDock
      chrome={chrome}
      streamId={STREAM_ID}
      workingLabel=""
      workingState={workingState}
      workingStartedAt={1_000_000}
    />,
  );
  await act(async () => {});

  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  rendered.unmount();
  await act(async () => {});

  const rowEvents = seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_ROW_RENDERED);
  expect(rowEvents.map((event) => event.data.lifecycle)).toEqual(['mount', 'unmount']);
  expect(rowEvents[0].data).toMatchObject({
    scenario_run_id: 'run-123',
    stream_id: STREAM_ID,
    row_id: `working_dock:${STREAM_ID}`,
    displayRule: 'component:working-dock',
    component_name: 'WorkingDock',
    mount_generation: 0,
  });

  const labelEvents = seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_DOCK_LABEL_RENDER);
  expect(labelEvents.length).toBeGreaterThanOrEqual(2);
  expect(labelEvents[0].data).toMatchObject({
    scenario_run_id: 'run-123',
    stream_id: STREAM_ID,
    label: 'Working · 00:00',
    elapsed_seconds: 0,
  });
  expect(labelEvents[labelEvents.length - 1].data).toMatchObject({
    label: 'Working · 00:01',
    elapsed_seconds: 1,
  });
});

test('new harness render event names stay out of app source as full production bundle strings', () => {
  const screenSource = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');
  const registrySource = readFileSync(resolve('pentacle-chat-core/src/utils/telemetryEvents.ts'), 'utf8');

  for (const source of [screenSource, registrySource]) {
    expect(source).not.toContain("'harness:row_rendered'");
    expect(source).not.toContain('"harness:row_rendered"');
    expect(source).not.toContain("'harness:dock_label_render'");
    expect(source).not.toContain('"harness:dock_label_render"');
    expect(source).not.toContain("'harness:header_status_render'");
    expect(source).not.toContain('"harness:header_status_render"');
  }
  expect(screenSource).not.toContain('export function QuestionCard');
  expect(screenSource).not.toContain('chat:question_rendered');
});

