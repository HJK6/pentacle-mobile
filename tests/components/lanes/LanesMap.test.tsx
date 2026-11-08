jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
import React, { useState } from "react";
import { AccessibilityInfo, Pressable, Text, View } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  type WorkLaneShow,
} from "pentacle-chat-core";
import LanesMap from "../../../src/components/lanes/LanesMap";
import { lanesFlowFixture } from "../../../src/harness/lanesFlowFixture";
import {
  selectLaneCardViewModels,
  laneRingOrder,
  type LaneCardViewModel,
} from "../../../src/services/workLanes";
import type { ReadWorkLaneShow } from "../../../src/components/lanes/useWorkLaneShow";
import { outerRingPoints } from "../../../src/components/lanes/lanesRingLayout";
beforeEach(() => {
  jest.useFakeTimers();
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());
const modelsFor = (f: ReturnType<typeof lanesFlowFixture>) =>
  selectLaneCardViewModels(
    applyWorkLanesInventory(initialPentacleStreamState, f.inventory),
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function surface(
  f = lanesFlowFixture(),
  readShow: ReadWorkLaneShow = async (id) => f.shows[id],
  initialFocus: string | null = null,
  connected = true,
) {
  const onChat = jest.fn(),
    onOpenMember = jest.fn(),
    onLog = jest.fn();
  function Driver({ models }: { models: LaneCardViewModel[] }) {
    const [focus, setFocus] = useState(initialFocus);
    const back = React.useRef<() => void>(() => {});
    return (
      <View>
        <Pressable testID="driver-back" onPress={() => back.current()}>
          <Text>Back</Text>
        </Pressable>
        <LanesMap
          lanes={models}
          focusedLaneId={focus}
          onFocusLane={setFocus}
          assistantName="Sample guide"
          assistantSigil="flower"
          connected={connected}
          readShow={readShow}
          onOpenMember={onOpenMember}
          onChat={onChat}
          onLog={onLog}
          onBackHandler={(handler) => {
            back.current = handler;
          }}
        />
      </View>
    );
  }
  const view = render(<Driver models={modelsFor(f)} />);
  return {
    view,
    onChat,
    onOpenMember,
    onLog,
    rerender: (models: LaneCardViewModel[]) =>
      view.rerender(<Driver models={models} />),
  };
}
test("first six labels follow attention order and overflow is reachable without general pagination", async () => {
  const f = lanesFlowFixture();
  f.inventory.lanes = Array.from({ length: 14 }, (_, i) => ({
    ...f.inventory.lanes[i % 6],
    lane_id: `many-${i}`,
    title: `Sample lane ${i}`,
    state: "active",
    members: [],
    last_update: null,
  }));
  const { view } = surface(f);
  await act(async () => {});
  expect(
    view.getAllByTestId(/^lanes-map-label-/).map((n) => n.props.testID),
  ).toEqual(
    laneRingOrder(f.inventory.lanes)
      .slice(0, 6)
      .map((l) => "lanes-map-label-" + l.lane_id),
  );
  expect(view.getAllByTestId(/^lanes-map-lane-/)).toHaveLength(14);
  expect(view.getAllByTestId(/^lane-row-/)).toHaveLength(14);
  expect(view.queryAllByTestId(/^lanes-map-page-/)).toHaveLength(0);
  expect(view.getByTestId("lanes-map-assistant").props.accessibilityLabel).toBe(
    "Sample guide",
  );
});
test("paused orbit stays clear of the bottom 90 degrees", () => {
  for (const count of [1, 2, 7, 20])
    for (const point of outerRingPoints(count, 375, 360)) {
      const angle = (point.angle + 2 * Math.PI) % (2 * Math.PI);
      expect(angle < Math.PI / 4 || angle > (Math.PI * 3) / 4).toBe(true);
    }
});
test("show errors are explicit and retry is bound to the same lane", async () => {
  const f = lanesFlowFixture(),
    read = jest
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(f.shows[f.zoomLaneId]);
  const { view } = surface(f, read, f.zoomLaneId);
  await act(async () => {});
  expect(view.getByTestId("lanes-map-members-error")).toHaveTextContent(
    "Lane details unavailable",
  );
  fireEvent.press(view.getByTestId("lanes-map-members-retry"));
  await act(async () => {});
  expect(read.mock.calls.map((c) => c[0])).toEqual([
    f.zoomLaneId,
    f.zoomLaneId,
  ]);
  expect(view.queryByTestId("lanes-map-members-error")).toBeNull();
  expect(view.getByTestId("lanes-map-counts")).toHaveTextContent(/✓ 12/);
});
test("a truncated show is a failure, and retry can return the full list", async () => {
  const f = lanesFlowFixture(),
    full = f.shows[f.zoomLaneId],
    read = jest
      .fn()
      .mockResolvedValueOnce({ ...full, members: full.members.slice(0, 8) })
      .mockResolvedValue(full);
  const { view } = surface(f, read, f.zoomLaneId);
  await act(async () => {});
  expect(view.getByTestId("lanes-map-members-error")).toHaveTextContent(
    "Incomplete member list. Please retry.",
  );
  fireEvent.press(view.getByTestId("lanes-map-members-retry"));
  await act(async () => {});
  expect(view.getByTestId("spec-done-fold")).toHaveTextContent("✓12");
  expect(view.queryByTestId("lanes-map-members-error")).toBeNull();
});
test("late show after back cannot repopulate or refocus the map", async () => {
  const f = lanesFlowFixture(),
    pending = deferred<WorkLaneShow>(),
    read = jest.fn(() => pending.promise);
  const { view } = surface(f, read);
  fireEvent.press(view.getByTestId("lane-row-" + f.zoomLaneId));
  fireEvent.press(view.getByTestId("driver-back"));
  await act(async () => pending.resolve(f.shows[f.zoomLaneId]));
  expect(view.getByTestId("lanes-map")).toBeTruthy();
  expect(view.queryByTestId("spec-done-fold")).toBeNull();
});
test("no-spec reason suppresses contradictory fetched members; unavailable chat has no navigation", async () => {
  const f = lanesFlowFixture(),
    lane = f.inventory.lanes[3];
  lane.no_spec_reason = "Exploratory conversation.";
  lane.visible_chat.available = "unavailable";
  const { view, onChat } = surface(f, async (id) => f.shows[id], f.zoomLaneId);
  await act(async () => {});
  expect(view.getByText("Exploratory conversation.")).toBeTruthy();
  expect(view.queryAllByTestId(/^spec-node-/)).toHaveLength(0);
  expect(view.getByText("Chat unavailable")).toBeTruthy();
  fireEvent.press(view.getByTestId("lane-zoom-open-chat"));
  expect(onChat).not.toHaveBeenCalled();
});
test("selected fetched spec beyond inline eight survives a refresh; authoritative removal deselects it", async () => {
  const f = lanesFlowFixture(),
    full = f.shows[f.zoomLaneId],
    pending = deferred<WorkLaneShow>();
  const read = jest
    .fn()
    .mockResolvedValueOnce(full)
    .mockImplementationOnce(() => pending.promise);
  const { view, rerender } = surface(f, read, f.zoomLaneId);
  await act(async () => {});
  fireEvent.press(view.getByTestId("spec-done-fold"));
  const member = f.members[26];
  fireEvent.press(view.getByTestId("spec-row-" + member.spec_id));
  expect(view.getByTestId("member-detail-" + member.spec_id)).toBeTruthy();
  const updated = modelsFor(f).map((m) =>
    m.lane.lane_id === f.zoomLaneId
      ? { ...m, lane: { ...m.lane, version: 2 } }
      : m,
  );
  rerender(updated);
  await act(async () => {});
  expect(view.getByTestId("member-detail-" + member.spec_id)).toBeTruthy();
  await act(async () =>
    pending.resolve({
      ...full,
      members: full.members.filter((m) => m.spec_id !== member.spec_id),
      projection: { ...full.projection!, members_total: 26 },
    }),
  );
  expect(view.queryByTestId("member-detail-" + member.spec_id)).toBeNull();
  expect(view.getByTestId("lane-acceptance")).toBeTruthy();
});
test("disappearing focused lane returns to overview without inventing a replacement", async () => {
  const f = lanesFlowFixture(),
    { view, rerender } = surface(f, async (id) => f.shows[id], f.zoomLaneId);
  await act(async () => {});
  rerender([]);
  await act(async () => {});
  expect(view.getByTestId("lanes-map")).toBeTruthy();
  expect(view.getByText("No open lanes")).toBeTruthy();
});
