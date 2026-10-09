jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
import React from "react";
import { Text, View } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import {
  initialPentacleStreamState,
  applyWorkLanesInventory,
} from "pentacle-chat-core";
import { readFileSync } from "fs";
import { join } from "path";
import LanesOverlay from "../../../src/components/lanes/LanesOverlay";
import { selectLaneCardViewModels } from "../../../src/services/workLanes";
import { parseWorkLaneShow } from "pentacle-chat-core";
import LaneLog from "../../../src/components/lanes/LaneLog";
import LaneMembers from "../../../src/components/lanes/LaneMembers";
import LaneHistoryScreen from "../../../src/components/lanes/LaneHistoryScreen";
import LanesSurface from "../../../src/components/lanes/LanesSurface";
import { selectLaneViewModels } from "../../../src/services/workLanes";
const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json",
    ),
    "utf8",
  ),
);
test("pending text is exposed exactly once by a leaf View with a current label", () => {
  const state = applyWorkLanesInventory(
    initialPentacleStreamState,
    fixture.inventory_frame,
  );
  const models = selectLaneCardViewModels(state);
  const view = render(
    <LanesOverlay
      lanes={models}
      inventory={state.workLanes}
      assistantName="Sample guide"
      connected
      updates={[]}
      top={0}
      bottom={0}
      onChat={() => {}}
      onClose={() => {}}
    />,
  );
  const id = `lane-card-members-pending-${models[0].lane.lane_id}`;
  const leaf = view.getByTestId(id);
  expect(leaf.type).toBe("View");
  expect(leaf.props).toMatchObject({
    accessible: true,
    collapsable: false,
    accessibilityRole: "text",
    accessibilityLabel: "Specs arrive when the daemon updates",
  });
  expect(view.getAllByTestId(id)).toHaveLength(1);
  const text = leaf.find((node) => String(node.type) === "Text");
  expect(text.props.testID).toBeUndefined();
  expect(text.props.accessible).toBe(false);
});
function assertLeaf(
  view: ReturnType<typeof render>,
  id: string,
  text: string,
  role = "text",
) {
  const leaf = view.getByTestId(id);
  expect(String(leaf.type)).toBe("View");
  expect(leaf.props).toMatchObject({
    accessible: true,
    collapsable: false,
    accessibilityRole: role,
    accessibilityLabel: text,
  });
  expect(view.getAllByTestId(id)).toHaveLength(1);
  expect(leaf.props.onPress).toBeUndefined();
  expect(leaf.props.style).toBeUndefined();
  const child = leaf.children[0] as any;
  expect(child.props.accessible).toBe(false);
  expect(child.props.testID).toBeUndefined();
  if (role === "progressbar")
    expect(leaf.props.accessibilityState).toEqual({ busy: true });
  else expect(leaf).toHaveTextContent(text);
}
const frame = fixture.progress_v2.find(
  (e: any) => e.name === "active_progress",
).frame;
function model() {
  return selectLaneCardViewModels(
    applyWorkLanesInventory(initialPentacleStreamState, frame),
  )[0];
}
function show() {
  const m = model();
  return parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: m.lane.lane_id },
    projection: m.lane,
    members: m.members,
    updates: [],
    events: [],
  })!;
}
test.each(["updates", "spec-changes", "events"])(
  "empty %s log leaf has current visible label, no structural accessibility, and usable tabs",
  async (tab) => {
    const readShow = jest.fn().mockResolvedValue(show()),
      view = render(
        <LaneLog
          model={model()}
          connected
          readShow={readShow}
          onBack={() => {}}
        />,
      );
    await act(async () => {});
    fireEvent.press(view.getByTestId(`lane-log-tab-${tab}`));
    assertLeaf(
      view,
      "lane-log-empty",
      `No ${tab === "spec-changes" ? "spec changes" : tab}`,
    );
    expect(
      view.getByTestId(`lane-log-${model().lane.lane_id}`).props.accessible,
    ).not.toBe(true);
    expect(
      view.getByTestId(`lane-log-tab-${tab}`).props.accessibilityState.selected,
    ).toBe(true);
  },
);
test("log, member and history loading wrappers expose sole indicators and disappear with their requests", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((r) => (resolve = r));
  const log = render(
    <LaneLog
      model={model()}
      connected
      readShow={() => pending}
      onBack={() => {}}
    />,
  );
  assertLeaf(log, "lane-log-loading", "Loading lane log", "progressbar");
  await act(async () => resolve(show()));
  expect(log.queryByTestId("lane-log-loading")).toBeNull();
  log.unmount();
  let resolveMembers!: (value: any) => void;
  const membersPromise = new Promise<any>((r) => (resolveMembers = r));
  const m = { ...model(), membersTotal: 3 };
  const members = render(
    <LaneMembers
      model={m}
      connected
      readShow={() => membersPromise}
      onBack={() => {}}
      onOpenMember={() => {}}
    />,
  );
  assertLeaf(
    members,
    "lane-members-loading",
    "Loading lane members",
    "progressbar",
  );
  await act(async () =>
    resolveMembers({ ...show(), projection: { ...m.lane, members_total: 2 } }),
  );
  expect(members.queryByTestId("lane-members-loading")).toBeNull();
  members.unmount();
  let resolveHistory!: (value: any) => void;
  const historyPromise = new Promise<any>((r) => (resolveHistory = r));
  const history = render(
    <LaneHistoryScreen
      target={{
        streamId: "hosta:sample",
        generation: "sample",
        title: "Sample",
      }}
      connected
      readHistory={() => historyPromise}
      onClose={() => {}}
      top={0}
      bottom={0}
    />,
  );
  assertLeaf(
    history,
    "lane-history-loading",
    "Loading chat history",
    "progressbar",
  );
  await act(async () => resolveHistory([]));
  expect(history.queryByTestId("lane-history-loading")).toBeNull();
});
test("snapshot unknown/current labels update in place while header leaves stay inside their pressable", () => {
  const m = model(),
    inventory = {
      ...frame,
      work_index: { available: false, snapshot_at: null },
    },
    view = render(
      <LanesOverlay
        lanes={[m]}
        inventory={inventory}
        assistantName="Sample"
        connected
        updates={[]}
        top={0}
        bottom={0}
        onChat={() => {}}
        onClose={() => {}}
      />,
    );
  assertLeaf(view, "lanes-index-banner", "DATA AS OF unknown");
  view.rerender(
    <LanesOverlay
      lanes={[m]}
      inventory={{
        ...inventory,
        work_index: { available: false, snapshot_at: "9:41 AM" },
      }}
      assistantName="Sample"
      connected
      updates={[]}
      top={0}
      bottom={0}
      onChat={() => {}}
      onClose={() => {}}
    />,
  );
  assertLeaf(view, "lanes-index-banner", "DATA AS OF 9:41 AM");
  expect(
    view.getByTestId(`lane-card-${m.lane.lane_id}`).props.accessible,
  ).not.toBe(true);
  expect(
    view.getByTestId(`lane-card-progress-${m.lane.lane_id}`).props.accessible,
  ).not.toBe(true);
  expect(
    view.getByTestId(`lane-card-state-${m.lane.lane_id}`).props.accessible,
  ).not.toBe(true);
  fireEvent.press(view.getByTestId("lanes-view-map"));
  fireEvent.press(view.getByTestId(`lanes-map-lane-${m.lane.lane_id}`));
  assertLeaf(
    view,
    `lanes-map-progress-${m.lane.lane_id}`,
    m.progressLabel.replace(/^est\. open work /, ""),
  );
});
test("both source-only legacy leaves have sole native-shaped wrappers and rerender current counts", () => {
  const state = applyWorkLanesInventory(
      initialPentacleStreamState,
      fixture.inventory_frame,
    ),
    lanes = selectLaneViewModels(state, Date.now()),
    props = {
      lanes,
      counts: state.workLanes!.counts,
      truncated: false,
      now: Date.now(),
      top: 0,
      bottom: 0,
      onOpenLane: () => {},
      onOpenLead: () => {},
    },
    view = render(<LanesSurface {...props} />);
  assertLeaf(view, "lanes-count", "4 LANES · 1 BLOCKED");
  assertLeaf(view, "lane-unavailable-wl-paused-0004", "Chat unavailable");
  view.rerender(
    <LanesSurface {...props} counts={{ ...props.counts, open: 7 }} />,
  );
  assertLeaf(view, "lanes-count", "7 LANES · 1 BLOCKED");
});
test("last-update enrichment dedupes per update identity, retains four feed entries, and limits concurrent reads", async () => {
  const original = model(),
    base = show();
  let active = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  const read = jest.fn((id: string) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise<any>((resolve) =>
      releases.push(() => {
        active--;
        resolve({
          ...base,
          lane_id: id,
          updates: [{ update_id: `update-${id}`, summary: `Actual ${id}` }],
        });
      }),
    );
  });
  const models = Array.from({ length: 14 }, (_, i) => ({
    ...original,
    lane: {
      ...original.lane,
      lane_id: `cache-${i}`,
      last_update: {
        update_id: `update-cache-${i}`,
        kind: "milestone" as const,
        event_id: i,
        ts: "9:41 AM",
      },
    },
  }));
  const props = {
    lanes: models,
    inventory: null,
    assistantName: "Sample",
    connected: true,
    updates: [],
    top: 0,
    bottom: 0,
    onChat: () => {},
    onClose: () => {},
    readShow: read,
    listVariant: "current" as const,
  };
  const view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(4);
  while (releases.length) {
    const batch = releases.splice(0);
    await act(async () => batch.forEach((release) => release()));
  }
  expect(read).toHaveBeenCalledTimes(14);
  expect(peak).toBeLessThanOrEqual(4);
  expect(view.getByText("Actual cache-0")).toBeTruthy();
  view.rerender(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(14);
  view.rerender(
    <LanesOverlay
      {...props}
      lanes={[
        {
          ...models[0],
          lane: {
            ...models[0].lane,
            last_update: {
              ...models[0].lane.last_update!,
              update_id: "new-update",
            },
          },
        },
        ...models.slice(1),
      ]}
    />,
  );
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(15);
  await act(async () => releases.splice(0).forEach((r) => r()));
});
