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
import { act, fireEvent, render, within } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  parseWorkLaneShow,
  type WorkLaneShow,
} from "pentacle-chat-core";
import LaneLog from "../../../src/components/lanes/LaneLog";
import {
  selectLaneCardViewModels,
  type LaneUpdateEntry,
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
const frame = fixture.progress_v2.find(
  (entry: { name: string }) => entry.name === "active_progress",
).frame;
const model = selectLaneCardViewModels(
  applyWorkLanesInventory(initialPentacleStreamState, frame),
)[0];
const at = "2026-01-02T00:00:00.000Z";
function show(overrides: Record<string, unknown> = {}): WorkLaneShow {
  return parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: model.lane.lane_id },
    projection: model.lane,
    members: model.members,
    events: [],
    updates: [],
    ...overrides,
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
function tree(
  readShow: jest.Mock,
  props: Partial<React.ComponentProps<typeof LaneLog>> = {},
) {
  return (
    <LaneLog
      model={model}
      connected
      readShow={readShow}
      onBack={jest.fn()}
      {...props}
    />
  );
}
function published(
  updateId: string,
  summary: string,
  laneId = model.lane.lane_id,
): LaneUpdateEntry {
  return {
    event: fixture.lane_update_events[0],
    update: {
      update_id: updateId,
      lane_id: laneId,
      kind: "milestone",
      summary,
      source: { type: "transition", id: updateId },
      state: "active",
      prior_state: null,
      owner_kind: "operator",
      title: model.lane.title,
      ts: at,
    },
  };
}

test("updates join audit summaries, then published text, then kind/time without invented prose", async () => {
  const data = show({
    updates: ["audit", "published", "metadata"].map((id, index) => ({
      update_id: id,
      kind: "milestone",
      event_id: index + 1,
      ts: `2026-01-02T00:00:0${3 - index}.000Z`,
    })),
    events: [
      {
        event_id: "audit-1",
        lane_id: model.lane.lane_id,
        operation: "publish",
        update_id: "audit",
        created_at: "2026-01-02T00:00:03.000Z",
        payload: { summary: "Audit publication text" },
      },
    ],
  });
  const readShow = jest.fn().mockResolvedValue(data);
  const view = render(
    tree(readShow, {
      updates: [
        published("audit", "Thread alternative"),
        published("published", "Typed thread publication"),
        published("metadata", "Other lane text", "wl-other"),
      ],
    }),
  );
  await act(async () => {});
  expect(readShow).toHaveBeenCalledWith(model.lane.lane_id);
  expect(
    within(view.getByTestId("lane-log-row-0")).getByText(
      "Audit publication text",
    ),
  ).toBeTruthy();
  expect(
    within(view.getByTestId("lane-log-row-1")).getByText(
      "Typed thread publication",
    ),
  ).toBeTruthy();
  expect(
    within(view.getByTestId("lane-log-row-2")).getByText(
      "milestone · 2026-01-02T00:00:01.000Z",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Thread alternative")).toBeNull();
  expect(view.queryByText("Other lane text")).toBeNull();
  expect(
    view.getByTestId("lane-log-tab-updates").props.accessibilityState.selected,
  ).toBe(true);
});

test("a typed publication arriving while the log is open updates its matching row without a refetch", async () => {
  const data = show({
    updates: [{ update_id: "later", kind: "milestone", ts: at }],
  });
  const readShow = jest.fn().mockResolvedValue(data);
  const view = render(tree(readShow));
  await act(async () => {});
  expect(view.getByText(`milestone · ${at}`)).toBeTruthy();
  view.rerender(
    tree(readShow, {
      updates: [published("later", "Fresh typed publication")],
    }),
  );
  expect(view.getByText("Fresh typed publication")).toBeTruthy();
  expect(view.queryByText(`milestone · ${at}`)).toBeNull();
  expect(readShow).toHaveBeenCalledTimes(1);
});

test("duplicate typed publications keep the newest summary for an update identity", async () => {
  const data = show({
    updates: [{ update_id: "repeated", kind: "milestone", ts: at }],
  });
  const newest = published("repeated", "Newest published summary");
  newest.event = { ...newest.event, daemon_seq: 20 };
  const oldest = published("repeated", "Older published summary");
  oldest.event = { ...oldest.event, daemon_seq: 10 };
  const view = render(
    tree(jest.fn().mockResolvedValue(data), { updates: [newest, oldest] }),
  );
  await act(async () => {});
  expect(view.getByText("Newest published summary")).toBeTruthy();
  expect(view.queryByText("Older published summary")).toBeNull();
});

test("spec changes expand changed status, AC and estimate with member titles; events stay separate", async () => {
  const data = show({
    events: [
      {
        event_id: "event-1",
        operation: "item_change",
        created_at: at,
        payload: {
          spec_id: model.members[0].spec_id,
          obs_rev: 2,
          prior: {
            status: "in_progress",
            ac_checked: 1,
            ac_total: 2,
            estimate: { p25: 2, p75: 4, median: 3 },
          },
          next: {
            status: "needs_qa",
            ac_checked: 2,
            ac_total: 2,
            estimate: null,
          },
        },
      },
      {
        event_id: "event-2",
        operation: "pause",
        created_at: at,
        payload: { summary: "Sample pause event" },
      },
      { event_id: "event-3", operation: "resume", created_at: at, payload: {} },
    ],
  });
  const view = render(tree(jest.fn().mockResolvedValue(data)));
  await act(async () => {});
  expect(view.getByTestId("lane-log-empty")).toHaveTextContent("No updates");
  fireEvent.press(view.getByTestId("lane-log-tab-spec-changes"));
  expect(
    view.getByTestId("lane-log-tab-spec-changes").props.accessibilityState
      .selected,
  ).toBe(true);
  expect(
    view.getByTestId("lane-log-tab-updates").props.accessibilityState.selected,
  ).toBe(false);
  expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(3);
  expect(view.getAllByText("Model bridge 1")).toHaveLength(3);
  expect(view.getByText("status")).toBeTruthy();
  expect(view.getByLabelText(/in_progress → needs_qa$/)).toBeTruthy();
  expect(view.getByText("ac")).toBeTruthy();
  expect(view.getByLabelText(/1\/2 → 2\/2$/)).toBeTruthy();
  expect(view.getByText("estimate")).toBeTruthy();
  expect(view.getByText("2–4 h (median 3)")).toBeTruthy();
  expect(view.getByLabelText(/2–4 h \(median 3\) → —$/)).toBeTruthy();
  fireEvent.press(view.getByTestId("lane-log-tab-events"));
  expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(2);
  expect(
    within(view.getByTestId("lane-log-row-0")).getByText(`resume · ${at}`),
  ).toBeTruthy();
  expect(
    within(view.getByTestId("lane-log-row-1")).getByText("Sample pause event"),
  ).toBeTruthy();
  expect(view.queryByText("item_change")).toBeNull();
  expect(view.queryByLabelText(/in_progress → needs_qa$/)).toBeNull();
});

test.each(["updates", "spec-changes", "events"] as const)(
  "%s is newest-first and bounded to 50 rows on every client page",
  async (tab) => {
    const stamp = (index: number) =>
      new Date(Date.parse(at) + index * 1000).toISOString();
    const events = Array.from({ length: 103 }, (_, index) => ({
      event_id: `event-${String(index).padStart(3, "0")}`,
      created_at: stamp(index),
      operation: tab === "spec-changes" ? "item_change" : "publish",
      update_id: `update-${index}`,
      payload:
        tab === "spec-changes"
          ? {
              spec_id: model.members[0].spec_id,
              prior: {
                status: `before-${index}`,
                ac_checked: 0,
                ac_total: 1,
                estimate: null,
              },
              next: {
                status: `after-${index}`,
                ac_checked: 0,
                ac_total: 1,
                estimate: null,
              },
            }
          : { summary: `Sample row ${index}` },
    }));
    const data = show({
      events,
      updates:
        tab === "updates"
          ? events.map((event) => ({
              update_id: event.update_id,
              kind: "milestone",
              ts: event.created_at,
            }))
          : [],
    });
    const readShow = jest.fn().mockResolvedValue(data);
    const view = render(tree(readShow));
    await act(async () => {});
    fireEvent.press(view.getByTestId(`lane-log-tab-${tab}`));
    expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(50);
    const label = (index: number) =>
      tab === "spec-changes"
        ? `before-${index} → after-${index}`
        : `Sample row ${index}`;
    const assertRow = (index: number, content: string) => {
      const row = view.getByTestId(`lane-log-row-${index}`);
      if (tab === "spec-changes")
        expect(row.props.accessibilityLabel).toContain(content);
      else expect(within(row).getByText(content)).toBeTruthy();
    };
    assertRow(0, label(102));
    assertRow(49, label(53));
    fireEvent.press(view.getByTestId("lane-log-older"));
    expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(50);
    expect(view.queryByTestId("lane-log-row-0")).toBeNull();
    assertRow(50, label(52));
    fireEvent.press(view.getByTestId("lane-log-older"));
    expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(3);
    assertRow(102, label(0));
    expect(view.queryByTestId("lane-log-older")).toBeNull();
    fireEvent.press(
      view.getByTestId(
        `lane-log-tab-${tab === "events" ? "updates" : "events"}`,
      ),
    );
    fireEvent.press(view.getByTestId(`lane-log-tab-${tab}`));
    expect(view.getByTestId("lane-log-row-0")).toBeTruthy();
    expect(view.getAllByTestId(/^lane-log-row-/)).toHaveLength(50);
    expect(readShow.mock.calls).toEqual([[model.lane.lane_id]]);
  },
);

test("legacy projection last-update supplies metadata when show has no updates", async () => {
  const legacy = selectLaneCardViewModels(
    applyWorkLanesInventory(
      initialPentacleStreamState,
      fixture.inventory_frame,
    ),
  )[0];
  const readShow = jest
    .fn()
    .mockResolvedValue(
      show({
        projection: legacy.lane,
        lane: { lane_id: legacy.lane.lane_id },
        members: [],
      }),
    );
  const view = render(tree(readShow, { model: legacy }));
  await act(async () => {});
  expect(
    view.getByText(
      `${legacy.lane.last_update!.kind} · ${legacy.lane.last_update!.ts}`,
    ),
  ).toBeTruthy();
  expect(view.queryByTestId("lane-log-empty")).toBeNull();
});

test.each(["updates", "spec-changes", "events"])(
  "%s has an explicit empty state and accessible Back",
  async (tab) => {
    const onBack = jest.fn();
    const view = render(tree(jest.fn().mockResolvedValue(show()), { onBack }));
    await act(async () => {});
    fireEvent.press(view.getByTestId(`lane-log-tab-${tab}`));
    expect(view.getByTestId("lane-log-empty")).toBeTruthy();
    expect(view.queryByTestId("lane-log-older")).toBeNull();
    expect(view.getByTestId("lane-log-back").props.accessibilityRole).toBe(
      "button",
    );
    fireEvent.press(view.getByTestId("lane-log-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  },
);

test.each([
  [new Error("not_found"), "Lane details unavailable"],
  [
    Object.assign(new Error("no response"), { errorCode: "timeout" }),
    "Request timed out",
  ],
  [
    Object.assign(new Error("no response"), { errorCode: "request_timeout" }),
    "Request timed out",
  ],
])(
  "show rejection displays a recoverable notice and Retry fetches the current lane",
  async (failure, notice) => {
    const readShow = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(show());
    const view = render(tree(readShow));
    await act(async () => {});
    expect(view.getByTestId("lane-log-error")).toBeTruthy();
    expect(view.getByText(notice)).toBeTruthy();
    expect(view.queryByTestId("lane-log-empty")).toBeNull();
    expect(view.queryByTestId("lane-log-loading")).toBeNull();
    await act(async () => {
      fireEvent.press(view.getByTestId("lane-log-retry"));
    });
    expect(view.queryByTestId("lane-log-error")).toBeNull();
    expect(view.getByTestId("lane-log-empty")).toBeTruthy();
    expect(readShow.mock.calls).toEqual([
      [model.lane.lane_id],
      [model.lane.lane_id],
    ]);
  },
);

test("offline waits without showing an empty log and reconnect fetches", async () => {
  const readShow = jest.fn().mockResolvedValue(show());
  const view = render(tree(readShow, { connected: false }));
  expect(readShow).not.toHaveBeenCalled();
  expect(view.getByText("Waiting for connection…")).toBeTruthy();
  expect(view.queryByTestId("lane-log-empty")).toBeNull();
  view.rerender(tree(readShow));
  await act(async () => {});
  expect(readShow).toHaveBeenCalledTimes(1);
  expect(view.getByTestId("lane-log-empty")).toBeTruthy();
});

test.each(["resolve", "reject"] as const)(
  "disconnect mid-read ignores late %s, then reconnect shows only fresh rows",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const fresh = show({
      updates: [{ update_id: "fresh", kind: "milestone", ts: at }],
    });
    const readShow = jest
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(fresh);
    const view = render(tree(readShow));
    expect(view.getByTestId("lane-log-loading")).toBeTruthy();
    expect(readShow).toHaveBeenCalledTimes(1);
    view.rerender(tree(readShow, { connected: false }));
    await act(async () => {
      if (settle === "resolve") pending.resolve(show());
      else pending.reject(new Error("stale failure"));
    });
    expect(view.queryByTestId("lane-log-loading")).toBeNull();
    expect(view.queryByTestId("lane-log-error")).toBeNull();
    expect(view.queryByTestId("lane-log-empty")).toBeNull();
    view.rerender(tree(readShow));
    await act(async () => {});
    expect(view.getByText(`milestone · ${at}`)).toBeTruthy();
    expect(readShow).toHaveBeenCalledTimes(2);
  },
);

test.each(["resolve", "reject"] as const)(
  "changing lane mid-read ignores old lane late %s",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const next = {
      ...model,
      lane: { ...model.lane, lane_id: "wl-next", title: "Next lane" },
    };
    const readShow = jest
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        show({
          projection: next.lane,
          lane: { lane_id: next.lane.lane_id },
          updates: [{ update_id: "next", kind: "lane_started", ts: at }],
        }),
      );
    const view = render(tree(readShow));
    expect(view.getByTestId("lane-log-loading")).toBeTruthy();
    view.rerender(tree(readShow, { model: next }));
    await act(async () => {});
    await act(async () => {
      if (settle === "resolve") pending.resolve(show());
      else pending.reject(new Error("stale failure"));
    });
    expect(view.getByTestId("lane-log-wl-next")).toBeTruthy();
    expect(view.getByText(`lane_started · ${at}`)).toBeTruthy();
    expect(view.queryByTestId("lane-log-error")).toBeNull();
    expect(readShow.mock.calls).toEqual([[model.lane.lane_id], ["wl-next"]]);
  },
);

test.each(["resolve", "reject"] as const)(
  "unmount with a pending read discards late %s safely",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const readShow = jest.fn().mockReturnValue(pending.promise);
    const view = render(tree(readShow));
    expect(readShow).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("lane-log-loading")).toBeTruthy();
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      view.unmount();
      await act(async () => {
        if (settle === "resolve") pending.resolve(show());
        else pending.reject(new Error("late failure"));
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  },
);
