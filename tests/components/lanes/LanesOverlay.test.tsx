jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  parseWorkLaneShow,
  type WorkLane,
} from "pentacle-chat-core";
import LanesOverlay from "../../../src/components/lanes/LanesOverlay";
import {
  selectLaneCardViewModels,
  type LaneUpdateEntry,
} from "../../../src/services/workLanes";
import { lanesFlowFixture } from "../../../src/harness/lanesFlowFixture";
const fixture = require("../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json");
const base = fixture.progress_v2.find(
  (c: { name: string }) => c.name === "active_progress",
).frame;
type Props = React.ComponentProps<typeof LanesOverlay>;
beforeEach(() => {
  jest.useFakeTimers();
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());
function propsFor(
  frame: unknown = base,
  overrides: Partial<Props> = {},
): Props {
  const state = applyWorkLanesInventory(initialPentacleStreamState, frame);
  return {
    lanes: selectLaneCardViewModels(state),
    inventory: state.workLanes,
    assistantName: "Sample guide",
    connected: true,
    updates: [],
    top: 0,
    bottom: 0,
    onChat: jest.fn(),
    onClose: jest.fn(),
    readShow: jest.fn(async (id: string) => {
      const lane = state.workLanes!.lanes.find((l) => l.lane_id === id)!;
      return parseWorkLaneShow({
        type: "work_lanes.show.ok",
        lane: { lane_id: id },
        projection: lane,
        members: lane.members ?? [],
        updates: [],
        events: [],
      })!;
    }),
    ...overrides,
  };
}
function publication(
  lane: WorkLane = base.lanes[0],
  id = lane.lane_id,
): LaneUpdateEntry {
  return {
    event: fixture.lane_update_events[0],
    update: {
      update_id: "sample-publication",
      lane_id: id,
      kind: "milestone",
      summary: "Published lane milestone",
      source: { type: "transition", id: "sample-publication" },
      state: "active",
      prior_state: null,
      owner_kind: "operator",
      title: lane.title,
      ts: "2026-01-02T00:00:00Z",
    },
  };
}
test("legacy inventory stays navigable with unknown progress and no invented completed specs", async () => {
  const props = propsFor(fixture.inventory_frame),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(view.getByText("4 LANES · 1 BLOCKED")).toBeTruthy();
  if (view.queryByTestId("lanes-dormant-fold"))
    fireEvent.press(view.getByTestId("lanes-dormant-fold"));
  expect(view.getAllByTestId(/^lane-row-/)).toHaveLength(4);
  expect(view.queryAllByTestId(/^lane-segment-/)).toHaveLength(0);
  expect(view.getAllByText("—/— specs")).toHaveLength(4);
  expect(view.queryByText("All specs done")).toBeNull();
  expect(props.readShow).not.toHaveBeenCalled();
});
test("global publication opens its lane log, back preserves the feed and closing it restores the map snap", async () => {
  const props = propsFor(base, { updates: [publication()] }),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lanes-sheet-handle"));
  fireEvent.press(view.getByTestId("lanes-all-updates"));
  fireEvent.press(
    within(view.getByTestId("lanes-update-log")).getByRole("button", {
      name: "Open lane log: Published lane milestone",
    }),
  );
  await act(async () => {});
  expect(view.getByTestId("lane-log-" + base.lanes[0].lane_id)).toBeTruthy();
  fireEvent.press(view.getByTestId("lane-log-back"));
  expect(
    within(view.getByTestId("lanes-update-log")).getByText(
      "Published lane milestone",
    ),
  ).toBeTruthy();
  fireEvent.press(view.getByLabelText("Close lanes"));
  expect(view.queryByTestId("lanes-update-log")).toBeNull();
  expect(view.getByTestId("lanes-sheet").props.accessibilityValue.text).toBe(
    "full",
  );
  expect(props.onClose).not.toHaveBeenCalled();
});
test("an absent publication lane reports unavailability without redirecting or fetching another lane", async () => {
  const props = propsFor(base, {
      updates: [publication(base.lanes[0], "missing-lane")],
    }),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lanes-all-updates"));
  fireEvent.press(
    view.getByRole("button", {
      name: "Open lane log: Published lane milestone",
    }),
  );
  expect(view.getByTestId("lanes-update-log-unavailable")).toHaveTextContent(
    /missing-lane is not in the current open lanes/,
  );
  expect(props.readShow).not.toHaveBeenCalled();
  expect(props.onChat).not.toHaveBeenCalled();
});
test("full sheet and dormant folds do not issue per-row enrichment requests; zoom alone reads show", async () => {
  const f = lanesFlowFixture(),
    readShow = jest.fn(async (id: string) => f.shows[id]);
  const props = propsFor(f.inventory, { readShow }),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lanes-sheet-handle"));
  fireEvent.press(view.getByTestId("lanes-dormant-fold"));
  expect(readShow).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId("lane-row-" + f.zoomLaneId));
  await act(async () => {});
  expect(readShow).toHaveBeenCalledTimes(1);
  expect(readShow).toHaveBeenCalledWith(f.zoomLaneId);
  fireEvent.press(view.getByTestId("lane-zoom-open-chat"));
  expect(props.onChat).toHaveBeenCalledWith(
    props.lanes.find((m) => m.lane.lane_id === f.zoomLaneId),
  );
});
test("work-index failure keeps its source timestamp visible and refreshes in place", async () => {
  const props = propsFor({
      ...base,
      work_index: { available: false, snapshot_at: null },
    }),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(view.getByTestId("lanes-index-banner").props.accessibilityLabel).toBe(
    "DATA AS OF unknown",
  );
  view.rerender(
    <LanesOverlay
      {...props}
      inventory={{
        ...props.inventory!,
        work_index: { available: false, snapshot_at: "2026-01-02" },
      }}
    />,
  );
  expect(view.getByTestId("lanes-index-banner").props.accessibilityLabel).toBe(
    "DATA AS OF 2026-01-02",
  );
});
test("fresh member work clears Recovering without reclassifying the daemon state", async () => {
  const lane = base.lanes[0],
    old = propsFor({
      ...base,
      lanes: [
        { ...lane, lead: null, state: "active", state_reason: "lead_lost" },
      ],
    });
  const view = render(<LanesOverlay {...old} />);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lane-row-" + lane.lane_id));
  await act(async () => {});
  expect(view.getAllByText(/ACTIVE · RECOVERING/).length).toBeGreaterThan(0);
  const fresh = propsFor(
    {
      ...base,
      lanes: [
        {
          ...lane,
          lead: null,
          state: "active",
          state_reason: "members_working",
        },
      ],
    },
    { readShow: old.readShow },
  );
  view.rerender(<LanesOverlay {...fresh} />);
  await act(async () => {});
  expect(view.queryByText(/RECOVERING/)).toBeNull();
  expect(view.getByText(/^ACTIVE ·/)).toBeTruthy();
});
test("header close exits the overlay from map and zoom; map back exits zoom first", async () => {
  const props = propsFor(),
    view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lane-row-" + props.lanes[0].lane.lane_id));
  await act(async () => {});
  fireEvent.press(view.getByLabelText("Back"));
  expect(view.getByTestId("lanes-map")).toBeTruthy();
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.press(view.getByLabelText("Close lanes"));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
