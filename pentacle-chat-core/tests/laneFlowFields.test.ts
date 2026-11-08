import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeWorkLanesInventory,
  parseWorkLaneShow,
} from "../src/services/workLanes";
import { laneIconFor, LANE_ICON_KEYS } from "../src/services/laneIcons";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/work-lanes-inventory.json", import.meta.url),
    "utf8",
  ),
);
const base = fixture.progress_v2[0].frame.lanes[0];
const full = {
  spec_id: "spec_sample__flow",
  title: "Sample flow",
  status: "in_progress",
  worked: {
    elapsed_h: null,
    censored: true,
    active_h: 0.3,
    seats: 2,
    qa_rounds: 1,
    as_of: "2026-01-02T00:00:00Z",
  },
  criteria: [
    { title: "Restore the original position", disposition: "open" },
    { title: "Keep `source` visible", disposition: "done" },
  ],
  transitions: [
    { status: "backlog", at: "2026-01-01" },
    { status: "in_progress", at: "2026-01-02" },
  ],
  lead_seat: {
    stream_id: "hosta:lead",
    host: "hosta",
    provider: null,
    activity: "working",
    eta_at: null,
    active_step: "Review the screen",
  },
  status_line: null,
  next_line: "Check the screen.",
};
test("optional cut-A wire fields survive the real inventory and show normalizers", () => {
  const inventory = normalizeWorkLanesInventory({
    lanes: [{ ...base, icon: "phone", members: [full] }],
  })!;
  assert.equal(inventory.lanes[0].icon, "phone");
  assert.deepEqual(inventory.lanes[0].members![0], full);
  const show = parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: base.lane_id },
    projection: base,
    members: [full],
    updates: [],
    events: [],
  })!;
  assert.deepEqual(show.members[0], full);
});
test("absent stays absent, explicit null stays null, malformed optional fields do not invalidate legacy membership", () => {
  const member = (extra: object) =>
    normalizeWorkLanesInventory({
      lanes: [{ ...base, members: [{ spec_id: "s", ...extra }] }],
    })!.lanes[0].members![0];
  assert.deepEqual(member({}), { spec_id: "s" });
  assert.deepEqual(
    member({
      worked: null,
      lead_seat: null,
      status_line: null,
      next_line: null,
    }),
    {
      spec_id: "s",
      worked: null,
      lead_seat: null,
      status_line: null,
      next_line: null,
    },
  );
  assert.deepEqual(
    member({
      worked: { ...full.worked, active_h: -1 },
      criteria: [{ title: "bad", disposition: "invented" }],
      transitions: [{ status: 1 }],
      lead_seat: {},
      status_line: 8,
      next_line: false,
    }),
    { spec_id: "s" },
  );
});
test("twenty icon keys and ordered keyword matching come from the one JSON file", () => {
  const table = JSON.parse(
    readFileSync(new URL("../lane_icons.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    LANE_ICON_KEYS,
    table.icons.map((row: { key: string }) => row.key),
  );
  assert.equal(new Set(LANE_ICON_KEYS).size, 20);
  assert.equal(laneIconFor("MOBILE test tools"), "phone");
  assert.equal(laneIconFor("Unrecognised orchard"), null);
});
