import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type PentacleStreamState } from 'pentacle-chat-core';
import LanesRoute from '../../../app/pentacle/lanes';
import { resetChatOpenNavigationIntents } from '../../../src/services/chatOpenNavigationIntent';
import { requestLaneHistory } from '../../../src/services/pentacleStream';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));
let mockState: PentacleStreamState;

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamSelectorWhen: jest.fn((_enabled, selector) => selector(mockState)),
  LANE_HISTORY_PAGE_LIMIT: 60,
  requestLaneHistory: jest.fn(),
}));

const router = () => require('expo-router').useRouter();

beforeEach(() => {
  resetChatOpenNavigationIntents();
  jest.clearAllMocks();
  mockState = applyWorkLanesInventory({ ...initialPentacleStreamState, connected: true, hasHydrated: true }, fixture.inventory_frame);
  (requestLaneHistory as jest.Mock).mockResolvedValue([]);
});

test('renders the daemon lanes in order with the open count', () => {
  render(<LanesRoute />);
  expect(screen.getByText('Open lanes · 4')).toBeTruthy();
  expect(screen.getAllByTestId(/^lane-row-/).map((row) => row.props.testID))
    .toEqual(fixture.expected.order.map((id: string) => `lane-row-${id}`));
});

test('an open session lane navigates to that session', () => {
  render(<LanesRoute />);
  fireEvent.press(screen.getByTestId('lane-row-wl-blocked-0001'));
  expect(router().push).toHaveBeenCalledWith('/pentacle/session/amaterasu%3Av2-lead0001');
});

test("a lane whose visible chat is the assistant composite returns to the assistant thread, not a session route", () => {
  render(<LanesRoute />);
  fireEvent.press(screen.getByTestId('lane-row-wl-active-0002'));
  expect(router().replace).toHaveBeenCalledWith('/(tabs)/bart');
  expect(router().push).not.toHaveBeenCalled();
});

test('a closed chat opens the read-only history for its exact generation, never a session route', async () => {
  render(<LanesRoute />);
  await act(async () => { fireEvent.press(screen.getByTestId('lane-row-wl-paused-0003')); });
  expect(screen.getByTestId('lane-history-screen')).toBeTruthy();
  expect(requestLaneHistory).toHaveBeenCalledWith('amaterasu:v2-lead0003', 'gen-lead-0003', expect.any(Object));
  expect(router().push).not.toHaveBeenCalled();
  expect(router().replace).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Close history'));
  expect(screen.queryByTestId('lane-history-screen')).toBeNull();
});

test('an unavailable chat navigates nowhere and keeps the lane visible', () => {
  render(<LanesRoute />);
  expect(screen.getByTestId('lane-unavailable-wl-paused-0004')).toBeTruthy();
  fireEvent.press(screen.getByTestId('lane-row-wl-paused-0004'));
  expect(router().push).not.toHaveBeenCalled();
  expect(router().replace).not.toHaveBeenCalled();
  expect(screen.getByTestId('lane-row-wl-paused-0004')).toBeTruthy();
});

test('close returns to the previous screen', () => {
  render(<LanesRoute />);
  fireEvent.press(screen.getByLabelText('Close lanes'));
  expect(router().back).toHaveBeenCalledTimes(1);
});

test('with no lane inventory the route says so instead of inventing lanes from sessions', () => {
  mockState = { ...initialPentacleStreamState, connected: true, hasHydrated: true,
    sessions: [{ stream_id: 'hostc:codex:one', host: 'hostc', provider: 'codex', session_name: 'one', last_event_at: '',
      last_text: '', last_kind: '', draft: '', pending: false, working: true, online: true }] };
  render(<LanesRoute />);
  expect(screen.getByText('No open lanes')).toBeTruthy();
  expect(screen.getByText('Open lanes · 0')).toBeTruthy();
});
