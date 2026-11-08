import { initialPentacleStreamState, type WorkLane, type PentacleStreamState } from 'pentacle-chat-core';
import { ASSISTANT_STREAM_ID } from '../../src/services/assistantIdentity';
import { questionSourceLane } from '../../src/components/questions/questionSourceLane';

const lane = (patch: Partial<WorkLane> = {}) => ({ lane_id: 'lane-a', title: 'Sample lane', members: [], members_total: 0, ...patch }) as WorkLane;
const state = (lanes: WorkLane[]) => ({ ...initialPentacleStreamState, workLanes: { lanes, counts: { open: lanes.length, active: lanes.length, paused: 0, blocked: 0 }, truncated: false, generated_at: '' } }) as PentacleStreamState;
const member = (id: string) => ({ spec_id: id, seats: [], seats_total: 0 });

test('lead match takes precedence over an earlier inline seat match', () => {
  const seat = lane({ lane_id: 'seat', members: [{ ...member('spec-a'), seats: [{ stream_id: 'host:target' } as any] }] });
  const lead = lane({ lead: { stream_id: 'host:target' } as any });
  expect(questionSourceLane(state([seat, lead]), 'host:target')).toBe(lead);
  expect(questionSourceLane(state([seat]), 'host:target')).toBe(seat);
});
test('assistant and complete carried inventories with no match return none', () => {
  expect(questionSourceLane(state([lane()]), 'host:missing')).toBe('none');
  expect(questionSourceLane(state([lane({ members_total: 9 })]), ASSISTANT_STREAM_ID)).toBe('none');
});
test('a ninth uncarried member returns unknown without fetching', () => {
  expect(questionSourceLane(state([lane({ members: Array.from({ length: 8 }, (_, i) => member(`spec-${i}`)), members_total: 9 })]), 'host:ninth')).toBe('unknown');
});
test('a ninth uncarried seat returns unknown without fetching', () => {
  expect(questionSourceLane(state([lane({ members: [{ ...member('spec-a'), seats: Array.from({ length: 8 }, (_, i) => ({ stream_id: `host:${i}` } as any)), seats_total: 9 }], members_total: 1 })]), 'host:ninth')).toBe('unknown');
});
