jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { PentacleEvent } from 'pentacle-chat-core';
import LaneHistoryScreen from '../../../src/components/lanes/LaneHistoryScreen';

const target = { streamId: 'fixture-host:v2-lead0003', generation: 'gen-lead-0003', title: 'Household boards' };
const event = (seq: number, kind: string, text: string, extra: Partial<PentacleEvent> = {}): PentacleEvent => ({
  daemon_seq: seq, host: 'fixture-host', provider: 'claude', session_id: 's', session_name: 'v2-lead0003',
  stream_id: target.streamId, timestamp: `2026-10-07T12:00:${String(seq).padStart(2, '0')}Z`, kind, text, ...extra,
});

async function mount(readHistory: jest.Mock, props: Partial<React.ComponentProps<typeof LaneHistoryScreen>> = {}) {
  const onClose = jest.fn();
  const view = render(<LaneHistoryScreen target={target} connected readHistory={readHistory} onClose={onClose}
    top={0} bottom={0} {...props} />);
  await act(async () => {});
  return { view, onClose };
}

test('requests the lane generation and renders the retained transcript read-only, oldest first', async () => {
  const readHistory = jest.fn().mockResolvedValue([
    event(3, 'ASSIST', 'Third'), event(1, 'USER', 'First'), event(2, 'ASSIST', 'Second'),
    event(4, 'TOOL', 'tool noise'), event(5, 'ASSIST', ''),
  ]);
  const { view } = await mount(readHistory);
  expect(readHistory).toHaveBeenCalledWith('fixture-host:v2-lead0003', 'gen-lead-0003', expect.objectContaining({ limit: expect.any(Number) }));
  const rows = view.getAllByTestId(/^lane-history-row-/).map((row) => row.props.testID);
  expect(rows).toEqual(['lane-history-row-1', 'lane-history-row-2', 'lane-history-row-3']);
  expect(view.getByText('Household boards')).toBeTruthy();
  expect(view.getByText('READ-ONLY · CLOSED CHAT')).toBeTruthy();
  expect(view.queryByTestId('composer-input')).toBeNull();
  expect(view.queryByText('tool noise')).toBeNull();
});

test('lane updates in a retained transcript render as typed cards', async () => {
  const update = event(7, 'ASSIST_TEXT', 'Blocker cleared: review', {
    publish_kind: 'lane_update',
    raw: { lane_update: { update_id: 'lane-update:l:s', lane_id: 'l', kind: 'lane_unblocked', summary: 'Blocker cleared: review',
      source: { type: 'transition', id: 's' }, state: 'paused', prior_state: 'blocked', owner_kind: 'fd', title: 'Boards', ts: '2026-10-07T12:00:07Z' } },
  });
  const { view } = await mount(jest.fn().mockResolvedValue([update]));
  expect(view.getByTestId('lane-update-card-lane-update:l:s')).toBeTruthy();
  expect(view.getByText('LANE UNBLOCKED')).toBeTruthy();
});

test('Load earlier pages with the oldest seq as the cursor and de-duplicates rows', async () => {
  const page1 = Array.from({ length: 60 }, (_, index) => event(100 + index, 'ASSIST', `row ${100 + index}`));
  const page2 = [event(99, 'ASSIST', 'row 99'), event(100, 'ASSIST', 'row 100')];
  const readHistory = jest.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
  const { view } = await mount(readHistory);
  await act(async () => { fireEvent.press(view.getByTestId('lane-history-earlier')); });
  expect(readHistory).toHaveBeenLastCalledWith(target.streamId, target.generation,
    expect.objectContaining({ beforeDaemonSeq: 100 }));
  expect(view.getAllByTestId(/^lane-history-row-/)).toHaveLength(61);
  expect(view.queryByTestId('lane-history-earlier')).toBeNull();
});

test('a short first page has no Load earlier control', async () => {
  const { view } = await mount(jest.fn().mockResolvedValue([event(1, 'USER', 'only')]));
  expect(view.queryByTestId('lane-history-earlier')).toBeNull();
});

test('daemon refusal shows an honest unavailable state with retry, never a fallback chat', async () => {
  const readHistory = jest.fn().mockRejectedValueOnce(new Error('unknown_session')).mockResolvedValueOnce([event(1, 'USER', 'back')]);
  const { view } = await mount(readHistory);
  expect(view.getByText('Chat history unavailable')).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByLabelText('Retry history')); });
  expect(view.getByText('back')).toBeTruthy();
});

test('empty retained history is stated, and close is wired', async () => {
  const { view, onClose } = await mount(jest.fn().mockResolvedValue([]));
  expect(view.getByText('No retained messages')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Close history'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('reconnect reloads the newest page', async () => {
  const readHistory = jest.fn().mockResolvedValue([event(1, 'USER', 'x')]);
  const { view } = await mount(readHistory, { connected: false });
  expect(readHistory).not.toHaveBeenCalled();
  expect(view.queryByText('No retained messages')).toBeNull();
  expect(view.getByText('Waiting for connection…')).toBeTruthy();
  view.rerender(<LaneHistoryScreen target={target} connected readHistory={readHistory} onClose={jest.fn()} top={0} bottom={0} />);
  await act(async () => {});
  expect(readHistory).toHaveBeenCalledTimes(1);
});

// Sweep matrix (QA r1): every state field (rows, loading, error, more, loaded, cursor) must reset
// on disconnect and on target change, whatever state the screen was in.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const connectedTree = (readHistory: jest.Mock, connected: boolean, t = target) => (
  <LaneHistoryScreen target={t} connected={connected} readHistory={readHistory} onClose={jest.fn()} top={0} bottom={0} />
);

test('disconnect mid-load clears the spinner and shows Waiting for connection', async () => {
  const pending = deferred<PentacleEvent[]>();
  const readHistory = jest.fn().mockReturnValue(pending.promise);
  const { view } = await mount(readHistory);
  expect(view.getByTestId('lane-history-loading')).toBeTruthy();
  view.rerender(connectedTree(readHistory, false));
  await act(async () => {});
  expect(view.queryByTestId('lane-history-loading')).toBeNull();
  expect(view.getByText('Waiting for connection…')).toBeTruthy();
  await act(async () => { pending.resolve([event(1, 'USER', 'late')]); });
  expect(view.queryByText('late')).toBeNull();
  expect(view.getByText('Waiting for connection…')).toBeTruthy();
});

test('disconnect after an error clears the unavailable/retry notice', async () => {
  const readHistory = jest.fn().mockRejectedValue(new Error('unknown_session'));
  const { view } = await mount(readHistory);
  expect(view.getByText('Chat history unavailable')).toBeTruthy();
  view.rerender(connectedTree(readHistory, false));
  await act(async () => {});
  expect(view.queryByText('Chat history unavailable')).toBeNull();
  expect(view.queryByLabelText('Retry history')).toBeNull();
  expect(view.getByText('Waiting for connection…')).toBeTruthy();
});

test('disconnect with rows and Load earlier shown clears both', async () => {
  const page = Array.from({ length: 60 }, (_, index) => event(100 + index, 'ASSIST', `row ${100 + index}`));
  const readHistory = jest.fn().mockResolvedValue(page);
  const { view } = await mount(readHistory);
  expect(view.getByTestId('lane-history-earlier')).toBeTruthy();
  view.rerender(connectedTree(readHistory, false));
  await act(async () => {});
  expect(view.queryAllByTestId(/^lane-history-row-/)).toHaveLength(0);
  expect(view.queryByTestId('lane-history-earlier')).toBeNull();
  expect(view.getByText('Waiting for connection…')).toBeTruthy();
});

test('disconnect during Load earlier drops the stale page and a reconnect starts from the newest page', async () => {
  const page = Array.from({ length: 60 }, (_, index) => event(100 + index, 'ASSIST', `row ${100 + index}`));
  const earlier = deferred<PentacleEvent[]>();
  const readHistory = jest.fn().mockResolvedValueOnce(page).mockReturnValueOnce(earlier.promise).mockResolvedValue([event(500, 'USER', 'fresh')]);
  const { view } = await mount(readHistory);
  await act(async () => { fireEvent.press(view.getByTestId('lane-history-earlier')); });
  view.rerender(connectedTree(readHistory, false));
  await act(async () => { earlier.resolve([event(1, 'ASSIST', 'stale earlier')]); });
  expect(view.queryByText('stale earlier')).toBeNull();
  expect(view.queryByTestId('lane-history-loading')).toBeNull();
  view.rerender(connectedTree(readHistory, true));
  await act(async () => {});
  expect(readHistory).toHaveBeenLastCalledWith(target.streamId, target.generation, expect.not.objectContaining({ beforeDaemonSeq: expect.anything() }));
  expect(view.getByText('fresh')).toBeTruthy();
  expect(view.queryByText('row 100')).toBeNull();
});

test('changing target mid-load shows only the new target, with no stale spinner, rows or error', async () => {
  const first = deferred<PentacleEvent[]>();
  const readHistory = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue([event(9, 'USER', 'second target')]);
  const { view } = await mount(readHistory);
  view.rerender(connectedTree(readHistory, true, { streamId: 'other:stream', generation: 'gen-2', title: 'Other lane' }));
  await act(async () => {});
  await act(async () => { first.resolve([event(1, 'USER', 'first target')]); });
  expect(view.getByText('second target')).toBeTruthy();
  expect(view.queryByText('first target')).toBeNull();
  expect(view.getByText('Other lane')).toBeTruthy();
});

test('changing target after an error shows no stale error for the new target while it loads', async () => {
  const slow = deferred<PentacleEvent[]>();
  const readHistory = jest.fn().mockRejectedValueOnce(new Error('unknown_session')).mockReturnValueOnce(slow.promise);
  const { view } = await mount(readHistory);
  expect(view.getByText('Chat history unavailable')).toBeTruthy();
  view.rerender(connectedTree(readHistory, true, { streamId: 'other:stream', generation: 'gen-2', title: 'Other lane' }));
  await act(async () => {});
  expect(view.queryByText('Chat history unavailable')).toBeNull();
  expect(view.getByTestId('lane-history-loading')).toBeTruthy();
});

// QA r2 (advisor ruling 6bcd63e1): stale-failure and unmount races. Each case first proves the
// read is genuinely pending (called, spinner visible, promise unsettled) so it cannot pass vacuously.
describe('pending reads settled after the screen moved on', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());

  test('unmount mid-load, then late success or late rejection, writes nothing and raises no error', async () => {
    for (const settle of ['resolve', 'reject'] as const) {
      const pending = deferred<PentacleEvent[]>();
      const readHistory = jest.fn().mockReturnValue(pending.promise);
      const { view } = await mount(readHistory);
      expect(readHistory).toHaveBeenCalledTimes(1);
      expect(view.getByTestId('lane-history-loading')).toBeTruthy();
      view.unmount();
      await act(async () => {
        if (settle === 'resolve') pending.resolve([event(1, 'USER', 'late')]); else pending.reject(new Error('late failure'));
      });
      expect(errorSpy).not.toHaveBeenCalled();
    }
  });

  test('a late rejection after disconnect shows neither an error notice nor a spinner', async () => {
    const pending = deferred<PentacleEvent[]>();
    const readHistory = jest.fn().mockReturnValue(pending.promise);
    const { view } = await mount(readHistory);
    expect(view.getByTestId('lane-history-loading')).toBeTruthy();
    view.rerender(connectedTree(readHistory, false));
    await act(async () => {});
    await act(async () => { pending.reject(new Error('late failure')); });
    expect(view.queryByText('Chat history unavailable')).toBeNull();
    expect(view.queryByLabelText('Retry history')).toBeNull();
    expect(view.queryByTestId('lane-history-loading')).toBeNull();
    expect(view.getByText('Waiting for connection…')).toBeTruthy();
  });

  test('a late rejection from the previous target never shows an error on the new target', async () => {
    const first = deferred<PentacleEvent[]>();
    const second = deferred<PentacleEvent[]>();
    const readHistory = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { view } = await mount(readHistory);
    expect(view.getByTestId('lane-history-loading')).toBeTruthy();
    view.rerender(connectedTree(readHistory, true, { streamId: 'other:stream', generation: 'gen-2', title: 'Other lane' }));
    await act(async () => {});
    expect(readHistory).toHaveBeenCalledTimes(2);
    await act(async () => { first.reject(new Error('late failure')); });
    expect(view.queryByText('Chat history unavailable')).toBeNull();
    expect(view.getByTestId('lane-history-loading')).toBeTruthy();
    await act(async () => { second.resolve([event(9, 'USER', 'second target')]); });
    expect(view.getByText('second target')).toBeTruthy();
    expect(view.queryByTestId('lane-history-loading')).toBeNull();
  });

  test('a late rejection of a stale Load earlier after reconnect leaves the fresh newest page intact', async () => {
    const page = Array.from({ length: 60 }, (_, index) => event(100 + index, 'ASSIST', `row ${100 + index}`));
    const earlier = deferred<PentacleEvent[]>();
    const readHistory = jest.fn().mockResolvedValueOnce(page).mockReturnValueOnce(earlier.promise)
      .mockResolvedValue([event(500, 'USER', 'fresh')]);
    const { view } = await mount(readHistory);
    await act(async () => { fireEvent.press(view.getByTestId('lane-history-earlier')); });
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(view.getByTestId('lane-history-loading')).toBeTruthy();
    view.rerender(connectedTree(readHistory, false));
    view.rerender(connectedTree(readHistory, true));
    await act(async () => {});
    await act(async () => { earlier.reject(new Error('late failure')); });
    expect(view.getByText('fresh')).toBeTruthy();
    expect(view.queryByText('Chat history unavailable')).toBeNull();
    expect(view.queryByTestId('lane-history-loading')).toBeNull();
  });
});
