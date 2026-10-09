import { laneTime } from "../../../src/components/lanes/LaneAtoms";
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
import { act, fireEvent, render } from "@testing-library/react-native";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  parseWorkLaneShow,
  type WorkLaneMember,
  type WorkLaneObservationQuality,
  type WorkLaneShow,
} from "pentacle-chat-core";
import LaneMembers from "../../../src/components/lanes/LaneMembers";
import LaneMemberDetail from "../../../src/components/lanes/LaneMemberDetail";
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
const frame = fixture.progress_v2.find(
  (entry: { name: string }) => entry.name === "active_progress",
).frame;
const baseModel = selectLaneCardViewModels(
  applyWorkLanesInventory(initialPentacleStreamState, frame),
)[0];
const allMembers: WorkLaneMember[] = Array.from({ length: 32 }, (_, index) => ({
  ...baseModel.members[0],
  spec_id: `spec_sample_${index + 1}`,
  title: `Sample spec ${index + 1}`,
}));
const overflowModel: LaneCardViewModel = {
  ...baseModel,
  lane: {
    ...baseModel.lane,
    members: allMembers.slice(0, 8),
    members_total: 32,
  },
  members: allMembers.slice(0, 8),
  membersTotal: 32,
};
function show(members = allMembers, model = overflowModel): WorkLaneShow {
  return parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: model.lane.lane_id },
    projection: { ...model.lane, members_total: members.length },
    members,
    events: [],
    updates: [],
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
  model = overflowModel,
  connected = true,
  onBack = jest.fn(),
  onOpenMember = jest.fn(),
) {
  return (
    <LaneMembers
      model={model}
      connected={connected}
      readShow={readShow}
      onBack={onBack}
      onOpenMember={onOpenMember}
    />
  );
}

test("fetches all 32 members once and keeps every accessible row in daemon membership order", async () => {
  const readShow = jest.fn().mockResolvedValue(show());
  const onOpenMember = jest.fn();
  const onBack = jest.fn();
  const view = render(
    tree(readShow, overflowModel, true, onBack, onOpenMember),
  );
  await act(async () => {});
  expect(readShow).toHaveBeenCalledTimes(1);
  expect(readShow).toHaveBeenCalledWith(overflowModel.lane.lane_id);
  expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32);
  const rows = view.getAllByTestId(/^lane-members-row-/);
  expect(rows.map((row) => row.props.testID)).toEqual(
    allMembers.map((member) => `lane-members-row-${member.spec_id}`),
  );
  for (const [index, row] of rows.entries()) {
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityLabel).toBe(
      `${allMembers[index].title}, in_progress`,
    );
    fireEvent.press(row);
    expect(onOpenMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ spec_id: allMembers[index].spec_id }),
    );
  }
  expect(onOpenMember).toHaveBeenCalledTimes(32);
  expect(view.queryByTestId("lane-members-back")).toBeNull();
  expect(onBack).not.toHaveBeenCalled();
});

test("uses complete inline membership without an RPC, including while disconnected", () => {
  const readShow = jest.fn();
  const view = render(tree(readShow, baseModel, false));
  expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(
    baseModel.members.length,
  );
  expect(readShow).not.toHaveBeenCalled();
  expect(view.queryByTestId("lane-members-loading")).toBeNull();
  expect(view.queryByText("Waiting for connection…")).toBeNull();
});

test.each<WorkLaneObservationQuality>([
  "fresh",
  "stale",
  "error",
  "missing",
  "ambiguous",
])(
  "member detail preserves %s observation quality, timestamps, errors, AC and next action",
  (quality) => {
    const observedAt = "2026-01-02T00:00:00.000Z";
    const member: WorkLaneMember = {
      ...baseModel.members[0],
      observation: {
        quality,
        observed_at: observedAt,
        error: quality === "error" ? "Sample source could not be read" : null,
      },
    };
    const onBack = jest.fn();
    const view = render(
      <LaneMemberDetail
        member={member}
        laneTitle={baseModel.lane.title}
        onBack={onBack}
      />,
    );
    expect(view.getByTestId(`member-detail-${member.spec_id}`)).toBeTruthy();
    expect(view.getByText("IN PROGRESS")).toBeTruthy();
    expect(view.getByText("1/2")).toBeTruthy();
    expect(view.getByText("2–4h")).toBeTruthy();
    expect(view.getByText("median 3h · provisional")).toBeTruthy();
    expect(view.getByText("Model prepared.")).toBeTruthy();
    expect(view.getByText("NEXT Inspect the paper span.")).toBeTruthy();
    expect(
      view.getByLabelText(`Spec ${member.spec_id}, observed ${observedAt}`),
    ).toBeTruthy();
    expect(
      view.getByLabelText(
        `CHANGED, source ${member.source_changed_at || "unknown"}`,
      ),
    ).toBeTruthy();
    if (quality === "fresh")
      expect(view.queryByText(/^FRESH · observed/)).toBeNull();
    else
      expect(
        view.getByText(
          `${quality.toUpperCase()} · observed ${laneTime(observedAt)}`,
        ),
      ).toBeTruthy();
    if (quality === "error")
      expect(view.getByText("Sample source could not be read")).toBeTruthy();
    fireEvent.press(view.getByTestId("member-detail-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  },
);

test.each(["missing_member", "ambiguous_member"])(
  "%s uses the spec id and honest unknown values",
  (name) => {
    const member: WorkLaneMember = fixture.progress_v2.find(
      (entry: { name: string }) => entry.name === name,
    ).frame.lanes[0].members[0];
    const view = render(
      <LaneMemberDetail
        member={member}
        laneTitle="Sample lane"
        onBack={jest.fn()}
      />,
    );
    expect(view.getAllByText(member.spec_id).length).toBeGreaterThan(0);
    expect(view.getAllByText("—")).toHaveLength(2);
    expect(
      view.getByText(
        `${member.observation!.quality.toUpperCase()} · observed unknown`,
      ),
    ).toBeTruthy();
    expect(view.getByText("unknown")).toBeTruthy();
    expect(view.queryByText(/^Median/)).toBeNull();
  },
);

test.each([
  [new Error("unknown_lane"), "Lane details unavailable"],
  [
    Object.assign(new Error("RPC expired"), { errorCode: "timeout" }),
    "Request timed out",
  ],
  [
    Object.assign(new Error("no response"), { errorCode: "request_timeout" }),
    "Request timed out",
  ],
])(
  "failed show renders an explicit notice and retries the same lane",
  async (failure, notice) => {
    const readShow = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(show());
    const view = render(tree(readShow));
    await act(async () => {});
    expect(view.getByTestId("lane-members-error")).toBeTruthy();
    expect(view.getByText(notice)).toBeTruthy();
    expect(view.queryByTestId("lane-members-loading")).toBeNull();
    expect(view.queryAllByTestId(/^lane-members-row-/)).toHaveLength(0);
    await act(async () => {
      fireEvent.press(view.getByLabelText("Retry members"));
    });
    expect(readShow.mock.calls).toEqual([
      [overflowModel.lane.lane_id],
      [overflowModel.lane.lane_id],
    ]);
    expect(view.queryByTestId("lane-members-error")).toBeNull();
    expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32);
  },
);

test("an incomplete full-member reply is explicit and Retry never silently accepts partial membership", async () => {
  const partial = show(allMembers.slice(0, 8));
  partial.projection!.members_total = 32;
  const readShow = jest
    .fn()
    .mockResolvedValueOnce(partial)
    .mockResolvedValueOnce(show());
  const view = render(tree(readShow));
  await act(async () => {});
  expect(view.getByTestId("lane-members-error")).toBeTruthy();
  expect(view.getByText("Incomplete member list. Please retry.")).toBeTruthy();
  expect(view.queryAllByTestId(/^lane-members-row-/)).toHaveLength(0);
  await act(async () => {
    fireEvent.press(view.getByLabelText("Retry members"));
  });
  expect(view.queryByTestId("lane-members-error")).toBeNull();
  expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32);
});

test("disconnected overflow waits without fetching; reconnect fetches the full list", async () => {
  const readShow = jest.fn().mockResolvedValue(show());
  const view = render(tree(readShow, overflowModel, false));
  expect(readShow).not.toHaveBeenCalled();
  expect(view.getByText("Waiting for connection…")).toBeTruthy();
  expect(view.queryByText("No specs")).toBeNull();
  view.rerender(tree(readShow));
  await act(async () => {});
  expect(readShow).toHaveBeenCalledTimes(1);
  expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32);
});

test.each(["resolve", "reject"] as const)(
  "disconnect mid-read discards late %s and reloads on reconnect",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const fresh = [{ ...allMembers[0], title: "Fresh member after reconnect" }];
    const readShow = jest
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(show(fresh));
    const view = render(tree(readShow));
    expect(readShow).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("lane-members-loading")).toBeTruthy();
    view.rerender(tree(readShow, overflowModel, false));
    await act(async () => {
      if (settle === "resolve") pending.resolve(show());
      else pending.reject(new Error("stale failure"));
    });
    expect(view.queryByTestId("lane-members-loading")).toBeNull();
    expect(view.queryByTestId("lane-members-error")).toBeNull();
    expect(view.queryAllByTestId(/^lane-members-row-/)).toHaveLength(0);
    expect(view.getByText("Waiting for connection…")).toBeTruthy();
    view.rerender(tree(readShow));
    await act(async () => {});
    expect(view.getByText("Fresh member after reconnect")).toBeTruthy();
    expect(readShow).toHaveBeenCalledTimes(2);
  },
);

test.each(["resolve", "reject"] as const)(
  "switching lane ignores previous lane late %s",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const next = {
      ...overflowModel,
      lane: { ...overflowModel.lane, lane_id: "wl-next", title: "Next lane" },
    };
    const readShow = jest
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        show([{ ...allMembers[0], title: "Current lane member" }], next),
      );
    const view = render(tree(readShow));
    expect(view.getByTestId("lane-members-loading")).toBeTruthy();
    view.rerender(tree(readShow, next));
    await act(async () => {});
    await act(async () => {
      if (settle === "resolve") pending.resolve(show());
      else pending.reject(new Error("stale failure"));
    });
    expect(readShow.mock.calls).toEqual([
      [overflowModel.lane.lane_id],
      ["wl-next"],
    ]);
    expect(view.getByText("Current lane member")).toBeTruthy();
    expect(view.queryByText("Sample spec 1")).toBeNull();
    expect(view.queryByTestId("lane-members-error")).toBeNull();
  },
);

test.each(["resolve", "reject"] as const)(
  "unmount during a real pending read ignores late %s",
  async (settle) => {
    const pending = deferred<WorkLaneShow>();
    const readShow = jest.fn().mockReturnValue(pending.promise);
    const view = render(tree(readShow));
    expect(readShow).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("lane-members-loading")).toBeTruthy();
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
