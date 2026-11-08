import { parseWorkLaneShow, type WorkLaneShow } from "pentacle-chat-core";
let shows: Record<string, WorkLaneShow> = {};
export function seedScreenshotWorkLaneShows(
  value: Record<string, WorkLaneShow> = {},
) {
  shows = value;
}
/** Screenshot counterpart for the daemon; the actual wire normalizer still runs. */
export async function readScreenshotWorkLaneShow(
  laneId: string,
): Promise<WorkLaneShow> {
  const show = shows[laneId];
  if (!show) throw new Error("No screenshot lane details");
  const result = parseWorkLaneShow({
    type: "work_lanes.show.ok",
    lane: { lane_id: laneId },
    ...show,
  });
  if (!result) throw new Error("Invalid screenshot lane details");
  return result;
}
