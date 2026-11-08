import type { PentacleStreamState, WorkLane } from 'pentacle-chat-core';
import { selectWorkLanes } from '../../services/workLanes';
import { ASSISTANT_STREAM_ID } from '../../services/assistantIdentity';

/** A bounded lookup over the carried inventory; missing capped seats never imply no lane. */
export function questionSourceLane(state: PentacleStreamState, streamId: string): WorkLane | 'none' | 'unknown' {
  const lanes = selectWorkLanes(state);
  const leadLane = lanes.find((lane) => lane.lead?.stream_id === streamId);
  if (leadLane) return leadLane;
  const memberLane = lanes.find((lane) => lane.members?.some((member) => member.seats?.some((seat) => seat.stream_id === streamId)));
  if (memberLane) return memberLane;
  if (streamId === ASSISTANT_STREAM_ID) return 'none';
  const truncated = lanes.some((lane) => (lane.members?.length ?? 0) < (lane.members_total ?? lane.members?.length ?? 0)
    || lane.members?.some((member) => (member.seats?.length ?? 0) < (member.seats_total ?? member.seats?.length ?? 0)));
  return truncated ? 'unknown' : 'none';
}
