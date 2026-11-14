jest.mock("expo-constants", () => require("./helpers/stubs/expoConstants.cjs"));
import {
  laneIconFor,
  LANE_ICON_KEYS,
  type WorkLane,
  type WorkLaneMember,
} from "pentacle-chat-core";
import {
  laneFlowGroup,
  laneWorking,
  laneRingOrder,
  laneOrbits,
  specGroups,
  resolveLaneIcon,
  specDetailModel,
} from "../src/services/workLanes";
import { firstSummarySentence } from "../src/services/summaryProse";
const source =
  require("../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json")
    .progress_v2[0].frame.lanes[0] as WorkLane;
const now = Date.parse("2026-01-20T00:00:00Z");
const lane = (id: string, override: Partial<WorkLane> = {}): WorkLane => ({
  ...source,
  lane_id: id,
  state: "active",
  members: [],
  last_update: null,
  updated_at: "2026-01-19T00:00:00Z",
  ...override,
});
test("classification follows stream members and lead presence, never live-seat count", () => {
  expect(laneWorking(lane("a", { lead: null }))).toBe(false);
  const working = lane("b", {
    lead: null,
    members: [
      {
        spec_id: "s",
        seats: [
          {
            stream_id: "sample",
            activity: "working",
            role: "lead",
            host: "hosta",
            visibility: "hidden",
            last_activity: null,
          },
        ],
      },
    ],
  });
  expect(laneWorking(working)).toBe(true);
  expect(laneFlowGroup(working)).toBe("working");
  expect(laneFlowGroup(lane("c", { state: "blocked" }))).toBe("needsYou");
  expect(
    laneFlowGroup(
      lane("d", {
        members: [
          {
            spec_id: "s",
            open_questions: { count: 1, first_question_id: "q" },
          },
        ],
      }),
    ),
  ).toBe("needsYou");
  expect(laneFlowGroup(lane("e", { state: "paused" }))).toBe("paused");
});
test.each([1, 2, 6, 7, 14])(
  "%i lanes keep exactly the first six sorted active lanes inside",
  (n) => {
    const rows = Array.from({ length: n }, (_, i) =>
      lane(`lane-${String(i).padStart(2, "0")}`),
    ).reverse();
    expect(laneOrbits(rows, now).inner.map((l) => l.lane_id)).toEqual(
      laneRingOrder(rows)
        .slice(0, 6)
        .map((l) => l.lane_id),
    );
    expect(laneOrbits(rows, now).overflow).toHaveLength(Math.max(0, n - 6));
  },
);
test("rank precedes timestamp; timestamp precedes lane id", () => {
  const rows = [
    lane("b"),
    lane("a"),
    lane("blocked", { state: "blocked", updated_at: "2026-01-01" }),
    lane("new", {
      last_update: {
        ts: "2026-01-20",
        update_id: "u",
        kind: "milestone",
        event_id: 1,
      },
    }),
  ];
  expect(laneRingOrder(rows).map((l) => l.lane_id)).toEqual([
    "blocked",
    "new",
    "a",
    "b",
  ]);
});
test("paused boundary is 14 days and uses last update before updated_at", () => {
  const ago = (h: number) => new Date(now - h * 3600000).toISOString();
  const rows = [
    lane("recent", { state: "paused", updated_at: ago(14 * 24 - 1) }),
    lane("dormant", { state: "paused", updated_at: ago(14 * 24 + 1) }),
    lane("update", {
      state: "paused",
      updated_at: ago(500),
      last_update: {
        ts: ago(1),
        update_id: "u",
        kind: "milestone",
        event_id: 1,
      },
    }),
  ];
  expect(laneOrbits(rows, now).dormant.map((l) => l.lane_id)).toEqual([
    "dormant",
  ]);
  expect(laneOrbits(rows, now).paused.map((l) => l.lane_id)).toEqual([
    "update",
    "recent",
  ]);
});
test("27 specs group by source state; deprecated folds with done", () => {
  const statuses = [
    ...Array(6).fill("in_progress"),
    ...Array(2).fill("ready_for_dev"),
    ...Array(7).fill("backlog"),
    ...Array(11).fill("completed"),
    "deprecated",
  ];
  const groups = specGroups(
    statuses.map((status, i) => ({ spec_id: `s-${i}`, status })),
  );
  expect(Object.values(groups).map((rows) => rows.length)).toEqual([
    6, 2, 7, 12, 0,
  ]);
  expect(specGroups([{ spec_id: "a", status: "analysis" }]).ready).toHaveLength(
    1,
  );
});
test("stream icon wins; ordered keyword fallback; final two-letter monogram", () => {
  expect(LANE_ICON_KEYS).toHaveLength(24);
  expect(laneIconFor("Mobile test infrastructure")).toBe("phone");
  expect(resolveLaneIcon(lane("a", { title: "Phone", icon: "leaf" }))).toEqual({
    key: "leaf",
    monogram: "PH",
  });
  expect(
    resolveLaneIcon(lane("a", { title: "Silver orchard", icon: "unknown" })),
  ).toEqual({ key: null, monogram: "SO" });
});
test("status and next use presence, including explicit null; older streams alone use guard", () => {
  const m: WorkLaneMember = {
    spec_id: "a",
    status_text: "Ready. Another sentence.",
    next_action_text: "Check the sheet.",
    status_line: null,
    next_line: "Exact stream line.",
  };
  expect(specDetailModel(m).status).toBeNull();
  expect(specDetailModel(m).next).toBe("Exact stream line.");
  delete m.status_line;
  expect(specDetailModel(m).status).toBe("Ready.");
  m.status_text = "Candidate deadbeef is ready.";
  expect(specDetailModel(m).status).toBeNull();
});
test.each(
  require("../pentacle-chat-core/tests/fixtures/summary_prose_cases.json")
    .cases as Array<{
    name: string;
    label: string | null;
    daemon_line: string | null;
  }>,
)("shared prose: $name", (c) => {
  const rules = require("../pentacle-chat-core/tests/fixtures/summary_prose_cases.json");
  const raw = c.label?.match(new RegExp(rules.patterns.label))?.[2];
  expect(firstSummarySentence(raw)).toBe(c.daemon_line);
});
