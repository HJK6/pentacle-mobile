import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeWorkLanesInventory, parseWorkLaneShow } from '../src/index.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-lanes-inventory.json', import.meta.url), 'utf8'));
const frame = fixture.progress_v2[0].frame;
const revision = 'a'.repeat(64);
const goal = { goal_id: 'g_sample', title: 'Sample outcome', state: 'in_progress', done: 2, total: 5, rank: 1, icon: 'flask', target_date: '2026-12-01' };
const lane = { ...frame.lanes[0], goals: [goal], goals_total: 1, default_goal: { state: 'not_started', done: 0, total: 3 }, detail_revision: revision,
  members: frame.lanes[0].members.map((m: object) => ({ ...m, goal_id: 'g_sample' })) };
test('goal fields, optional icons, member identity and detail revision survive inventory and show', () => {
  const normalized = normalizeWorkLanesInventory({ ...frame, lanes: [lane] })!;
  assert.deepEqual(normalized.lanes[0], lane);
  const show = parseWorkLaneShow({ lane: { lane_id: lane.lane_id }, projection: lane, members: lane.members,
    members_total: 65, members_next: lane.members.at(-1).spec_id, detail_revision: revision })!;
  assert.ok(show); assert.equal(show.members_total, 65); assert.equal(show.members_next, lane.members.at(-1).spec_id);
  assert.equal(show.detail_revision, revision); assert.deepEqual(show.projection?.goals, [goal]);
  for (const icon of [null, undefined]) {
    const { icon: _icon, ...withoutIcon } = goal;
    const next = icon === undefined ? withoutIcon : { ...goal, icon };
    assert.deepEqual(normalizeWorkLanesInventory({ ...frame, lanes: [{ ...lane, goals: [next] }] })!.lanes[0].goals, [next]);
  }
});
test('legacy show preserves absence, explicit null cursor is terminal', () => {
  const raw = { lane: { lane_id: lane.lane_id }, members: lane.members };
  const legacy = parseWorkLaneShow(raw)!;
  assert.ok(legacy); assert.equal(Object.hasOwn(legacy, 'members_next'), false);
  assert.equal(Object.hasOwn(legacy, 'members_total'), false);
  assert.equal(parseWorkLaneShow({ ...raw, members_total: lane.members.length, members_next: null, detail_revision: revision })!.members_next, null);
});
test('malformed new pagination never silently becomes a legacy response', () => {
  const raw = { lane: { lane_id: lane.lane_id }, members: lane.members, members_total: 65, members_next: 'spec_next', detail_revision: revision };
  for (const patch of [{ members_total: -1 }, { members_total: '65' }, { members_total: undefined }, { members_next: undefined }, { members_next: '' },
    { members_next: 3 }, { detail_revision: undefined }, { detail_revision: 'short' }, { members: 'bad' }, { projection: { ...lane, detail_revision: 'b'.repeat(64) } }])
    assert.equal(parseWorkLaneShow({ ...raw, ...patch }), null, JSON.stringify(patch));
});
test('invalid optional goals are absent; malformed values cannot create completion', () => {
  for (const patch of [{ state: 'unknown' }, { done: 9 }, { total: -1 }, { rank: '1' }]) {
    const result = normalizeWorkLanesInventory({ ...frame, lanes: [{ ...lane, goals: [{ ...goal, ...patch }] }] })!.lanes[0];
    assert.equal(Object.hasOwn(result, 'goals'), false);
  }
});
