import type { WorkLaneMember } from 'pentacle-chat-core';
import { lanesFlowFixture } from './lanesFlowFixture';

/** One complete synthetic lane; the screenshot reader applies the actual bounded page contract. */
export function lanesPagingFixture(now = Date.now()) {
  const fixture = lanesFlowFixture(now), lane = fixture.inventory.lanes[0];
  const members: WorkLaneMember[] = Array.from({ length: 65 }, (_, i) => ({
    spec_id: `spec_sample_${String(i + 1).padStart(3, '0')}`,
    title: `Sample member ${i + 1}`, status: i < 32 ? 'completed' : 'in_progress',
    terminal: i < 32 ? 'completed' : null, ac_checked: i < 32 ? 4 : 1, ac_total: 4,
    goal_id: 'g_sample_paging',
  }));
  Object.assign(lane, { members: members.slice(0, 8), members_total: 65, items_total: 65,
    items_completed: 32, items_dropped: 0, detail_revision: 'a'.repeat(64),
    goals: [{ goal_id: 'g_sample_paging', title: 'Complete sample journey', state: 'in_progress', rank: 1, done: 32, total: 65 }],
    goals_total: 1,
  });
  fixture.inventory.lanes = [lane];
  fixture.shows = { [lane.lane_id]: { lane_id: lane.lane_id, projection: lane, members,
    members_total: 65, members_next: null, detail_revision: lane.detail_revision,
    updates: [], spec_changes: [], events: [] } };
  fixture.zoomLaneId = lane.lane_id;
  return fixture;
}
