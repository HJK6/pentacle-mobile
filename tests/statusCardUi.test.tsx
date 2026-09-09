import React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  CardStatusMini,
  SessionStatusCardView,
  StatusOverlay,
  formatStatusCardAge,
  hasSessionStatusCardContent,
  statusCardStepLabel,
  lifecycleTone,
} from '../src/components/SessionStatusCard';
import type { SessionStatusCard } from 'pentacle-chat-core';
import { Tokens } from '../constants/Colors';

const session = {
  stream_id: 'hostc:codex:status-card',
  session_name: 'status-card',
  provider: 'codex',
  status: 'working',
  context_tokens: 125000,
  model_context_window: 250000,
  context_level: 'warning',
};

const card: SessionStatusCard = {
  goal: 'Ship status card UI',
  plan: [
    { text: 'types', status: 'done' },
    { text: 'overlay', status: 'active' },
    { text: 'release', status: 'pending' },
  ],
  update: 'Overlay is ready for review',
  updates: [
    { ts: '2026-07-11T10:00:00.000Z', text: 'Types landed' },
    { ts: '2026-07-11T10:05:00.000Z', text: 'Overlay is ready for review' },
  ],
  specs: [
    { id: 'ok', label: 'Healthy spec', ok: true, updated: '2026-07-11' },
    { id: 'problem-a', label: 'Held spec A', ok: false, updated: '2026-07-10', note: 'Needs QA' },
    { id: 'problem-b', label: 'Held spec B', ok: false, updated: null },
  ],
  handoff_planned: true,
  updated_at: '2026-07-11T10:04:00.000Z',
};

const updateLogUpdates = [
  { ts: '2026-07-28T20:00:00.000Z', text: 'First update' },
  { ts: '2026-07-28T20:05:00.000Z', text: 'Second update' },
];

function updateLogScrollToEnd() {
  return screen.UNSAFE_getByType(ScrollView).instance.scrollToEnd as jest.Mock;
}

function flushUpdateLogFrame() {
  act(() => jest.runOnlyPendingTimers());
}

function reportUpdateLogScroll(y: number) {
  fireEvent.scroll(screen.getByTestId('status-update-log'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 390, height: 600 },
      layoutMeasurement: { width: 390, height: 200 },
    },
  });
}

function updateLogOverlay(updates: Array<{ ts: string; text: string }>) {
  return <StatusOverlay
    session={session}
    card={{ ...card, update: updates[updates.length - 1]?.text, updates }}
    initialView="updates"
    onClose={() => {}}
    onBackToChats={() => {}}
  />;
}

test('update log ignores an unchanged status-card frame while scrolled up', () => {
  jest.useFakeTimers();
  const rendered = render(updateLogOverlay(updateLogUpdates));
  flushUpdateLogFrame();
  const scrollToEnd = updateLogScrollToEnd();
  scrollToEnd.mockClear();
  reportUpdateLogScroll(100);

  rendered.rerender(updateLogOverlay(updateLogUpdates.map((update) => ({ ...update }))));
  flushUpdateLogFrame();

  expect(scrollToEnd).not.toHaveBeenCalled();
});

test('update log preserves a scrolled-up position when a genuine update arrives', () => {
  jest.useFakeTimers();
  const rendered = render(updateLogOverlay(updateLogUpdates));
  flushUpdateLogFrame();
  const scrollToEnd = updateLogScrollToEnd();
  scrollToEnd.mockClear();
  reportUpdateLogScroll(100);

  rendered.rerender(updateLogOverlay([
    ...updateLogUpdates,
    { ts: '2026-07-28T20:10:00.000Z', text: 'Third update' },
  ]));
  flushUpdateLogFrame();

  expect(scrollToEnd).not.toHaveBeenCalled();
});

test('update log does not repeat bottom scrolling for unchanged update content', () => {
  jest.useFakeTimers();
  const rendered = render(updateLogOverlay(updateLogUpdates));
  flushUpdateLogFrame();
  const scrollToEnd = updateLogScrollToEnd();
  scrollToEnd.mockClear();
  reportUpdateLogScroll(400);

  rendered.rerender(updateLogOverlay(updateLogUpdates.map((update) => ({ ...update }))));
  flushUpdateLogFrame();

  expect(scrollToEnd).not.toHaveBeenCalled();
});

test('opening the update log lands on the latest entry once', () => {
  jest.useFakeTimers();
  render(updateLogOverlay(updateLogUpdates));
  flushUpdateLogFrame();

  expect(updateLogScrollToEnd()).toHaveBeenCalledTimes(1);
  expect(updateLogScrollToEnd()).toHaveBeenCalledWith({ animated: false });
});

test('update log follows a genuine update while already at the bottom', () => {
  jest.useFakeTimers();
  const rendered = render(updateLogOverlay(updateLogUpdates));
  flushUpdateLogFrame();
  const scrollToEnd = updateLogScrollToEnd();
  scrollToEnd.mockClear();
  reportUpdateLogScroll(400);

  rendered.rerender(updateLogOverlay([
    ...updateLogUpdates,
    { ts: '2026-07-28T20:10:00.000Z', text: 'Third update' },
  ]));
  flushUpdateLogFrame();

  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
});

test('malformed lifecycle colors fall back to the neutral card palette', () => {
  expect(lifecycleTone({ name: 'mystery', color: 'not-a-native-color' })).toEqual({
    stroke: Tokens.palette.line,
    fill: 'rgba(255,255,255,0.025)',
  });
});

test('inline mini is presentational, partial-safe, and opens its stream', () => {
  jest.useFakeTimers({ now: new Date('2026-07-11T10:05:00.000Z') });
  const onOpen = jest.fn();
  render(<CardStatusMini session={session} card={card} onOpen={onOpen} />);
  expect(screen.getByText('Ship status card UI')).toBeTruthy();
  expect(screen.getByLabelText('1 of 3 plan steps complete')).toBeTruthy();
  expect(screen.getByText('overlay')).toBeTruthy();
  expect(screen.getByTestId('status-card-context').props.accessibilityLabel).toBe('125k · 50%');
  expect(screen.getByText('1/3')).toBeTruthy();
  expect(screen.queryByText(/ctx/i)).toBeNull();
  expect(screen.queryByText('Healthy spec')).toBeNull();
  fireEvent.press(screen.getByTestId('card-status-mini-hostc:codex:status-card'));
  expect(onOpen).toHaveBeenCalledWith('hostc:codex:status-card');

  const partial = render(<CardStatusMini session={session} card={{ updated_at: card.updated_at, plan: [{ text: 'done', status: 'done' }] }} onOpen={onOpen} />);
  expect(partial.queryByText('overlay')).toBeNull();
  expect(partial.queryByText('Healthy spec')).toBeNull();
  jest.useRealTimers();
});

test('overlay orders held specs first, exposes accessible status, and uses two-stage close from updates', () => {
  const onClose = jest.fn();
  const onBackToChats = jest.fn();
  render(<StatusOverlay session={session} card={card} onClose={onClose} onBackToChats={onBackToChats} />);
  expect(screen.getByTestId('status-overlay')).toBeTruthy();
  expect(screen.getByText('SPECS')).toBeTruthy();
  expect(screen.getByText('· 2 issues')).toBeTruthy();
  expect(screen.getByLabelText('active plan step: overlay')).toBeTruthy();
  expect(screen.getByLabelText('Issue spec Held spec A')).toBeTruthy();
  const order = screen.toJSON() ? JSON.stringify(screen.toJSON()) : '';
  expect(order.indexOf('Held spec A')).toBeLessThan(order.indexOf('Healthy spec'));
  expect(screen.queryByLabelText(/Resolve spec/)).toBeNull();

  fireEvent.press(screen.getByLabelText('Open 2 status updates'));
  expect(screen.getByTestId('status-update-log')).toBeTruthy();
  fireEvent.press(screen.getByTestId('status-overlay-close'));
  expect(screen.queryByTestId('status-update-log')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('status-overlay-close'));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByTestId('status-overlay-back'));
  expect(onBackToChats).toHaveBeenCalledTimes(1);
});

test('overlay latest update keeps text flexible for a right-side chevron', () => {
  render(<StatusOverlay session={session} card={card} onClose={() => {}} onBackToChats={() => {}} />);
  const updateText = screen.getByText('Overlay is ready for review');
  expect(updateText.props.style).toEqual(expect.objectContaining({ flex: 1 }));
  expect(screen.getByLabelText('Open 2 status updates')).toBeTruthy();
});

test('overlay keeps a missing history static and omits absent specs without fabricating state', () => {
  render(<StatusOverlay session={session} card={{ goal: 'Partial card', update: 'Static update', updated_at: card.updated_at }} onClose={() => {}} onBackToChats={() => {}} />);
  expect(screen.getByText('Partial card')).toBeTruthy();
  expect(screen.getByLabelText('Latest status update').props.accessibilityRole).toBe('text');
  expect(screen.queryByTestId('status-overlay-specs')).toBeNull();
  expect(screen.queryByText('0 ok')).toBeNull();
});

test('status helpers describe time, plan progress, and actual card presence at boundary values', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z');
  expect(formatStatusCardAge(undefined, now)).toBe('');
  expect(formatStatusCardAge('not-a-date', now)).toBe('');
  expect(formatStatusCardAge('2026-07-14T12:01:00.000Z', now)).toBe('just now');
  expect(formatStatusCardAge('2026-07-14T11:59:31.000Z', now)).toBe('just now');
  expect(formatStatusCardAge('2026-07-14T11:58:00.000Z', now)).toBe('2m ago');
  expect(formatStatusCardAge('2026-07-14T09:00:00.000Z', now)).toBe('3h ago');
  expect(formatStatusCardAge('2026-07-11T12:00:00.000Z', now)).toBe('3d ago');

  expect(statusCardStepLabel()).toBe('');
  expect(statusCardStepLabel([])).toBe('');
  expect(statusCardStepLabel([{ text: ' queued ', status: 'pending' }])).toBe('0/1');
  expect(statusCardStepLabel([{ text: 'done', status: 'done' }])).toBe('1/1 done');
  expect(statusCardStepLabel([
    { text: 'done', status: 'done' },
    { text: '  active\n step ', status: 'active' },
  ])).toBe('2/2 · active step');

  expect(hasSessionStatusCardContent()).toBe(false);
  expect(hasSessionStatusCardContent(null)).toBe(false);
  expect(hasSessionStatusCardContent({ status_card: null })).toBe(false);
  expect(hasSessionStatusCardContent({ status_card: { goal: 'real', updated_at: '' } })).toBe(true);
});

test('row status card renders normalized content, context severity, handoff, and issue detail fallbacks', () => {
  jest.useFakeTimers({ now: new Date('2026-07-14T12:00:00.000Z') });
  const { rerender } = render(<SessionStatusCardView source={{
    status_card: {
      goal: '  Ship\n safely ',
      plan: [{ text: ' execute ', status: 'active' }],
      update: '  Gate\tgreen ',
      handoff_planned: true,
      updated_at: '2026-07-14T11:58:00.000Z',
    },
    context_tokens: 12_600,
    model_context_window: 25_000,
    context_level: 'critical',
    spec_issues: [
      { obligation_id: 'coverage', detail: '  Branch\n gate ' },
      { obligation_id: 'qa' },
      {} as never,
      null as never,
    ],
  }} showIssueDetails variant="header" />);
  expect(screen.getByText('Ship safely')).toBeTruthy();
  expect(screen.getByText('1/1 · execute')).toBeTruthy();
  expect(screen.getByText('Gate green')).toBeTruthy();
  expect(screen.getByText('2m ago')).toBeTruthy();
  expect(screen.getByText('13k · 50%')).toBeTruthy();
  expect(screen.getByText('3 spec issues')).toBeTruthy();
  expect(screen.getByText('Branch gate')).toBeTruthy();
  expect(screen.getByText('qa')).toBeTruthy();
  expect(screen.getByText('spec issue')).toBeTruthy();
  expect(screen.getByTestId('session-status-card-handoff')).toBeTruthy();

  rerender(<SessionStatusCardView source={{
    status_card: { goal: 'Warning context', updated_at: '' },
    context_tokens: 1_000,
    model_context_window: null,
    context_level: 'warn',
    spec_issues: [{ obligation_id: 'only' }],
  }} />);
  expect(screen.getByText('1k')).toBeTruthy();
  expect(screen.getByText('1 spec issue')).toBeTruthy();

  rerender(<SessionStatusCardView source={{
    status_card: { updated_at: '' },
    context_tokens: Number.NaN,
    context_level: 'custom',
  }} />);
  expect(screen.getByTestId('session-status-card')).toBeTruthy();
  expect(screen.queryByTestId('session-status-card-context')).toBeNull();
  rerender(<SessionStatusCardView source={null} />);
  expect(screen.queryByTestId('session-status-card')).toBeNull();
  jest.useRealTimers();
});

test('mini supports streamId fallback and hides truly empty session status', () => {
  const onOpen = jest.fn();
  const { rerender } = render(<CardStatusMini
    session={{ streamId: 'hosta:claude:fallback', context_tokens: 4_000, model_context_window: 0, context_level: 'custom' }}
    card={{ handoff_planned: true, updated_at: '' }}
    onOpen={onOpen}
  />);
  expect(screen.getByText('4k')).toBeTruthy();
  expect(screen.getByText('↗ handoff')).toBeTruthy();
  fireEvent.press(screen.getByTestId('card-status-mini-hosta:claude:fallback'));
  expect(onOpen).toHaveBeenCalledWith('hosta:claude:fallback');

  rerender(<CardStatusMini session={{ streamId: 'empty' }} card={{ updated_at: '' }} onOpen={onOpen} />);
  expect(screen.queryByTestId('card-status-mini-empty')).toBeNull();
  rerender(<CardStatusMini session={{ context_tokens: 2_000 }} card={{ goal: 'missing stream', updated_at: '' }} onOpen={onOpen} />);
  expect(screen.queryByText('missing stream')).toBeNull();
});

test('overlay supports a custom header, filtered history, all-green specs, and direct update-log back', () => {
  const header = jest.fn(({ close, backToChats, viewingUpdates }) => (
    <>
      <Pressable testID="custom-close" onPress={close}><Text>{viewingUpdates ? 'return' : 'close'}</Text></Pressable>
      <Pressable testID="custom-back" onPress={backToChats}><Text>chats</Text></Pressable>
    </>
  ));
  const onClose = jest.fn();
  const onBackToChats = jest.fn();
  render(<StatusOverlay
    session={{ streamId: 'fallback', provider: '', status: '', context_tokens: 0 }}
    card={{
      plan: [{ text: 'complete', status: 'done' }],
      update: 'Latest',
      updates: [{ ts: '2026-07-14T10:00:00.000Z', text: ' ' }, { ts: '2026-07-14T11:00:00.000Z', text: 'Latest' }],
      specs: [{ id: 'ok', label: 'Passing spec', ok: true, updated: null }],
      updated_at: '',
    }}
    initialView="updates"
    onClose={onClose}
    onBackToChats={onBackToChats}
    renderHeader={header}
  />);
  expect(screen.getByTestId('status-update-log')).toBeTruthy();
  expect(screen.getByText('Latest')).toBeTruthy();
  expect(header).toHaveBeenCalledWith(expect.objectContaining({ viewingUpdates: true }));
  fireEvent.press(screen.getByTestId('status-update-log-back'));
  expect(screen.getByText('· 1 ok')).toBeTruthy();
  expect(screen.getByLabelText('OK spec Passing spec')).toBeTruthy();
  fireEvent.press(screen.getByTestId('custom-back'));
  fireEvent.press(screen.getByTestId('custom-close'));
  expect(onBackToChats).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('default overlay supplies session fallbacks and exposes one-update and one-issue states', () => {
  jest.useFakeTimers({ now: new Date('2026-07-14T12:00:00.000Z') });
  render(<StatusOverlay
    session={{ context_tokens: 2_000, model_context_window: 4_000, context_level: 'error' }}
    card={{
      goal: 'Fallback session',
      update: 'Only update',
      updates: [{ ts: '2026-07-14T11:59:30.000Z', text: 'Only update' }],
      specs: [{ id: 'held', label: 'Held once', ok: false, note: ' Needs work ', updated: null }],
      updated_at: '',
    }}
    onClose={() => {}}
    onBackToChats={() => {}}
  />);
  expect(screen.getByText('Session status')).toBeTruthy();
  expect(screen.getByText('session · live')).toBeTruthy();
  expect(screen.getByText('· 1 issue')).toBeTruthy();
  expect(screen.getByText('Needs work')).toBeTruthy();
  expect(screen.queryByText('1 updates')).toBeNull();
  fireEvent.press(screen.getByLabelText('Open 1 status updates'));
  expect(screen.getByText('LATEST')).toBeTruthy();
  jest.useRealTimers();
});

test('overlay shows model and effort and labels specs from the daemon lifecycle palette', () => {
  const rendered = render(<StatusOverlay
    session={{ session_name: 'enriched', provider: 'codex', model: 'gpt-5.6-codex', effort: 'xhigh' }}
    card={{
      specs: [
        { id: 'held', label: 'Held spec', ok: true, updated: null, status: 'in_progress' },
        { id: 'unknown', label: 'Unknown status spec', ok: false, updated: null, status: 'mystery' },
      ],
      updated_at: '',
    }}
    specStatuses={[{ name: 'in_progress', display_label: 'In Progress', color: '#7c5cff' }]}
    onClose={() => {}}
    onBackToChats={() => {}}
  />);
  expect(screen.getByTestId('status-overlay-model-effort')).toHaveTextContent('5.6 Codex · xhigh');
  expect(screen.getByText('In Progress')).toBeTruthy();
  expect(screen.getByLabelText('OK spec Held spec, lifecycle In Progress')).toBeTruthy();
  expect(screen.getByText('mystery')).toBeTruthy();
  expect(screen.getByLabelText('Issue spec Unknown status spec, lifecycle mystery')).toBeTruthy();
  rendered.unmount();

  const lone = render(<StatusOverlay
    session={{ session_name: 'model-only', model: 'claude-fable-5', effort: ' ' }}
    card={{ updated_at: '' }}
    onClose={() => {}}
    onBackToChats={() => {}}
  />);
  expect(screen.getByTestId('status-overlay-model-effort')).toHaveTextContent('Fable 5');
  lone.unmount();

  render(<StatusOverlay session={{ session_name: 'blank' }} card={{ updated_at: '' }} onClose={() => {}} onBackToChats={() => {}} />);
  expect(screen.queryByTestId('status-overlay-model-effort')).toBeNull();
});

