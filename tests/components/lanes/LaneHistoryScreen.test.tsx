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
  view.rerender(<LaneHistoryScreen target={target} connected readHistory={readHistory} onClose={jest.fn()} top={0} bottom={0} />);
  await act(async () => {});
  expect(readHistory).toHaveBeenCalledTimes(1);
});
