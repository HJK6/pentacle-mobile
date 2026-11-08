jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
import React from "react";
import { render, fireEvent, within, act } from "@testing-library/react-native";
import { AccessibilityInfo, Animated } from "react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
} from "pentacle-chat-core";
import LanesOverlay from "../../../src/components/lanes/LanesOverlay";
import MachineSigil from "../../../src/components/MachineSigil";
import { selectLaneCardViewModels } from "../../../src/services/workLanes";
import { lanesFlowFixture } from "../../../src/harness/lanesFlowFixture";
import { innerRingPoints } from "../../../src/components/lanes/lanesRingLayout";
import { StructuredMemberContent } from "../../../src/components/lanes/LaneMemberDetail";
import { Bang, p, SpecGlyph } from "../../../src/components/lanes/LaneAtoms";
const fixture = require("../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json");
const state = applyWorkLanesInventory(
  initialPentacleStreamState,
  fixture.inventory_frame,
);
const models = selectLaneCardViewModels(state);
beforeEach(() => {
  jest.useFakeTimers();
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
});
function surface(flow = false, sparse = false) {
  const f = lanesFlowFixture(Date.now(), sparse);
  const s = flow
    ? applyWorkLanesInventory(initialPentacleStreamState, f.inventory)
    : state;
  const onChat = jest.fn(),
    onClose = jest.fn(),
    readShow = jest.fn(async (id: string) => f.shows[id]);
  const props = {
    lanes: selectLaneCardViewModels(s),
    inventory: s.workLanes,
    assistantName: "Sample guide",
    connected: true,
    updates: [],
    top: 0,
    bottom: 0,
    onChat,
    onClose,
    readShow,
  };
  const view = render(<LanesOverlay {...props} />);
  return Object.assign(view, { f, readShow, onChat, onClose, props });
}
test("AC1 map is the only overview, with no list/map toggle", async () => {
  const view = surface();
  await act(async () => {});
  expect(view.queryByTestId("lanes-view-toggle")).toBeNull();
  expect(view.getByTestId("lanes-map")).toBeTruthy();
});
test("AC4 lane nodes contain no MachineSigil (non-vacuous baseline control)", async () => {
  const view = surface();
  await act(async () => {});
  const toggle = view.queryByTestId("lanes-view-map");
  if (toggle) fireEvent.press(toggle);
  const nodes = view.getAllByTestId(/^lanes-map-lane-/);
  expect(nodes.length).toBeGreaterThan(0);
  expect(
    nodes.flatMap((node) => within(node).UNSAFE_queryAllByType(MachineSigil)),
  ).toHaveLength(0);
});
test("AC1/4/5 grouped sheet mounts at 40%, rows carry goal parts and icons without expand controls", async () => {
  const view = surface(true);
  await act(async () => {});
  expect(view.getByTestId("lanes-sheet").props.accessibilityValue.text).toBe(
    "40%",
  );
  expect(
    view.getAllByTestId(/^lanes-group-/).map((n) => n.props.testID),
  ).toEqual([
    "lanes-group-needsYou",
    "lanes-group-working",
    "lanes-group-paused",
  ]);
  expect(view.getAllByTestId(/^lanes-map-label-/)).toHaveLength(6);
  expect(view.queryAllByTestId(/^lane-card-toggle-/)).toHaveLength(0);
  const rows = view.getAllByTestId(/^lane-row-/);
  expect(rows).toHaveLength(9);
  expect(
    rows.flatMap((row) => within(row).UNSAFE_queryAllByType(MachineSigil)),
  ).toHaveLength(0);
  expect(
    within(rows[0]).getAllByTestId(/^lane-goal-part-/).length,
  ).toBeGreaterThan(0);
  expect(view.readShow).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId("lanes-sheet-handle"));
  expect(view.getByTestId("lanes-sheet").props.accessibilityValue.text).toBe(
    "full",
  );
  expect(view.getByTestId("lanes-header-mini-ring")).toBeTruthy();
});
test("AC3 recent paused lanes have no map label; dormant node and row unfold the four rows", async () => {
  const view = surface(true);
  await act(async () => {});
  expect(view.getByTestId("lanes-map-lane-sample-lane-7")).toBeTruthy();
  expect(view.queryByTestId("lanes-map-label-sample-lane-7")).toBeNull();
  expect(view.getByTestId("lanes-map-fold-dormant")).toHaveTextContent("+4");
  expect(view.queryByTestId("lane-row-sample-lane-10")).toBeNull();
  fireEvent.press(view.getByTestId("lanes-dormant-fold"));
  expect(view.getAllByTestId(/^lane-row-/)).toHaveLength(13);
  fireEvent.press(view.getByTestId("lanes-dormant-fold"));
  expect(view.getAllByTestId(/^lane-row-/)).toHaveLength(9);
});
test("AC5/6/7 zoom fetches all 27 specs, done folds, spec select rotates and back restores overview snap and offset", async () => {
  const view = surface(true);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lanes-sheet-handle"));
  fireEvent.scroll(view.getByTestId("lanes-sheet-scroll"), {
    nativeEvent: { contentOffset: { y: 172 } },
  });
  fireEvent.press(view.getByTestId("lane-row-" + view.f.zoomLaneId));
  await act(async () => {});
  expect(view.readShow).toHaveBeenCalledWith(view.f.zoomLaneId, { members_limit: 32 });
  expect(view.getByTestId("lane-zoom-" + view.f.zoomLaneId)).toBeTruthy();
  expect(
    view.getByTestId("lane-zoom-centre-" + view.f.zoomLaneId),
  ).toBeTruthy();
  expect(view.getByTestId("lanes-map-counts")).toHaveTextContent(
    "6 IN PROGRESS   2 READY   7 BACKLOG   ✓ 12",
  );
  expect(
    view.queryByTestId("spec-row-" + view.f.members[15].spec_id),
  ).toBeNull();
  fireEvent.press(view.getByTestId("spec-done-fold"));
  expect(
    view.getByTestId("spec-row-" + view.f.members[26].spec_id),
  ).toHaveTextContent(/DEPRECATED/);
  const selected = view.f.members[3];
  fireEvent.press(view.getByTestId("spec-node-" + selected.spec_id));
  expect(view.getByTestId("member-detail-" + selected.spec_id)).toBeTruthy();
  expect(view.queryByText("Spec", { exact: true })).toBeNull();
  // Geometry is the actual production layout function, shared with rendered nodes.
  const nodes = view
    .getAllByTestId(/^spec-node-/)
    .filter((n) =>
      ["1", "2", "3", "4", "5", "6"].some(
        (i) => n.props.testID === "spec-node-spec_sample__flow_" + i,
      ),
    );
  const activeIndex = nodes.findIndex(
    (n) => n.props.testID === "spec-node-" + selected.spec_id,
  );
  const points = innerRingPoints(6, 390, 380, activeIndex);
  expect(points[activeIndex].y).toBeLessThan(
    Math.min(...points.filter((_, i) => i !== activeIndex).map((p) => p.y)),
  );
  fireEvent.press(view.getByLabelText("Back"));
  expect(view.queryByTestId("member-detail-" + selected.spec_id)).toBeNull();
  expect(
    view.getByTestId("spec-row-" + view.f.members[26].spec_id),
  ).toBeTruthy();
  fireEvent.press(view.getByLabelText("Back"));
  expect(view.getByTestId("lanes-map")).toBeTruthy();
  expect(view.getByTestId("lanes-sheet").props.accessibilityValue.text).toBe(
    "full",
  );
  expect(view.getByTestId("lanes-sheet-scroll").props.contentOffset).toEqual({
    x: 0,
    y: 172,
  });
  expect(view.queryByTestId(/^lane-zoom-/)).toBeNull();
});
test.each([false, true])(
  "AC7 optional detail fields %s sparse; criteria open first and done last",
  async (sparse) => {
    const f = lanesFlowFixture(Date.now(), sparse);
    const view = render(<StructuredMemberContent member={f.detailMember} />);
    for (const id of [
      "member-worked",
      "member-lead",
      "member-criteria",
      "member-lifecycle",
      "member-since",
      "member-open-questions",
    ]) {
      expect(!!view.queryByTestId(id)).toBe(!sparse);
    }
    expect(view.getByTestId("member-acceptance")).toBeTruthy();
    expect(view.getByTestId("member-estimate")).toBeTruthy();
    if (!sparse)
      expect(view.getByTestId("member-criterion-0")).toHaveTextContent(
        /Navigate back without losing position/,
      );
    else
      expect(view.getByTestId("member-status")).toHaveTextContent(
        /The screen is ready\./,
      );
  },
);
test("AC8 explicit null is blank even with unsafe raw prose present", () => {
  const f = lanesFlowFixture();
  const view = render(
    <StructuredMemberContent
      member={{
        ...f.detailMember,
        status_line: null,
        next_line: null,
        status_text: "Ready.",
        next_action_text: "Do the next step.",
      }}
    />,
  );
  expect(view.queryByTestId("member-status")).toBeNull();
  expect(view.queryByTestId("member-next")).toBeNull();
});
test("AC9 one loop runs for working nodes, stops on blur and never starts under reduce motion", async () => {
  const start = jest.fn(),
    stop = jest.fn();
  const loop = jest
    .spyOn(Animated, "loop")
    .mockReturnValue({ start, stop, reset: jest.fn() } as any);
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(false);
  const view = surface(true);
  await act(async () => {});
  expect(loop).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(view.getAllByTestId(/^working-pulse-/)).toHaveLength(3);
  view.rerender(<LanesOverlay {...view.props} active={false} />);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(view.queryAllByTestId(/^working-pulse-/)).toHaveLength(0);
  view.unmount();
  loop.mockClear();
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
  const reduced = surface(true);
  await act(async () => {});
  expect(loop).not.toHaveBeenCalled();
  expect(reduced.queryAllByTestId(/^working-pulse-/)).toHaveLength(0);
});
test("AC9 working overflow lanes retain an inward spoke and pulse", async () => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(false);
  jest
    .spyOn(Animated, "loop")
    .mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as any);
  const f = lanesFlowFixture();
  f.inventory.lanes = Array.from({ length: 7 }, (_, i) => ({
    ...f.inventory.lanes[3],
    lane_id: "overflow-working-" + i,
    title: "Working lane " + i,
  }));
  const s = applyWorkLanesInventory(initialPentacleStreamState, f.inventory);
  const view = render(
    <LanesOverlay
      lanes={selectLaneCardViewModels(s)}
      inventory={s.workLanes}
      assistantName="Sample guide"
      connected
      updates={[]}
      top={0}
      bottom={0}
      onChat={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  await act(async () => {});
  expect(view.getAllByTestId(/^working-spoke-/)).toHaveLength(7);
  expect(view.getAllByTestId(/^working-pulse-/)).toHaveLength(7);
});

test.each([
  [true, true],
  [true, false],
  [false, false],
  [false, true],
])("AC9 zoom/header/detail share the motion policy: reduced=%s live=%s", async (reduced, live) => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(reduced);
  const running = new Set<object>();
  jest.spyOn(Animated, "loop").mockImplementation(() => {
    const animation = {
      start: jest.fn(() => { running.add(animation); }),
      stop: jest.fn(() => { running.delete(animation); }),
      reset: jest.fn(),
    };
    return animation as any;
  });
  const view = surface(true);
  if (!live) {
    view.f.shows[view.f.zoomLaneId].members.forEach((member) => {
      member.seats = [];
      member.seats_total = 0;
    });
  }
  await act(async () => {});
  fireEvent.press(view.getByTestId("lane-row-" + view.f.zoomLaneId));
  await act(async () => {});
  expect(running.size).toBe(!reduced && live ? 1 : 0);
  fireEvent.press(view.getByTestId("spec-node-" + view.f.members[0].spec_id));
  expect(view.getByTestId("member-detail-" + view.f.members[0].spec_id)).toBeTruthy();
  expect(running.size).toBe(!reduced && live ? 1 : 0);
  view.rerender(<LanesOverlay {...view.props} active={false} />);
  await act(async () => {});
  expect(running.size).toBe(0);
  view.unmount();
  expect(running.size).toBe(0);
});

test("blocked specs use the amber exclamation glyph", () => {
  const f = lanesFlowFixture();
  const view = render(<SpecGlyph member={{ ...f.members[0], status: "blocked" }} />);
  expect(view.UNSAFE_getByType(Bang).props.color).toBe(p.amber);
});

test("AC7 projection-only refresh before first selection retains show-only detail, and later show removal wins", async () => {
  const view = surface(true);
  await act(async () => {});
  fireEvent.press(view.getByTestId("lane-row-" + view.f.zoomLaneId));
  await act(async () => {});
  const member = view.f.members[0];
  const lanes = view.props.lanes.map((model) => model.lane.lane_id !== view.f.zoomLaneId ? model : {
    ...model,
    members: model.members.map((inline) => inline.spec_id !== member.spec_id ? inline : {
      ...inline,
      worked: { ...inline.worked!, elapsed_h: 9.5 },
      lead_seat: { ...inline.lead_seat!, active_step: "Updated projection step" },
    }),
  });
  view.rerender(<LanesOverlay {...view.props} lanes={lanes} />);
  await act(async () => {});
  expect(view.readShow).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByTestId("spec-node-" + member.spec_id));
  expect(view.getByTestId("member-criteria")).toHaveTextContent(/Navigate back without losing position/);
  expect(view.getByTestId("member-lifecycle")).toBeTruthy();
  expect(view.getByTestId("member-lead")).toHaveTextContent(/Updated projection step/);
  const full = view.f.shows[view.f.zoomLaneId];
  const removed = { ...full, members: full.members.map(({ criteria, transitions, ...row }) => row) };
  view.readShow.mockResolvedValue(removed);
  const revised = lanes.map((model) => model.lane.lane_id === view.f.zoomLaneId
    ? { ...model, lane: { ...model.lane, version: (model.lane.version ?? 0) + 1 } }
    : model);
  view.rerender(<LanesOverlay {...view.props} lanes={revised} />);
  await act(async () => {});
  expect(view.readShow).toHaveBeenCalledTimes(2);
  // An authoritative show can remove fields even while the detail stays open.
  expect(view.queryByTestId("member-criteria")).toBeNull();
  expect(view.queryByTestId("member-lifecycle")).toBeNull();
  fireEvent.press(view.getByLabelText("Back"));
  fireEvent.press(view.getByTestId("spec-node-" + member.spec_id));
  expect(view.queryByTestId("member-criteria")).toBeNull();
  expect(view.queryByTestId("member-lifecycle")).toBeNull();
});
