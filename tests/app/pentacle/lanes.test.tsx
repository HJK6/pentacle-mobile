import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  type PentacleStreamState,
} from "pentacle-chat-core";
import LanesRoute from "../../../app/pentacle/lanes";
import { resetChatOpenNavigationIntents } from "../../../src/services/chatOpenNavigationIntent";
import { requestWorkLaneShow } from "../../../src/services/pentacleStream";

const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json",
    ),
    "utf8",
  ),
);
let mockState: PentacleStreamState;

jest.mock("expo-router", () =>
  require("../../helpers/mocks/expoRouter").makeMock(),
);
jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("../../../src/components/questions/QuestionDeckCard", () => () => null);
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
jest.mock("../../../src/services/pentacleStream", () => ({
  usePentacleStreamSelectorWhen: jest.fn((_enabled, selector) =>
    selector(mockState),
  ),
  LANE_HISTORY_PAGE_LIMIT: 60,
  requestLaneHistory: jest.fn(),
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));

const router = () => require("expo-router").useRouter();

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  resetChatOpenNavigationIntents();
  jest.clearAllMocks();
  mockState = applyWorkLanesInventory(
    { ...initialPentacleStreamState, connected: true, hasHydrated: true },
    fixture.inventory_frame,
  );
  (requestWorkLaneShow as jest.Mock).mockImplementation(async (lane_id: string) => ({ lane_id, projection: null, members: [], updates: [], spec_changes: [], events: [] }));
});
afterEach(() => jest.restoreAllMocks());
test("renders each daemon lane in the grouped home list", async () => {
  render(<LanesRoute />);
  await act(async () => {});
  expect(screen.getAllByTestId(/^lane-row-wl-/).map(row => row.props.testID).sort())
    .toEqual(fixture.expected.order.map((id: string) => `lane-row-${id}`).sort());
});

test("opening a lane uses its detail and does not expose the retired chat action", async () => {
  render(<LanesRoute />);
  fireEvent.press(screen.getByTestId('lane-row-wl-blocked-0001'));
  await act(async () => {});
  expect(requestWorkLaneShow).toHaveBeenCalledWith('wl-blocked-0001', expect.any(Object));
  expect(screen.getByTestId('readable-lane')).toBeTruthy();
  expect(screen.queryByTestId('lane-zoom-open-chat')).toBeNull();
  expect(router().push).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Back'));
  expect(screen.getByTestId('lane-row-wl-blocked-0001')).toBeTruthy();
});

test("close returns to the previous screen", async () => {
  render(<LanesRoute />);
  await act(async () => {});
  fireEvent.press(screen.getByLabelText("Close lanes"));
  expect(router().back).toHaveBeenCalledTimes(1);
});

test("with no lane inventory the route says so instead of inventing lanes from sessions", async () => {
  mockState = {
    ...initialPentacleStreamState,
    connected: true,
    hasHydrated: true,
    sessions: [
      {
        stream_id: "hostc:codex:one",
        host: "hostc",
        provider: "codex",
        session_name: "one",
        last_event_at: "",
        last_text: "",
        last_kind: "",
        draft: "",
        pending: false,
        working: true,
        online: true,
      },
    ],
  };
  render(<LanesRoute />);
  await act(async () => {});
  expect(screen.getByText("No open lanes")).toBeTruthy();
  expect(screen.queryAllByTestId(/^lane-row-/)).toHaveLength(0);
});
