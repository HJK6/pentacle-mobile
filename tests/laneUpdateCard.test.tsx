jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => ({ sessions: [], events: [] }),
  appendOptimisticUserMessage: jest.fn(),
  sendPentacleMessage: jest.fn(),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector({ sessions: [], events: [] }),
  usePentacleStreamActions: () => ({}),
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { initialPentacleStreamState, selectSessionDetail, type PentacleEvent } from 'pentacle-chat-core';
import { TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import LaneUpdateCard from '../src/components/lanes/LaneUpdateCard';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));
const events: PentacleEvent[] = fixture.lane_update_events.map((frame: { event: PentacleEvent }) => Object.assign(
  { host: 'hostc', session_id: 'bart:assistant', session_name: 'assistant' }, frame.event,
) as PentacleEvent);
const KIND_LABELS: Record<string, string> = {
  lane_started: 'LANE STARTED', lane_blocked: 'LANE BLOCKED', lane_unblocked: 'LANE UNBLOCKED',
  lane_completed: 'LANE COMPLETED', major_decision: 'DECISION', milestone: 'MILESTONE',
};

function bartDetail(extra: PentacleEvent[] = []) {
  const state = {
    ...initialPentacleStreamState, connected: true, hasHydrated: true,
    sessions: [{
      stream_id: 'bart:assistant', host: 'hostc', provider: 'composite', session_name: 'assistant',
      last_event_at: '2026-10-07T19:00:00.000Z', last_text: '', last_kind: 'ASSIST', draft: '',
      pending: false, working: false, online: true,
    }],
    events: [...events, ...extra],
  };
  return selectSessionDetail(state as any, 'bart:assistant');
}

test('the transcript model carries the typed lane update for each of the six kinds', () => {
  const detail = bartDetail();
  expect(detail).toBeTruthy();
  const withUpdate = detail!.transcriptItems.filter((item) => item.laneUpdate);
  expect(withUpdate.map((item) => item.laneUpdate!.kind).sort()).toEqual(Object.keys(KIND_LABELS).sort());
  for (const item of withUpdate) {
    expect(item.laneUpdate!.summary).toBe(item.text);
    expect(item.publishKind).toBe('lane_update');
  }
});

test('prose and status publications are not lane updates', () => {
  const prose = { ...events[0], daemon_seq: 5000, message_id: 'publication:p1', publish_kind: 'prose',
    text: 'Plain note', raw: { publish_kind: 'prose' } } as PentacleEvent;
  const detail = bartDetail([prose]);
  const row = detail!.transcriptItems.find((item) => item.text === 'Plain note');
  expect(row).toBeTruthy();
  expect(row!.laneUpdate).toBeUndefined();
});

test.each(Object.entries(KIND_LABELS))('TranscriptRow renders %s as a typed card with the summary', (kind, label) => {
  const item = bartDetail()!.transcriptItems.find((row) => row.laneUpdate?.kind === kind)!;
  const view = render(<TranscriptRow item={item} chrome={hostChrome('bart')} streamId="bart:assistant" />);
  const card = view.getByTestId(`lane-update-card-${item.laneUpdate!.update_id}`);
  expect(card).toBeTruthy();
  expect(view.getByText(label)).toBeTruthy();
  expect(view.getByText(item.laneUpdate!.summary)).toBeTruthy();
  expect(view.queryByTestId(`agent-message-row-${item.id}`)).toBeNull();
});

test('a card with a handler is a pressable button; without one it is not', () => {
  const update = bartDetail()!.transcriptItems.find((row) => row.laneUpdate)!.laneUpdate!;
  const onPress = jest.fn();
  const pressable = render(<LaneUpdateCard update={update} onPress={onPress} />);
  fireEvent.press(pressable.getByRole('button'));
  expect(onPress).toHaveBeenCalledTimes(1);
  pressable.unmount();
  expect(render(<LaneUpdateCard update={update} />).queryByRole('button')).toBeNull();
});

test('a repeated lane_update with the same message_id on a different daemon_seq renders once', () => {
  const original = events.find((event) => event.publish_kind === 'lane_update')!;
  const repeat = { ...original, daemon_seq: 9000 } as PentacleEvent;
  const detail = bartDetail([repeat]);
  const cards = detail!.transcriptItems.filter((item) => item.laneUpdate?.update_id === (original.raw as any).lane_update.update_id);
  expect(cards).toHaveLength(1);
  expect(detail!.transcriptItems.filter((item) => item.laneUpdate)).toHaveLength(6);
});
