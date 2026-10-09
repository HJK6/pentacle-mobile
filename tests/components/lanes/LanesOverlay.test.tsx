jest.mock("expo-constants", () =>
  require("../../helpers/stubs/expoConstants.cjs"),
);
jest.mock("../../../src/services/pentacleStream", () => ({
  requestWorkLaneShow: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: () => [],
}));

import { readFileSync } from "fs";
import { join } from "path";
import React from "react";
import { ScrollView, StyleSheet } from "react-native";
import { act, fireEvent, render, within } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  parseWorkLaneShow,
  type WorkLane,
  type WorkLaneMember,
  type WorkLaneShow,
} from "pentacle-chat-core";
import { Tokens } from "../../../constants/Colors";
import LanesOverlay from "../../../src/components/lanes/LanesOverlay";
import { laneTime } from "../../../src/components/lanes/LaneAtoms";
import { selectLaneCardViewModels } from "../../../src/services/workLanes";

const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json",
    ),
    "utf8",
  ),
);
const NOW = Date.parse("2026-01-02T00:05:00.000Z");
const progress = (name: string) =>
  fixture.progress_v2.find((entry: { name: string }) => entry.name === name)
    .frame;
const baseFrame = progress("active_progress");
const baseLane: WorkLane = baseFrame.lanes[0];
type Props = React.ComponentProps<typeof LanesOverlay>;
function propsFor(
  frame: unknown = baseFrame,
  overrides: Partial<Props> = {},
): Props {
  const state = applyWorkLanesInventory(initialPentacleStreamState, frame);
  return {
    lanes: selectLaneCardViewModels(state, NOW),
    inventory: state.workLanes,
    assistantName: "Sample guide",
    connected: true,
    updates: [],
    top: 0,
    bottom: 0,
    onChat: jest.fn(),
    onClose: jest.fn(),
    listVariant: "current",
    ...overrides,
  };
}
function frameFor(overrides: Partial<WorkLane>) {
  return { ...baseFrame, lanes: [{ ...baseLane, ...overrides }] };
}
function show(lane = baseLane, members = lane.members ?? []): WorkLaneShow {
  return parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: lane.lane_id },
    projection: lane,
    members,
    updates: [],
    events: [],
  })!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("defaults to list, preserves daemon order and count, and renders the legacy wire without invented progress", () => {
  const props = propsFor(fixture.inventory_frame);
  const view = render(<LanesOverlay {...props} />);
  expect(view.getByTestId("lanes-overlay")).toBeTruthy();
  expect(
    view.getByTestId("lanes-view-toggle").props.accessibilityValue.text,
  ).toBe("list");
  expect(
    view.getByTestId("lanes-view-list").props.accessibilityState.selected,
  ).toBe(true);
  expect(view.getByText("OPEN LANES · 4")).toBeTruthy();
  expect(
    view.getAllByTestId(/^lane-card-wl-/).map((node) => node.props.testID),
  ).toEqual(fixture.expected.order.map((id: string) => `lane-card-${id}`));
  for (const lane of props.lanes) {
    expect(
      view.getByTestId(`lane-card-members-pending-${lane.lane.lane_id}`),
    ).toHaveTextContent("Specs arrive when the daemon updates");
    expect(
      view.getByTestId(`lane-card-progress-${lane.lane.lane_id}`),
    ).toHaveTextContent("—");
  }
  expect(view.queryByText("All specs done")).toBeNull();
  expect(view.queryByText(/est\. open work/)).toBeNull();
  expect(view.queryAllByTestId(/^lane-segment-/)).toHaveLength(0);
  fireEvent.press(view.getByLabelText("Close lanes"));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test.each([
  ["active_progress", "ACTIVE · IDLE", "2–4h"],
  ["paused_leadless", "PAUSED", "2–4h"],
  ["blocked", "BLOCKED", "2–4h"],
  ["missing_member", "PAUSED", "1 unresolved"],
  ["ambiguous_member", "PAUSED", "1 unresolved"],
  ["missing_estimate", "PAUSED", "—"],
  ["no_spec", "PAUSED", "Exploratory conversation."],
  ["index_unavailable", "PAUSED", "2–4h"],
])(
  "renders the shared %s case with its literal state, truth label and reachable members",
  (name, stateLabel, progressLabel) => {
    const frame = progress(name);
    const lane = frame.lanes[0];
    const view = render(<LanesOverlay {...propsFor(frame)} />);
    expect(
      view.getByTestId(`lane-card-state-${lane.lane_id}`),
    ).toHaveTextContent(stateLabel);
    expect(
      view.getByTestId(`lane-card-progress-${lane.lane_id}`),
    ).toHaveTextContent(progressLabel);
    if (name === "no_spec") {
      expect(view.queryByTestId(`lane-card-toggle-${lane.lane_id}`)).toBeNull();
      expect(view.queryAllByTestId(/^lane-segment-/)).toHaveLength(0);
    } else {
      const link = view.queryByTestId(`lane-card-toggle-${lane.lane_id}`);
      if (link) {
        fireEvent.press(link);
        expect(
          view.getByTestId(`lane-card-toggle-${lane.lane_id}`).props
            .accessibilityState.expanded,
        ).toBe(true);
      }
      expect(
        view
          .getAllByTestId(/^lane-card-member-/)
          .map((node) => node.props.testID),
      ).toEqual(
        lane.members.map(
          (member: WorkLaneMember) =>
            `lane-card-member-${lane.lane_id}-${member.spec_id}`,
        ),
      );
      for (const member of lane.members) {
        fireEvent.press(
          view.getByTestId(
            `lane-card-member-${lane.lane_id}-${member.spec_id}`,
          ),
        );
        expect(
          view.getByTestId(`member-detail-${member.spec_id}`),
        ).toBeTruthy();
        if (member.observation.quality !== "fresh") {
          expect(
            view.getByText(
              `${member.observation.quality.toUpperCase()} · observed ${member.observation.observed_at ? laneTime(member.observation.observed_at) : "unknown"}`,
            ),
          ).toBeTruthy();
        }
        fireEvent.press(
          view.getByTestId(
            `lane-card-member-${lane.lane_id}-${member.spec_id}`,
          ),
        );
      }
    }
    if (name === "paused_leadless")
      expect(view.getByText(/· no lead ·/)).toBeTruthy();
    if (name === "index_unavailable")
      expect(view.getByTestId("lanes-index-banner")).toHaveTextContent(
        `DATA AS OF ${frame.work_index.snapshot_at}`,
      );
    else expect(view.queryByTestId("lanes-index-banner")).toBeNull();
  },
);

test.each<[string, Partial<WorkLane>, string]>([
  [
    "empty",
    { items_total: 0, items_open: 0, items_completed: 0, items_dropped: 0 },
    "No specs",
  ],
  [
    "reason before unresolved",
    { no_spec_reason: "Sample discussion only", items_unresolved: 1 },
    "Sample discussion only",
  ],
  [
    "unresolved before open",
    { items_total: 3, items_unresolved: 1, items_open: 2 },
    "1 unresolved",
  ],
  ["positive open", { items_total: 3, items_open: 2 }, "2–4h"],
  ["unknown estimate", { open_estimate_h: null }, "—"],
  ["incomplete estimate", { estimate_complete: false }, "2–4h+"],
  [
    "all completed",
    { items_total: 3, items_open: 0, items_completed: 3, items_dropped: 0 },
    "All specs done",
  ],
  [
    "all dropped",
    { items_total: 3, items_open: 0, items_completed: 0, items_dropped: 3 },
    "All specs dropped",
  ],
  [
    "mixed closed",
    { items_total: 3, items_open: 0, items_completed: 2, items_dropped: 1 },
    "No open work",
  ],
])("list progress precedence: %s", (_name, overrides, expected) => {
  const view = render(<LanesOverlay {...propsFor(frameFor(overrides))} />);
  expect(
    view.getByTestId(`lane-card-progress-${baseLane.lane_id}`),
  ).toHaveTextContent(expected);
  expect(view.queryByText(/^Done$/)).toBeNull();
});

test.each<[Partial<WorkLane>, string]>([
  [
    {
      state: "active",
      lead: {
        ...baseLane.lead!,
        presence: { ...baseLane.lead!.presence, working: true },
      },
    },
    "WORKING",
  ],
  [{ state: "active" }, "ACTIVE · IDLE"],
  [{ state: "paused", state_reason: "fd", lead: null }, "PAUSED"],
  [
    { state: "paused", state_reason: "lead_lost", lead: null },
    "PAUSED · LEAD LOST",
  ],
  [
    { state: "paused", state_reason: "lead_lost_unreconciled", lead: null },
    "PAUSED · LEAD LOST",
  ],
  [{ state: "blocked" }, "BLOCKED"],
])("renders lane state %s as %s", (overrides, expected) => {
  const view = render(<LanesOverlay {...propsFor(frameFor(overrides))} />);
  expect(
    view.getByTestId(`lane-card-state-${baseLane.lane_id}`).props.children,
  ).toBe(expected);
});

test("segment fractions and colors render completed, live, needs-QA, dropped, missing and ambiguous members", () => {
  const statuses = [
    "completed",
    "in_progress",
    "needs_qa",
    "deprecated",
    "missing",
    "ambiguous",
  ];
  const members = statuses.map((status, index) => ({
    ...baseLane.members![0],
    spec_id: `spec_status_${index}`,
    status,
    ac_checked: 1,
    ac_total: 4,
    observation: { quality: "fresh" as const },
  }));
  const frame = frameFor({ members, members_total: 6 });
  const view = render(<LanesOverlay {...propsFor(frame)} />);
  const fractions = [1, 0.25, 0.25, 0, 0, 0];
  const colors = [
    Tokens.palette.green,
    Tokens.palette.green,
    Tokens.palette.green,
    Tokens.palette.muted,
    Tokens.palette.red,
    Tokens.palette.red,
  ];
  for (const [index, member] of members.entries()) {
    const segment = view.getByTestId(
      `lane-segment-${baseLane.lane_id}-${member.spec_id}`,
    );
    expect(segment.props.accessibilityLabel).toBe(
      `${member.status}, ${fractions[index] * 100} percent`,
    );
    expect(
      StyleSheet.flatten(
        segment.children[0] && typeof segment.children[0] !== "string"
          ? segment.children[0].props.style
          : {},
      ),
    ).toMatchObject({
      width: `${fractions[index] * 100}%`,
      backgroundColor: colors[index],
    });
  }
  for (const [state, tone] of [
    ["blocked", Tokens.palette.amber],
    ["paused", Tokens.palette.muted],
  ] as const) {
    view.rerender(
      <LanesOverlay
        {...propsFor(frameFor({ members, members_total: 6, state }))}
      />,
    );
    const live = view.getByTestId(
      `lane-segment-${baseLane.lane_id}-${members[1].spec_id}`,
    );
    expect(
      StyleSheet.flatten((live.children[0] as any).props.style).backgroundColor,
    ).toBe(tone);
    const missing = view.getByTestId(
      `lane-segment-${baseLane.lane_id}-${members[4].spec_id}`,
    );
    expect(
      StyleSheet.flatten((missing.children[0] as any).props.style)
        .backgroundColor,
    ).toBe(Tokens.palette.red);
  }
});

test("blocked questions replace the blocker with the waiting count and question glyph in both views", () => {
  const props = propsFor(progress("blocked"));
  props.lanes = props.lanes.map((lane) => ({
    ...lane,
    waitingOnYou: 2,
    waitingOnYouLabel: "Waiting on you · 2 questions",
    blockerLabel: "Waiting on you · 2 questions",
  }));
  const lane = props.lanes[0];
  const view = render(<LanesOverlay {...props} />);
  expect(view.getByText("Waiting on you: 2 questions")).toBeTruthy();
  expect(view.queryByText(`! ${lane.lane.blocker}`)).toBeNull();
  fireEvent.press(view.getByTestId("lanes-view-map"));
  expect(
    view.getByTestId(`lanes-map-waiting-${lane.lane.lane_id}`),
  ).toHaveTextContent("?");
  fireEvent.press(view.getByTestId(`lanes-map-lane-${lane.lane.lane_id}`));
  expect(view.getByText("Waiting on you: 2 questions")).toBeTruthy();
});

test("See chat keeps explicit open/history/unavailable targets from list and focused map", () => {
  const props = propsFor(fixture.inventory_frame);
  const view = render(<LanesOverlay {...props} />);
  for (const model of props.lanes) {
    fireEvent.press(view.getByTestId(`lane-card-chat-${model.lane.lane_id}`));
    if (model.tap.action !== "unavailable")
      expect(props.onChat).toHaveBeenLastCalledWith(model);
    else
      expect(
        view.getByTestId(`lane-card-chat-${model.lane.lane_id}`).props
          .accessibilityState.disabled,
      ).toBe(true);
  }
  expect(props.onChat).toHaveBeenCalledTimes(3);
  fireEvent.press(view.getByTestId("lanes-view-map"));
  for (const model of props.lanes) {
    fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
    if (model.tap.action !== "unavailable") {
      fireEvent.press(view.getByTestId(`lanes-map-chat-${model.lane.lane_id}`));
      expect(props.onChat).toHaveBeenLastCalledWith(model);
    } else {
      expect(
        view.queryByTestId(`lanes-map-chat-${model.lane.lane_id}`),
      ).toBeNull();
      expect(view.getByText("CHAT UNAVAILABLE")).toBeTruthy();
    }
    fireEvent.press(view.getByTestId("lanes-map-back"));
  }
  expect(props.onChat).toHaveBeenCalledTimes(6);
});

test.each(["list", "map"] as const)(
  "%s keeps all 32 fetched members reachable inline or in the dense sheet, with detail/log/back",
  async (mode) => {
    const members = Array.from({ length: 32 }, (_, i) => ({
      ...baseLane.members![0],
      spec_id: `spec_full_${i + 1}`,
      title: `Full sample ${i + 1}`,
    }));
    const lane = {
      ...baseLane,
      members: members.slice(0, 8),
      members_total: 32,
      items_total: 32,
    };
    const readShow = jest.fn().mockResolvedValue(show(lane, members));
    const view = render(
      <LanesOverlay {...propsFor(frameFor(lane), { readShow })} />,
    );
    if (mode === "list")
      fireEvent.press(view.getByTestId(`lane-card-show-all-${lane.lane_id}`));
    else {
      fireEvent.press(view.getByTestId("lanes-view-map"));
      fireEvent.press(view.getByTestId(`lanes-map-lane-${lane.lane_id}`));
    }
    await act(async () => {});
    const rows = mode === "list" ? /^lane-card-member-/ : /^lane-members-row-/;
    expect(view.getAllByTestId(rows)).toHaveLength(32);
    const pick =
      mode === "list"
        ? `lane-card-member-${lane.lane_id}-spec_full_32`
        : "lane-members-row-spec_full_32";
    fireEvent.press(view.getByTestId(pick));
    expect(view.getByTestId("member-detail-spec_full_32")).toBeTruthy();
    if (mode === "list") fireEvent.press(view.getByTestId(pick));
    else fireEvent.press(view.getByTestId("member-detail-back"));
    fireEvent.press(
      view.getByTestId(
        `${mode === "list" ? "lane-card" : "lanes-map"}-log-${lane.lane_id}`,
      ),
    );
    await act(async () => {});
    for (const tab of ["updates", "spec-changes", "events"]) {
      fireEvent.press(view.getByTestId(`lane-log-tab-${tab}`));
      expect(
        view.getByTestId(`lane-log-tab-${tab}`).props.accessibilityState
          .selected,
      ).toBe(true);
    }
    fireEvent.press(view.getByTestId("lane-log-back"));
    expect(
      view.getByTestId("lanes-view-toggle").props.accessibilityValue.text,
    ).toBe(mode);
    expect(view.getAllByTestId(rows)).toHaveLength(32);
  },
);

test("v1→increment-1 reconnect upgrades the same mounted overlay, preserving selected map, lane focus and later card expansion", async () => {
  const v1 = {
    ...fixture.inventory_frame,
    lanes: [{ ...fixture.inventory_frame.lanes[1], lane_id: baseLane.lane_id }],
  };
  const readShow = jest.fn().mockResolvedValue(show());
  const view = render(<LanesOverlay {...propsFor(v1, { readShow })} />);
  fireEvent.press(view.getByTestId("lanes-view-map"));
  fireEvent.press(view.getByTestId(`lanes-map-lane-${baseLane.lane_id}`));
  expect(
    view.getByTestId(`lanes-map-members-pending-${baseLane.lane_id}`),
  ).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(0);
  view.rerender(
    <LanesOverlay {...propsFor(v1, { connected: false, readShow })} />,
  );
  view.rerender(<LanesOverlay {...propsFor(baseFrame, { readShow })} />);
  expect(
    view.getByTestId("lanes-view-toggle").props.accessibilityValue.text,
  ).toBe("map");
  expect(
    view.getByTestId(`lanes-map-lane-${baseLane.lane_id}`).props
      .accessibilityState.selected,
  ).toBe(true);
  expect(
    view.queryByTestId(`lanes-map-members-pending-${baseLane.lane_id}`),
  ).toBeNull();
  expect(view.getAllByTestId(/^lanes-map-member-/)).toHaveLength(2);
  fireEvent.press(
    view.getByTestId(`lanes-map-member-${baseLane.members![0].spec_id}`),
  );
  expect(
    view.getByTestId(`member-detail-${baseLane.members![0].spec_id}`),
  ).toBeTruthy();
  fireEvent.press(view.getByTestId("member-detail-back"));
  fireEvent.press(view.getByTestId("lanes-view-list"));
  fireEvent.press(view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`));
  view.rerender(
    <LanesOverlay
      {...propsFor(
        frameFor({
          version: baseLane.version + 1,
          freshness_at: "2026-01-02T00:04:00.000Z",
        }),
        { readShow },
      )}
    />,
  );
  expect(
    view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`).props
      .accessibilityState.expanded,
  ).toBe(true);
  expect(view.getAllByTestId(/^lane-card-member-/)).toHaveLength(2);
  fireEvent.press(view.getByTestId("lanes-view-map"));
  fireEvent.press(view.getByTestId("lanes-view-list"));
  expect(
    view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`).props
      .accessibilityState.expanded,
  ).toBe(true);
  expect(readShow).not.toHaveBeenCalled();
});

test("detail uses the selected full-list observation over stale inline data and refreshes on a newer inventory revision", async () => {
  const members = Array.from({ length: 32 }, (_, index) => ({
    ...baseLane.members![0],
    spec_id: `spec_revision_${index + 1}`,
    title: `Old member ${index + 1}`,
    obs_rev: 1,
  }));
  const lane = {
    ...baseLane,
    members: members.slice(0, 8),
    members_total: 32,
    items_total: 32,
  };
  const fetched = members.map((member) => ({
    ...member,
    title: member.title.replace("Old", "Fetched"),
    status: "completed",
    ac_checked: 2,
    obs_rev: 2,
  }));
  const readShow = jest.fn().mockResolvedValue(show(lane, fetched));
  const view = render(
    <LanesOverlay {...propsFor(frameFor(lane), { readShow })} />,
  );
  fireEvent.press(view.getByTestId(`lane-card-show-all-${lane.lane_id}`));
  await act(async () => {});
  fireEvent.press(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_revision_1`),
  );
  const detail = within(view.getByTestId("member-detail-spec_revision_1"));
  expect(view.getByText("Fetched member 1")).toBeTruthy();
  expect(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_revision_1`).props
      .accessibilityLabel,
  ).toContain("completed");
  expect(detail.queryByText("Old member 1")).toBeNull();
  const refreshed = {
    ...lane,
    members: [
      {
        ...fetched[0],
        title: "Latest member revision",
        status: "needs_qa",
        obs_rev: 3,
      },
      ...members.slice(1, 8),
    ],
  };
  view.rerender(
    <LanesOverlay {...propsFor(frameFor(refreshed), { readShow })} />,
  );
  const updatedDetail = within(
    view.getByTestId("member-detail-spec_revision_1"),
  );
  expect(view.getByText("Latest member revision")).toBeTruthy();
  expect(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_revision_1`).props
      .accessibilityLabel,
  ).toContain("needs_qa");
  expect(updatedDetail.queryByText("Fetched member 1")).toBeNull();
  expect(readShow).toHaveBeenCalledTimes(1);
});

test.each(["stale", "error"] as const)(
  "an open detail reflects live %s quality even when observation revision and timestamp are unchanged",
  (quality) => {
    const view = render(<LanesOverlay {...propsFor()} />);
    const original = baseLane.members![0];
    fireEvent.press(view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`));
    fireEvent.press(
      view.getByTestId(
        `lane-card-member-${baseLane.lane_id}-${original.spec_id}`,
      ),
    );
    expect(view.queryByText(/^(STALE|ERROR) · observed/)).toBeNull();
    const updated = {
      ...original,
      observation: {
        ...original.observation!,
        quality,
        error: quality === "error" ? "Sample source is unreadable" : null,
      },
    };
    view.rerender(
      <LanesOverlay
        {...propsFor(
          frameFor({ members: [updated, ...baseLane.members!.slice(1)] }),
        )}
      />,
    );
    expect(view.getByTestId(`member-detail-${original.spec_id}`)).toBeTruthy();
    expect(
      view.getByText(
        `${quality.toUpperCase()} · observed ${laneTime(original.observation!.observed_at)}`,
      ),
    ).toBeTruthy();
    if (quality === "error")
      expect(view.getByText("Sample source is unreadable")).toBeTruthy();
    fireEvent.press(
      view.getByTestId(
        `lane-card-member-${baseLane.lane_id}-${original.spec_id}`,
      ),
    );
    expect(
      view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`).props
        .accessibilityState.expanded,
    ).toBe(true);
  },
);

test("an unrelated inventory change cannot replace a fetched detail with semantically unchanged older inline facts", async () => {
  const members = Array.from({ length: 9 }, (_, index) => ({
    ...baseLane.members![0],
    spec_id: `spec_equal_revision_${index}`,
    title: `Old inline ${index}`,
  }));
  const lane = { ...baseLane, members: members.slice(0, 8), members_total: 9 };
  const fetched = members.map((member) => ({
    ...member,
    title: member.title.replace("Old inline", "New fetched"),
    status: "completed",
  }));
  const readShow = jest.fn().mockResolvedValue(show(lane, fetched));
  const view = render(
    <LanesOverlay {...propsFor(frameFor(lane), { readShow })} />,
  );
  fireEvent.press(view.getByTestId(`lane-card-show-all-${lane.lane_id}`));
  await act(async () => {});
  fireEvent.press(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_equal_revision_0`),
  );
  expect(view.getByText("New fetched 0")).toBeTruthy();
  expect(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_equal_revision_0`)
      .props.accessibilityLabel,
  ).toContain("completed");
  const unrelated = JSON.parse(
    JSON.stringify(frameFor({ ...lane, title: "Changed lane title only" })),
  );
  view.rerender(<LanesOverlay {...propsFor(unrelated, { readShow })} />);
  expect(view.getByText("New fetched 0")).toBeTruthy();
  expect(
    view.getByTestId(`lane-card-member-${lane.lane_id}-spec_equal_revision_0`)
      .props.accessibilityLabel,
  ).toContain("completed");
  expect(view.queryByText("Old inline 0")).toBeNull();
  expect(readShow).toHaveBeenCalledTimes(1);
});

test("long lane titles retain full accessible controls and scrollable focused sheet and log at narrow large text", async () => {
  const dimensions = require("react-native/Libraries/Utilities/useWindowDimensions");
  const spy = jest
    .spyOn(dimensions, "default")
    .mockReturnValue({ width: 320, height: 640, scale: 1, fontScale: 3 });
  try {
    const title = "Long sample lane title ".repeat(6).slice(0, 120);
    const lane = { ...baseLane, title };
    const readShow = jest.fn().mockResolvedValue(show(lane));
    const view = render(
      <LanesOverlay {...propsFor(frameFor(lane), { readShow })} />,
    );
    fireEvent.press(view.getByTestId("lanes-view-map"));
    fireEvent.press(view.getByTestId(`lanes-map-lane-${lane.lane_id}`));
    expect(
      view.getByTestId(`lanes-map-lane-${lane.lane_id}`).props
        .accessibilityLabel,
    ).toContain(title);
    expect(view.UNSAFE_getAllByType(ScrollView).length).toBeGreaterThanOrEqual(
      2,
    );
    fireEvent.press(
      view.getByTestId(`lanes-map-member-${lane.members![0].spec_id}`),
    );
    expect(
      view.getByTestId("member-detail-back").props.accessibilityLabel,
    ).toBe(`Back to ${title}`);
    fireEvent.press(view.getByTestId("member-detail-back"));
    fireEvent.press(view.getByTestId(`lanes-map-log-${lane.lane_id}`));
    await act(async () => {});
    expect(view.getByTestId("lane-log-back").props.accessibilityLabel).toBe(
      `Back to ${title}`,
    );
    expect(view.getByTestId("lane-log-empty")).toBeTruthy();
    fireEvent.press(view.getByTestId("lane-log-back"));
    expect(
      view.getByTestId(`lanes-map-lane-${lane.lane_id}`).props
        .accessibilityState.selected,
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test.each(["resolve", "reject"] as const)(
  "Back from loading log ignores late %s and leaves the expanded card intact",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const readShow = jest.fn().mockReturnValue(pending.promise);
    const view = render(
      <LanesOverlay {...propsFor(baseFrame, { readShow })} />,
    );
    fireEvent.press(view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`));
    fireEvent.press(view.getByTestId(`lane-card-log-${baseLane.lane_id}`));
    expect(view.getByTestId("lane-log-loading")).toBeTruthy();
    expect(readShow).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByTestId("lane-log-back"));
    await act(async () => {
      if (settle === "resolve") pending.resolve(show());
      else pending.reject(new Error("late failure"));
    });
    expect(view.queryByTestId(`lane-log-${baseLane.lane_id}`)).toBeNull();
    expect(view.queryByTestId("lane-log-error")).toBeNull();
    expect(
      view.getByTestId(`lane-card-toggle-${baseLane.lane_id}`).props
        .accessibilityState.expanded,
    ).toBe(true);
  },
);

test("index-unavailable marker remains visible in nested detail, and a reason suppresses supplied members", () => {
  const unavailable = progress("index_unavailable");
  const lane = unavailable.lanes[0];
  const view = render(<LanesOverlay {...propsFor(unavailable)} />);
  const toggle = view.queryByTestId(`lane-card-toggle-${lane.lane_id}`);
  if (toggle) fireEvent.press(toggle);
  fireEvent.press(
    view.getByTestId(
      `lane-card-member-${lane.lane_id}-${lane.members[0].spec_id}`,
    ),
  );
  expect(view.getByTestId("lanes-index-banner")).toHaveTextContent(
    `DATA AS OF ${unavailable.work_index.snapshot_at}`,
  );
  fireEvent.press(
    view.getByTestId(
      `lane-card-member-${lane.lane_id}-${lane.members[0].spec_id}`,
    ),
  );
  view.rerender(
    <LanesOverlay
      {...propsFor({
        ...unavailable,
        lanes: [{ ...lane, no_spec_reason: "Sample discussion only" }],
      })}
    />,
  );
  expect(view.getAllByText("Sample discussion only").length).toBeGreaterThan(0);
  expect(view.queryAllByTestId(/^lane-card-member-/)).toHaveLength(0);
  expect(view.queryByTestId(`lane-card-toggle-${lane.lane_id}`)).toBeNull();
});

test("empty and truncated inventory notices use daemon counts", () => {
  const empty = {
    ...baseFrame,
    lanes: [],
    counts: { open: 0, active: 0, paused: 0, blocked: 0 },
  };
  const view = render(<LanesOverlay {...propsFor(empty)} />);
  expect(view.getByText("No open lanes")).toBeTruthy();
  view.rerender(
    <LanesOverlay
      {...propsFor({
        ...baseFrame,
        truncated: true,
        counts: { open: 70, active: 70, paused: 0, blocked: 0 },
      })}
    />,
  );
  expect(view.getByText("OPEN LANES · 1 OF 70")).toBeTruthy();
});

test("compact is the default: bar/count toggles spec bars and header opens connected chat", () => {
  const props = propsFor(baseFrame);
  delete props.listVariant;
  const view = render(<LanesOverlay {...props} />);
  const id = props.lanes[0].lane.lane_id;
  expect(view.queryByTestId(`lane-card-log-${id}`)).toBeNull();
  expect(
    view.queryByTestId(
      `lane-card-member-${id}-${props.lanes[0].members[0].spec_id}`,
    ),
  ).toBeNull();
  const toggle = view.getByTestId(`lane-card-toggle-${id}`);
  expect(toggle.props.accessibilityState.expanded).toBe(false);
  fireEvent.press(toggle);
  for (const m of props.lanes[0].members)
    expect(
      view.getByTestId(`lane-card-member-${id}-${m.spec_id}`),
    ).toBeTruthy();
  expect(view.queryByText("Show current only")).toBeNull();
  view.rerender(<LanesOverlay {...props} />);
  expect(
    view.getByTestId(`lane-card-toggle-${id}`).props.accessibilityState
      .expanded,
  ).toBe(true);
  fireEvent.press(view.getByTestId(`lane-card-chat-${id}`));
  expect(props.onChat).toHaveBeenCalled();
  fireEvent.press(view.getByTestId(`lane-card-toggle-${id}`));
  expect(
    view.queryByTestId(
      `lane-card-member-${id}-${props.lanes[0].members[0].spec_id}`,
    ),
  ).toBeNull();
});

test("compact mount and expansion do not enrich last updates", async () => {
  const read = jest.fn();
  const props = propsFor(baseFrame, { readShow: read, listVariant: "compact" });
  props.lanes = props.lanes.map((m) => ({
    ...m,
    lane: {
      ...m.lane,
      last_update: {
        update_id: "synthetic-u",
        kind: "milestone",
        event_id: 2,
        ts: "2026-01-02T00:00:00Z",
      },
    },
  }));
  const view = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  fireEvent.press(
    view.getByTestId(`lane-card-toggle-${props.lanes[0].lane.lane_id}`),
  );
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  expect(
    view.queryByTestId(`lane-card-log-${props.lanes[0].lane.lane_id}`),
  ).toBeNull();
});

test("last-update enrichment caches failures until update identity changes", async () => {
  const read = jest.fn().mockRejectedValue(new Error("Unavailable"));
  const props = propsFor(baseFrame, { readShow: read });
  props.lanes = props.lanes.map((m) => ({
    ...m,
    lastUpdateText: "Inventory summary",
    lane: {
      ...m.lane,
      last_update: {
        update_id: "failed-u",
        kind: "milestone",
        event_id: 2,
        ts: "2026-01-02T00:00:00Z",
      },
    },
  }));
  const first = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(props.lanes.length);
  expect(first.getByText("Inventory summary")).toBeTruthy();
  first.unmount();
  const second = render(<LanesOverlay {...props} />);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(props.lanes.length);
  second.rerender(
    <LanesOverlay
      {...props}
      lanes={props.lanes.map((m) => ({
        ...m,
        lane: {
          ...m.lane,
          last_update: { ...m.lane.last_update!, update_id: "new-u" },
        },
      }))}
    />,
  );
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(props.lanes.length * 2);
});
