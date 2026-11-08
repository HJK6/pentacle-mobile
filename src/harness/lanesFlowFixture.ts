import type {
  WorkLane,
  WorkLaneMember,
  WorkLanesInventory,
  WorkLaneShow,
} from "pentacle-chat-core";

/** Synthetic 13-lane / 27-spec journey; the inventory deliberately inlines only eight specs. */
export function lanesFlowFixture(now = Date.now(), sparse = false) {
  const ago = (hours: number) => new Date(now - hours * 3600000).toISOString();
  const seats: NonNullable<WorkLaneMember["seats"]> = [
    {
      stream_id: "hosta:sample-lead",
      role: "lead",
      host: "hosta",
      visibility: "hidden",
      activity: "working",
      last_activity: ago(0),
    },
  ];
  const statuses = [
    "needs_qa",
    "blocked",
    "in_progress",
    "in_progress",
    "needs_qa",
    "analysis",
    "ready_for_dev",
    "analysis",
    ...Array<string>(7).fill("backlog"),
    ...Array<string>(11).fill("completed"),
    "deprecated",
  ];
  const members: WorkLaneMember[] = statuses.map((status, i) => ({
    spec_id: `spec_sample__flow_${i + 1}`,
    title:
      [
        "Test harness hardening",
        "Review the build window",
        "Inbound notification",
        "Shared cart count",
        "Round trip delivery",
        "Test cleanup plan",
      ][i] ?? `Sample spec ${i + 1}`,
    status,
    terminal: status === "completed" || status === "deprecated" ? status : null,
    ac_checked: status === "completed" ? 5 : i % 5,
    ac_total: 5,
    estimate: { p25: 2, p75: 4, median: 3, provisional: true },
    source_changed_at: ago(i / 60),
    status_text: "The screen is ready. Another sentence stays hidden.",
    next_action_text: "Check the lane navigation.",
    seats: i < 6 && i !== 1 ? seats : [],
    seats_total: i < 6 && i !== 1 ? 1 : 0,
    open_questions: { count: 0, first_question_id: null },
    ...(sparse
      ? {}
      : {
          status_line: "The screen is ready for review.",
          next_line: "Check the lane navigation.",
          worked: {
            elapsed_h: 2.4,
            censored: false,
            active_h: 0.3,
            seats: 6,
            qa_rounds: 2,
            as_of: ago(0),
          },
          criteria: [
            { title: "Progress stays visible", disposition: "done" as const },
            {
              title: "Navigate back without losing position",
              disposition: "open" as const,
            },
            {
              title: "Optional data stays optional",
              disposition: "done" as const,
            },
          ],
          transitions: [
            { status: "backlog", at: ago(48).slice(0, 10) },
            { status, at: ago(1).slice(0, 10) },
          ],
          lead_seat: {
            stream_id: "hosta:sample-lead",
            host: "hosta",
            provider: "codex",
            activity: "working" as const,
            eta_at: new Date(now + 3600000).toISOString(),
            active_step: "Final candidate review",
          },
        }),
  }));
  const titles = [
    "Deploy",
    "Mobile release",
    "Printer review",
    "Test infrastructure",
    "Pentacle mobile",
    "Web polish",
    "Pentacle",
    "3D printing",
    "Automation",
    "Camera",
    "Household",
    "Documentation",
    "Market review",
  ];
  const lanes: WorkLane[] = titles.map((title, i) => {
    const state = i < 2 ? "blocked" : i < 6 ? "active" : "paused";
    const laneMembers =
      i === 3
        ? members
        : [
            {
              ...members[2],
              spec_id: `spec_sample__lane_${i}`,
              seats: i >= 3 && i < 6 ? seats : [],
              open_questions: {
                count: i === 2 ? 1 : 0,
                first_question_id: i === 2 ? "sample-question" : null,
              },
            },
          ];
    return {
      lane_id: `sample-lane-${i + 1}`,
      title,
      summary: "A synthetic lane for interaction evidence.",
      state,
      state_reason: state === "active" ? "members_working" : state,
      blocker:
        i < 2
          ? "Waiting for a build window"
          : i === 2
            ? "Which review window?"
            : null,
      owner_kind: "operator",
      version: 1,
      updated_at: ago(i < 6 ? i / 60 : i < 9 ? (i - 5) * 24 : (i + 6) * 24),
      first_admitted_at: ago(500),
      done_at: null,
      lead:
        state === "active"
          ? {
              stream_id: "hosta:sample-lead",
              generation: "sample-generation",
              qualifies: true,
              status: "open",
              visibility: "hidden",
              presence: {
                online: true,
                working: i >= 3,
                capture_liveness: "live",
                last_activity: ago(0),
              },
              status_card: {
                goal: "Review the sample lane",
                active_step: "Check navigation",
                update: null,
                eta_at: null,
                eta_set_at: null,
                updated_at: ago(0),
              },
              eta_stale: false,
            }
          : null,
      visible_chat: {
        stream_id: "hosta:sample-chat",
        generation: "sample-generation",
        kind: "session",
        available: "open",
      },
      last_update:
        i < 6
          ? {
              update_id: `sample-update-${i}`,
              kind: "milestone",
              event_id: i,
              ts: ago(i / 60),
            }
          : null,
      members: laneMembers
        .slice(0, 8)
        .map(({ criteria, transitions, ...inline }) => inline),
      members_total: laneMembers.length,
      items_total: laneMembers.length,
      items_open: laneMembers.filter((m) => !m.terminal).length,
      items_completed: laneMembers.filter((m) => m.status === "completed")
        .length,
      items_dropped: laneMembers.filter((m) => m.status === "deprecated")
        .length,
      ac_checked: laneMembers.reduce((sum, m) => sum + (m.ac_checked ?? 0), 0),
      ac_total: laneMembers.length * 5,
      open_estimate_h: { p25: 20, p75: 46, median: 30 },
      estimate_complete: false,
      ...(sparse ? {} : { icon: i === 0 ? "rocket" : null }),
    };
  });
  const inventory: WorkLanesInventory = {
    lanes,
    counts: { open: 13, active: 4, blocked: 2, paused: 7 },
    truncated: false,
    generated_at: ago(0),
  };
  const shows: Record<string, WorkLaneShow> = Object.fromEntries(
    lanes.map((lane) => [
      lane.lane_id,
      {
        lane_id: lane.lane_id,
        projection: lane,
        members:
          lane.lane_id === "sample-lane-4" ? members : (lane.members ?? []),
        updates: [],
        spec_changes: [],
        events: [],
      },
    ]),
  );
  return {
    inventory,
    members,
    shows,
    zoomLaneId: "sample-lane-4",
    detailMember: {
      ...members[0],
      ...(sparse
        ? {}
        : {
            open_questions: { count: 1, first_question_id: "sample-question" },
          }),
    },
  };
}
