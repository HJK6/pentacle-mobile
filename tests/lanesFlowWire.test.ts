import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyWorkLanesInventory,
  initialPentacleStreamState,
  parseWorkLaneShow,
} from "pentacle-chat-core";
import { lanesFlowFixture } from "../src/harness/lanesFlowFixture";
import { laneOrbits, laneFlowGroup } from "../src/services/workLanes";
import {
  seedScreenshotWorkLaneShows,
  readScreenshotWorkLaneShow,
} from "../src/harness/workLaneShows";
jest.mock("expo-constants", () => require("./helpers/stubs/expoConstants.cjs"));
test("the mobile prose fixture is byte-identical to the commissioned frozen source", () => {
  const bytes = readFileSync(
    join(
      __dirname,
      "../pentacle-chat-core/tests/fixtures/summary_prose_cases.json",
    ),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "551bba9bb3cc3c6452340b1e95b07cf937999a13611584b0bd7fe10b4b023fed",
  );
});
test("flow documentation describes the readable map and grouped list", () => {
  for (const file of ["assistant_and_lanes.md", "SCREENSHOT_HARNESS.md"]) {
    const text = readFileSync(join(__dirname, "../docs", file), "utf8");
    expect(text).toContain("readable");
    expect(text).not.toMatch(/List view|toggle in the lanes header/i);
  }
});
test.each([false, true])(
  "full/sparse fixture %s flows through the actual normalizer, with only eight inventory members and all 27 on show",
  async (sparse) => {
    const now = Date.now(),
      fixture = lanesFlowFixture(now, sparse);
    const state = applyWorkLanesInventory(
      initialPentacleStreamState,
      fixture.inventory,
    );
    const lanes = state.workLanes!.lanes;
    expect(lanes).toHaveLength(13);
    expect(lanes.filter((l) => laneFlowGroup(l) === "needsYou")).toHaveLength(
      3,
    );
    expect(lanes.filter((l) => laneFlowGroup(l) === "working")).toHaveLength(3);
    expect(laneOrbits(lanes, now).dormant).toHaveLength(4);
    expect(
      lanes.find((l) => l.lane_id === fixture.zoomLaneId)!.members,
    ).toHaveLength(8);
    expect(
      lanes.find((l) => l.lane_id === fixture.zoomLaneId)!.members![0],
    ).not.toHaveProperty("criteria");
    seedScreenshotWorkLaneShows(fixture.shows);
    const show = await readScreenshotWorkLaneShow(fixture.zoomLaneId);
    expect(show.members).toHaveLength(27);
    for (const field of [
      "worked",
      "lead_seat",
      "criteria",
      "transitions",
      "status_line",
      "next_line",
    ])
      expect(Object.prototype.hasOwnProperty.call(show.members[0], field)).toBe(
        !sparse,
      );
  },
);
test("spec log association survives normalization and never borrows another spec publication", () => {
  const fixture = lanesFlowFixture();
  const lane = fixture.inventory.lanes[3];
  const show = parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: lane.lane_id },
    projection: lane,
    members: fixture.members,
    updates: [
      {
        update_id: "sample-u",
        kind: "milestone",
        ts: "2026-01-02",
        spec_id: fixture.members[0].spec_id,
      },
    ],
    events: [
      {
        event_id: 1,
        operation: "update",
        created_at: "2026-01-02",
        update_id: "sample-u",
        payload: {
          summary: "A synthetic milestone.",
          spec_id: fixture.members[0].spec_id,
        },
      },
    ],
  })!;
  expect(show.updates.find((u) => u.update_id === "sample-u")?.spec_id).toBe(
    fixture.members[0].spec_id,
  );
  expect(show.updates.find((u) => u.update_id === "sample-u")?.summary).toBe(
    "A synthetic milestone.",
  );
});
