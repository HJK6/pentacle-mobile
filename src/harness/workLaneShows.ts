import { parseWorkLaneShow, type WorkLaneShow, type WorkLaneShowOptions } from "pentacle-chat-core";
let shows: Record<string, WorkLaneShow> = {};
export function seedScreenshotWorkLaneShows(
  value: Record<string, WorkLaneShow> = {},
) {
  shows = value;
}
/** Screenshot counterpart for the daemon; the actual wire normalizer still runs. */
export async function readScreenshotWorkLaneShow(
  laneId: string,
  options: WorkLaneShowOptions = {},
): Promise<WorkLaneShow> {
  const show = shows[laneId];
  if (!show) throw new Error("No screenshot lane details");
  const all = options.goal_id ? show.members.filter(m => m.goal_id === options.goal_id) : show.members;
  const remaining = options.members_after ? all.filter(m => m.spec_id > options.members_after!) : all;
  const members = remaining.slice(0, options.members_limit ?? 32);
  const page = show.detail_revision ? {
    ...show, members, projection: show.projection ? { ...show.projection, members } : null,
    members_total: all.length,
    members_next: remaining.length > members.length ? members[members.length - 1].spec_id : null,
  } : show;
  const result = parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: laneId },
    ...page,
  });
  if (!result) throw new Error("Invalid screenshot lane details");
  return result;
}
