import React from "react";
import { render } from "@testing-library/react-native";
import { normalizeWorkLanesInventory } from "pentacle-chat-core";
import {
  MemberContent,
  memberSeatLines,
  memberWaitingOnYou,
} from "../../../src/components/lanes/LaneMemberDetail";

const fixture = require("../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json");

function member(extra: Record<string, unknown>) {
  const lane = JSON.parse(JSON.stringify(fixture.inventory_frame.lanes[1]));
  lane.members = [{ spec_id: "spec_demo__span", title: "Span", status: "in_progress", ...extra }];
  const inventory = normalizeWorkLanesInventory({ ...fixture.inventory_frame, lanes: [lane] });
  return inventory!.lanes[0].members![0];
}

test("seat lines and waiting-on-you come only from attributed fields", () => {
  const m = member({
    seats: [
      { stream_id: "hosta:lead", role: "lead", host: "hosta", visibility: "hidden", activity: "working" },
      { stream_id: "hosta:qa", role: "qa", host: "hostb", activity: "bogus" },
    ],
    seats_total: 4,
    open_questions: { count: 2, first_question_id: "q-1" },
  });
  expect(memberSeatLines(m)).toEqual(["LEAD · working · hosta", "QA · unknown · hostb", "+2 more"]);
  expect(memberWaitingOnYou(m)).toBe("WAITING ON YOU (2)");
  const view = render(<MemberContent member={m} />);
  expect(view.getByText("LEAD · working · hosta")).toBeTruthy();
  expect(view.getByText("WAITING ON YOU (2)")).toBeTruthy();
});

test("identical seat lines each render (two idle workers on one host)", () => {
  const worker = { role: "worker", host: "hosta", visibility: "hidden", activity: "idle" };
  const m = member({ seats: [{ stream_id: "hosta:w1", ...worker }, { stream_id: "hosta:w2", ...worker }], seats_total: 2 });
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<MemberContent member={m} />);
  expect(view.getAllByText("WORKER · idle · hosta")).toHaveLength(2);
  expect(errors.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
  errors.mockRestore();
});

test("an older daemon without attribution renders the existing row unchanged", () => {
  const m = member({});
  expect(memberSeatLines(m)).toEqual([]);
  expect(memberWaitingOnYou(m)).toBeNull();
  const view = render(<MemberContent member={m} />);
  expect(view.queryByTestId("member-attribution-spec_demo__span")).toBeNull();
});

test("an unqualified active lane presents the lead_lost fault, not a pause", () => {
  const lane = normalizeWorkLanesInventory(fixture.inventory_frame)!.lanes.find((l) => l.lane_id === "wl-paused-0004")!;
  expect([lane.state, lane.state_reason]).toEqual(["active", "lead_lost"]);
});
