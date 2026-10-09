jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock("../../../src/components/lanes/lanesTelemetry", () => ({
  emitHarnessUiTrace: jest.fn(),
  traceMemberList: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";
import React, { useState } from "react";
import { StyleSheet } from "react-native";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  type WorkLaneMember,
  type WorkLaneShow,
} from "pentacle-chat-core";
import { Fonts, Tokens } from "../../../constants/Colors";
import {
  laneAttentionRank,
  groupMapMembers,
} from "../../../src/components/lanes/LanesMap";
import { memberTone } from "../../../src/components/lanes/LaneAtoms";
import LanesMap from "../../../src/components/lanes/LanesMap";
import LaneMembers from "../../../src/components/lanes/LaneMembers";
import LaneMemberDetail from "../../../src/components/lanes/LaneMemberDetail";
import { emitHarnessUiTrace } from "../../../src/components/lanes/lanesTelemetry";
import {
  selectLaneCardViewModels,
  type LaneCardViewModel,
} from "../../../src/services/workLanes";

const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json",
    ),
    "utf8",
  ),
);
const NOW = Date.parse("2026-01-02T00:05:00Z");
const progressCase = (name: string) =>
  fixture.progress_v2.find((entry: { name: string }) => entry.name === name);
const modelsFor = (frame: unknown) =>
  selectLaneCardViewModels(
    applyWorkLanesInventory(initialPentacleStreamState, frame),
    NOW,
  );
const modelFor = (name = "active_progress") =>
  modelsFor(progressCase(name).frame)[0];

function surface(
  lanes = [modelFor()],
  initialFocus: string | null = null,
  initialPage = 0,
  readShow?: (id: string) => Promise<WorkLaneShow>,
) {
  const onOpenMember = jest.fn();
  const onShowAll = jest.fn();
  const onLog = jest.fn();
  const onChat = jest.fn();
  function Driver({ models }: { models: LaneCardViewModel[] }) {
    const [focus, setFocus] = useState(initialFocus);
    const [page, setPage] = useState(initialPage);
    return (
      <LanesMap
        lanes={models}
        assistantName="Orbit Guide"
        assistantSigil="flower"
        focusedLaneId={focus}
        onFocusLane={setFocus}
        page={page}
        onPageChange={setPage}
        readShow={readShow}
        onOpenMember={onOpenMember}
        onShowAll={onShowAll}
        onLog={onLog}
        onChat={onChat}
      />
    );
  }
  const view = render(<Driver models={lanes} />);
  return {
    view,
    onOpenMember,
    onShowAll,
    onLog,
    onChat,
    rerender: (models: LaneCardViewModel[]) =>
      view.rerender(<Driver models={models} />),
  };
}

function overflowModels() {
  const source = progressCase("active_progress").frame;
  const members = Array.from({ length: 32 }, (_, index) => ({
    ...source.lanes[0].members[0],
    spec_id: `spec-derived-${index + 1}`,
    title: `Paper span ${index + 1}`,
  }));
  const frame = {
    ...source,
    counts: { open: 9, active: 9, paused: 0, blocked: 0 },
    lanes: Array.from({ length: 9 }, (_, index) => ({
      ...source.lanes[0],
      lane_id: `wl-derived-${index + 1}`,
      title: `Bridge collection ${index + 1}`,
      members: members.slice(0, 8),
      members_total: 32,
      items_total: 32,
      items_open: 16,
      items_completed: 16,
    })),
  };
  return { lanes: modelsFor(frame), members };
}

test("small map keeps projection order and supplied assistant identity without the retired hint/pager", () => {
  const models = modelsFor(fixture.inventory_frame),
    { view } = surface(models);
  expect(view.getByTestId("lanes-map-assistant").props.accessibilityLabel).toBe(
    "Orbit Guide",
  );
  expect(
    view.getAllByTestId(/^lanes-map-lane-/).map((n) => n.props.testID),
  ).toEqual(models.map((m) => `lanes-map-lane-${m.lane.lane_id}`));
  expect(view.queryByTestId("lanes-map-members-pending")).toBeNull();
  expect(view.queryAllByTestId(/^lanes-map-page-/)).toHaveLength(0);
  for (const model of models) {
    const n = view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`);
    expect(n.props.accessibilityRole).toBe("button");
    expect(n.props.accessibilityState.selected).toBe(false);
    expect(n.props.accessibilityLabel).toBe(
      `${model.lane.title}, ${model.stateLabel}, —/—`,
    );
  }
});
test.each<string>(fixture.progress_v2.map((e: { name: string }) => e.name))(
  "focused progress preserves shared truth for %s",
  (name) => {
    const model = modelFor(name),
      { view } = surface([model], model.lane.lane_id);
    expect(
      view.getByTestId(`lanes-map-progress-${model.lane.lane_id}`),
    ).toHaveTextContent(model.progressLabel.replace(/^est\. open work /, ""));
    expect(
      view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`).props
        .accessibilityState.selected,
    ).toBe(true);
  },
);
test("focus/member/log/chat/back keep the same model and selection state", () => {
  const model = modelFor(),
    { view, onOpenMember, onChat, onLog } = surface([model]);
  fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
  const id = `lanes-map-member-${model.members[0].spec_id}`;
  fireEvent.press(view.getByTestId(id));
  expect(onOpenMember).toHaveBeenCalledWith(model, model.members[0]);
  expect(view.getByTestId(id).props.accessibilityState.selected).toBe(true);
  fireEvent.press(view.getByTestId("member-detail-back"));
  fireEvent.press(view.getByTestId(`lanes-map-log-${model.lane.lane_id}`));
  fireEvent.press(view.getByTestId(`lanes-map-chat-${model.lane.lane_id}`));
  expect(onLog).toHaveBeenCalledWith(model);
  expect(onChat).toHaveBeenCalledWith(model);
  fireEvent.press(view.getByTestId("lanes-map-back"));
  expect(view.getByTestId("lanes-map-assistant")).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(0);
});
test("nine lanes and 32 fetched members remain reachable in the dense sheet without a general overflow screen", async () => {
  const { lanes, members } = overflowModels();
  const readShow = jest.fn(async (id: string): Promise<WorkLaneShow> => ({
    lane_id: id,
    projection: lanes.find((m) => m.lane.lane_id === id)!.lane,
    members,
    updates: [],
    events: [],
    spec_changes: [],
  }));
  const { view } = surface(lanes, null, 0, readShow);
  expect(view.getAllByTestId(/^lanes-map-lane-/)).toHaveLength(9);
  for (const model of lanes) {
    fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
    await act(async () => {});
    expect(
      view.getAllByTestId(/^lane-members-row-/).map((n) => n.props.testID),
    ).toEqual(members.map((m) => `lane-members-row-${m.spec_id}`));
    expect(view.getAllByTestId(/^lanes-map-member-/)).toHaveLength(32);
    expect(
      view.queryByTestId(`lanes-map-more-${model.lane.lane_id}`),
    ).toBeNull();
    fireEvent.press(
      view.getByTestId(`lane-members-row-${members[31].spec_id}`),
    );
    expect(
      view.getByTestId(`member-detail-${members[31].spec_id}`),
    ).toBeTruthy();
    fireEvent.press(view.getByTestId("member-detail-back"));
    expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32);
    fireEvent.press(view.getByTestId("lanes-map-back"));
  }
  expect(new Set(readShow.mock.calls.map(([id]) => id))).toEqual(
    new Set(lanes.map((m) => m.lane.lane_id)),
  );
});
test.each([0, 2, 6])(
  "all %i small-lane members fan out individually regardless of status",
  (total) => {
    const source = progressCase("active_progress").frame,
      members = Array.from({ length: total }, (_, i) => ({
        ...source.lanes[0].members[0],
        spec_id: `small-${i}`,
        status: i % 2 ? "backlog" : "completed",
      }));
    const models = modelsFor({
      ...source,
      lanes: [{ ...source.lanes[0], members, members_total: total }],
    });
    const { view } = surface(models, models[0].lane.lane_id);
    expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(total);
    expect(
      view.queryByTestId(`lanes-map-more-${models[0].lane.lane_id}`),
    ).toBeNull();
  },
);
test("Pending and Done stacks expand in place and spec back restores its originating stack", () => {
  const base = modelFor();
  const statuses = [
    "in_progress",
    "needs_qa",
    "missing",
    "ambiguous",
    "ready_for_dev",
    "analysis",
    "backlog",
    "backlog",
    "completed",
    "deprecated",
  ];
  const members = statuses.map((status, i) => ({
    ...base.members[0],
    spec_id: `stack-${i}`,
    title: `Stack member ${i}`,
    status,
    terminal: status === "completed" || status === "deprecated" ? status : null,
  }));
  const models = modelsFor({
    ...progressCase("active_progress").frame,
    lanes: [{ ...base.lane, members, members_total: members.length }],
  });
  const model = models[0],
    { view } = surface(models, model.lane.lane_id);
  expect(view.getAllByTestId(/^lanes-map-member-/)).toHaveLength(4);
  const pending = `lanes-map-more-${model.lane.lane_id}`,
    done = `lanes-map-done-stack-${model.lane.lane_id}`;
  expect(view.getByTestId(pending).props.accessibilityLabel).toBe(
    "Pending, 4 specs",
  );
  expect(view.getByTestId(done).props.accessibilityLabel).toBe("Done, 2 specs");
  for (const [id, indices] of [
    [pending, [4, 5, 6, 7]],
    [done, [8, 9]],
  ] as const) {
    fireEvent.press(view.getByTestId(id));
    if (id === done) {
      const close = view.getByTestId("lanes-map-stack-close");
      expect(StyleSheet.flatten(close.props.style)).toMatchObject({
        borderStyle: "solid",
        borderColor: `${Tokens.palette.green}88`,
      });
      expect(
        StyleSheet.flatten(view.getByText("DONE · 2").props.style).color,
      ).toBe(Tokens.palette.green);
      expect(
        StyleSheet.flatten(
          within(view.getByTestId("lane-members-row-stack-8")).getByText(
            "Stack member 8",
          ).props.style,
        ).fontFamily,
      ).toBe(Fonts.rajdhani.bold);
    }
    expect(
      view.getAllByTestId(/^lanes-map-member-/).map((n) => n.props.testID),
    ).toEqual(indices.map((i) => `lanes-map-member-stack-${i}`));
    expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(
      indices.length,
    );
    fireEvent.press(view.getByTestId(`lanes-map-member-stack-${indices[0]}`));
    expect(view.getByTestId(`member-detail-stack-${indices[0]}`)).toBeTruthy();
    fireEvent.press(view.getByTestId("member-detail-back"));
    expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(
      indices.length,
    );
    fireEvent.press(view.getByTestId("lanes-map-stack-close"));
    expect(view.getByTestId(pending)).toBeTruthy();
  }
});
test.each([16, 17, 32])(
  "%i lanes render 16 plus conditional +remaining, with all lanes reachable through list callback",
  (total) => {
    const base = modelFor(),
      models = Array.from({ length: total }, (_, i) => ({
        ...base,
        lane: { ...base.lane, lane_id: `many-${i}` },
      }));
    const { view, onShowAll } = surface(models);
    expect(view.getAllByTestId(/^lanes-map-lane-/)).toHaveLength(
      Math.min(16, total),
    );
    const overflow = view.queryByTestId("lanes-map-overflow");
    if (total > 16) {
      expect(overflow).toHaveTextContent(`+${total - 16}`);
      fireEvent.press(overflow!);
      expect(onShowAll).toHaveBeenCalledWith(models[0]);
    } else expect(overflow).toBeNull();
  },
);
test("two rings use stable attention order and keep node centres on ellipses", () => {
  const base = modelFor();
  const states = [
    "paused",
    "active",
    "blocked",
    "active",
    "blocked",
    "paused",
    "active",
    "active",
  ];
  const models = states.map((state, i) => ({
    ...base,
    lane: {
      ...base.lane,
      lane_id: `attention-${i}`,
      state: state as any,
      lead: {
        ...base.lane.lead!,
        presence: { ...base.lane.lead!.presence, working: i === 3 },
      },
    },
  }));
  const { view } = surface(models),
    expected = [...models].sort(
      (a, b) => laneAttentionRank(a) - laneAttentionRank(b),
    );
  const nodes = view.getAllByTestId(/^lanes-map-lane-/);
  expect(nodes.map((n) => n.props.testID)).toEqual(
    expected.map((m) => `lanes-map-lane-${m.lane.lane_id}`),
  );
  nodes.forEach((node, i) => {
    const s = StyleSheet.flatten(node.props.style);
    const x = s.left + s.width / 2 - 201,
      y = s.top + s.height / 2 - 330;
    expect(
      (x / (i < 6 ? 100 : 182)) ** 2 + (y / (i < 6 ? 140 : 240)) ** 2,
    ).toBeCloseTo(1, 4);
  });
});
test("no-spec reason suppresses contradictory members and stack nodes", () => {
  const base = modelFor();
  const model = {
    ...base,
    lane: { ...base.lane, no_spec_reason: "Planning a collection" },
    membersTotal: 32,
  };
  const { view } = surface([model], model.lane.lane_id);
  expect(
    view.getByTestId(`lanes-map-progress-${model.lane.lane_id}`),
  ).toBeTruthy();
  expect(
    view.queryAllByTestId(/^lanes-map-(member-|more-|done-stack-)/),
  ).toHaveLength(0);
});
test("v1 upgrades in place preserving focus; disappearance exits focus", () => {
  const v1 = modelsFor(fixture.inventory_frame),
    id = v1[1].lane.lane_id,
    { view, rerender } = surface(v1, id);
  expect(view.getByTestId(`lanes-map-members-pending-${id}`)).toBeTruthy();
  const next = { ...modelFor(), lane: { ...modelFor().lane, lane_id: id } };
  rerender([next]);
  expect(view.queryByTestId(`lanes-map-members-pending-${id}`)).toBeNull();
  expect(view.getAllByTestId(/^lanes-map-member-/)).toHaveLength(2);
  rerender([]);
  expect(view.getByTestId("lanes-map-assistant")).toBeTruthy();
});
test.each([1, 2, 3])(
  "narrow font scale %i retains semantic target labels and a scrollable sheet",
  (fontScale) => {
    const dimensions = require("react-native/Libraries/Utilities/useWindowDimensions"),
      spy = jest
        .spyOn(dimensions, "default")
        .mockReturnValue({ width: 320, height: 640, scale: 1, fontScale });
    try {
      const model = modelFor(),
        { view } = surface([model], model.lane.lane_id);
      fireEvent(view.getByTestId("lanes-map"), "layout", {
        nativeEvent: { layout: { width: 320, height: 640, x: 0, y: 0 } },
      });
      for (const member of model.members)
        expect(
          view.getByTestId(`lanes-map-member-${member.spec_id}`).props
            .accessibilityLabel,
        ).toContain(memberTitleForTest(member));
      expect(
        view.getByTestId(`lanes-map-chat-${model.lane.lane_id}`).props
          .accessibilityRole,
      ).toBe("button");
    } finally {
      spy.mockRestore();
    }
  },
);
function memberTitleForTest(member: WorkLaneMember) {
  return member.title || member.spec_id;
}
test("working and circled-question badges obey state and shared count", () => {
  const base = modelFor();
  const models = ["active", "blocked", "paused"].map((state) => ({
    ...base,
    lane: {
      ...base.lane,
      lane_id: `presence-${state}`,
      state: state as any,
      lead: {
        ...base.lane.lead!,
        presence: { ...base.lane.lead!.presence, working: true },
      },
    },
  }));
  models[0] = { ...models[0], waitingOnYou: 3 };
  const { view } = surface(models);
  expect(view.getByTestId("lanes-map-working-presence-active")).toBeTruthy();
  expect(view.queryByTestId("lanes-map-working-presence-blocked")).toBeNull();
  expect(view.queryByTestId("lanes-map-working-presence-paused")).toBeNull();
  expect(
    view.getByTestId("lanes-map-waiting-presence-active"),
  ).toHaveTextContent("?");
});
test.each(["active", "blocked", "paused"] as const)(
  "spec tones remain distinct in %s lanes and unresolved observation remains red",
  (state) => {
    const base = modelFor(),
      model = {
        ...base,
        stateTone: (state === "blocked"
          ? "amber"
          : state === "paused"
            ? "muted"
            : "green") as LaneCardViewModel["stateTone"],
        lane: { ...base.lane, state },
      };
    const tones = {
      completed: Tokens.palette.green,
      in_progress: Tokens.palette[model.stateTone],
      needs_qa: Tokens.palette.text,
      ready_for_dev: Tokens.palette.dim,
      analysis: Tokens.palette.dim,
      backlog: Tokens.palette.muted,
      deprecated: Tokens.palette.muted,
      missing: Tokens.palette.red,
      ambiguous: Tokens.palette.red,
    };
    for (const [status, tone] of Object.entries(tones)) {
      const member = { ...base.members[0], status };
      expect(memberTone(member, model)).toBe(tone);
      expect(
        memberTone({ ...member, observation: { quality: "missing" } }, model),
      ).toBe(Tokens.palette.red);
    }
  },
);
test("unavailable chat has explicit text and no control while history retains its target", () => {
  const v1 = modelsFor(fixture.inventory_frame),
    u = v1.find((m) => m.tap.action === "unavailable")!,
    { view, onChat } = surface([u], u.lane.lane_id);
  expect(view.queryByTestId(`lanes-map-chat-${u.lane.lane_id}`)).toBeNull();
  expect(view.getByText("CHAT UNAVAILABLE")).toBeTruthy();
  expect(onChat).not.toHaveBeenCalled();
  view.unmount();
  const h = v1.find((m) => m.tap.action === "history")!,
    next = surface([h], h.lane.lane_id);
  fireEvent.press(next.view.getByTestId(`lanes-map-chat-${h.lane.lane_id}`));
  expect(next.onChat).toHaveBeenCalledWith(h);
});
test("empty map is honest and telemetry remains pageless IDs/counts only", () => {
  const { view } = surface([]);
  expect(view.queryAllByTestId(/^lanes-map-lane-/)).toHaveLength(0);
  expect(view.queryAllByTestId(/^lanes-map-page-/)).toHaveLength(0);
  expect(emitHarnessUiTrace).toHaveBeenLastCalledWith("work_lanes_map_render", {
    page: 1,
    page_count: 1,
    lane_nodes: 0,
    focused_lane_id: null,
    member_nodes: 0,
    more_count: 0,
  });
});

test("working orbit and spoke expose animated transforms; idle lanes retain static geometry", () => {
  const working = modelFor();
  working.lane = {
    ...working.lane,
    lead: {
      ...working.lane.lead!,
      presence: { ...working.lane.lead!.presence, online: true, working: true },
    },
  };
  const { view, rerender } = surface([working]);
  expect(
    StyleSheet.flatten(
      view.getByTestId(`lanes-map-working-${working.lane.lane_id}`).props.style,
    ).transform,
  ).toBeDefined();
  expect(
    view.getByTestId(`lanes-map-flow-${working.lane.lane_id}`),
  ).toBeTruthy();
  const before = StyleSheet.flatten(
    view.getByTestId(`lanes-map-lane-${working.lane.lane_id}`).props.style,
  );
  rerender([
    {
      ...working,
      lane: {
        ...working.lane,
        lead: {
          ...working.lane.lead!,
          presence: { ...working.lane.lead!.presence, working: false },
        },
      },
    },
  ]);
  expect(
    view.queryByTestId(`lanes-map-flow-${working.lane.lane_id}`),
  ).toBeNull();
  expect(
    view.queryByTestId(`lanes-map-working-${working.lane.lane_id}`),
  ).toBeNull();
  const after = StyleSheet.flatten(
    view.getByTestId(`lanes-map-lane-${working.lane.lane_id}`).props.style,
  );
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
});

test("estimate annotations do not invent counts missing from a partial inventory", () => {
  const model = modelFor();
  model.lane = {
    ...model.lane,
    open_estimate_h: { p25: 1, p75: 2, median: 1.5 },
    estimate_complete: false,
    open_estimated: undefined,
    items_open: undefined,
  };
  const { view, rerender } = surface([model], model.lane.lane_id);
  expect(view.queryByText(/open specs estimated/)).toBeNull();
  rerender([
    { ...model, lane: { ...model.lane, open_estimated: 2, items_open: 4 } },
  ]);
  expect(view.getByText("2 of 4 open specs estimated")).toBeTruthy();
});

test.each([
  { no_spec_reason: "Discussion only" },
  { items_total: 0, items_open: 0 },
  { items_total: 3, items_open: 0, items_completed: 3 },
  { items_total: 3, items_open: 0, items_dropped: 3 },
  { items_total: 3, items_open: 0, items_completed: 2, items_dropped: 1 },
])("non-estimate value has no median annotation %j", (patch) => {
  const base = modelFor();
  const model = modelsFor({
    ...progressCase("active_progress").frame,
    lanes: [{ ...base.lane, ...patch }],
  })[0];
  const { view } = surface([model], model.lane.lane_id);
  expect(view.queryByText(/^median /)).toBeNull();
});

test("Done stack row titles are bold", () => {
  const base = modelFor();
  const members = Array.from({ length: 7 }, (_, i) => ({
    ...base.members[0],
    spec_id: `done-row-${i}`,
    title: `Finished item ${i}`,
    status: "completed",
    terminal: "completed",
  }));
  const models = modelsFor({
    ...progressCase("active_progress").frame,
    lanes: [{ ...base.lane, members, members_total: 7 }],
  });
  const { view } = surface(models, base.lane.lane_id);
  fireEvent.press(
    view.getByTestId(`lanes-map-done-stack-${base.lane.lane_id}`),
  );
  expect(
    StyleSheet.flatten(
      within(view.getByTestId("lane-members-row-done-row-0")).getByText(
        "Finished item 0",
      ).props.style,
    ).fontFamily,
  ).toBe(Fonts.rajdhani.bold);
});
