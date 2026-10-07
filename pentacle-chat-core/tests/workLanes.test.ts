import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyPentacleSnapshotMessage,
  applyWorkLanesInventory,
  initialPentacleStreamState,
  normalizeWorkLanesInventory,
  parseLaneUpdateEvent,
  resolveWorkLaneTap,
  selectOpenLaneCount,
  selectWorkLanes,
  type PentacleEvent,
} from '../src/index.ts';

// Shared parity fixture ("work lanes projection v1"): the daemon Python test and
// both client chat-core suites assert against this one file.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-lanes-inventory.json', import.meta.url), 'utf8'));

test('inventory frame normalizes to the fixture lanes in server order with no reordering', () => {
  const inventory = normalizeWorkLanesInventory(fixture.inventory_frame);
  assert.ok(inventory);
  assert.deepEqual(inventory.lanes.map((lane) => lane.lane_id), fixture.expected.order);
  assert.deepEqual(inventory.lanes, fixture.inventory_frame.lanes);
  assert.equal(inventory.counts.open, fixture.expected.header_count);
  assert.equal(inventory.truncated, false);
});

test('hello work_lanes field and push frame produce the same state', () => {
  const pushed = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);
  const hello = applyPentacleSnapshotMessage(initialPentacleStreamState, {
    sessions: [],
    work_lanes: fixture.hello_field.work_lanes,
  });
  assert.deepEqual(selectWorkLanes(hello), selectWorkLanes(pushed));
  assert.equal(selectOpenLaneCount(hello), fixture.expected.header_count);
});

test('a snapshot without work_lanes keeps the last lane inventory', () => {
  const pushed = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);
  const next = applyPentacleSnapshotMessage(pushed, { sessions: [] });
  assert.equal(selectOpenLaneCount(next), fixture.expected.header_count);
});

test('header count is counts.open, never derived from sessions', () => {
  assert.equal(selectOpenLaneCount(initialPentacleStreamState), 0);
  const state = applyWorkLanesInventory(initialPentacleStreamState, {
    ...fixture.inventory_frame,
    lanes: fixture.inventory_frame.lanes.slice(0, 2),
    counts: { open: 9, active: 1, paused: 2, blocked: 6 },
    truncated: true,
  });
  assert.equal(selectOpenLaneCount(state), 9);
  assert.equal(selectWorkLanes(state).length, 2);
});

test('done lanes never appear in the header list', () => {
  const done = { ...fixture.inventory_frame.lanes[0], lane_id: 'wl-done-x', state: 'done' };
  const inventory = normalizeWorkLanesInventory({
    ...fixture.inventory_frame,
    lanes: [done, ...fixture.inventory_frame.lanes],
  });
  assert.ok(inventory);
  assert.equal(inventory.lanes.some((lane) => lane.state === 'done'), false);
  assert.deepEqual(inventory.lanes.map((lane) => lane.lane_id), fixture.expected.order);
});

test('active without a qualifying lead presents paused unless blocked', () => {
  const base = fixture.inventory_frame.lanes[1];
  const unqualified = { ...base, lane_id: 'wl-x1', lead: { ...base.lead, qualifies: false } };
  const leadless = { ...base, lane_id: 'wl-x2', lead: null };
  const blocked = { ...fixture.inventory_frame.lanes[0], lane_id: 'wl-x3', lead: null };
  const inventory = normalizeWorkLanesInventory({
    ...fixture.inventory_frame, lanes: [unqualified, leadless, blocked],
  });
  assert.ok(inventory);
  const byId = Object.fromEntries(inventory.lanes.map((lane) => [lane.lane_id, lane]));
  assert.equal(byId['wl-x1'].state, 'paused');
  assert.equal(byId['wl-x1'].state_reason, 'lead_lost_unreconciled');
  assert.equal(byId['wl-x2'].state, 'paused');
  assert.equal(byId['wl-x3'].state, 'blocked');
});

test('malformed frames and lanes are rejected without throwing', () => {
  assert.equal(normalizeWorkLanesInventory(null), null);
  assert.equal(normalizeWorkLanesInventory({ type: 'work_lanes.inventory' }), null);
  const inventory = normalizeWorkLanesInventory({
    ...fixture.inventory_frame,
    lanes: [{ lane_id: 'bad' }, { ...fixture.inventory_frame.lanes[1], state: 'exploded' }, fixture.inventory_frame.lanes[1]],
  });
  assert.ok(inventory);
  assert.deepEqual(inventory.lanes.map((lane) => lane.lane_id), ['wl-active-0002']);
});

test('tap targets match the fixture per visible_chat.available', () => {
  const inventory = normalizeWorkLanesInventory(fixture.inventory_frame)!;
  for (const lane of inventory.lanes) {
    assert.deepEqual(resolveWorkLaneTap(lane), fixture.expected.tap[lane.lane_id], lane.lane_id);
  }
});

test('eta_stale comes from the daemon, not a client clock', () => {
  const inventory = normalizeWorkLanesInventory(fixture.inventory_frame)!;
  for (const lane of inventory.lanes) {
    assert.equal(lane.lead?.eta_stale ?? false, fixture.expected.eta_stale[lane.lane_id], lane.lane_id);
  }
});

test('lane_update events parse; unrelated events do not', () => {
  const events = fixture.lane_update_events.map((frame: { event: PentacleEvent }) => frame.event);
  const parsed = events.map((event: PentacleEvent) => parseLaneUpdateEvent(event));
  assert.ok(parsed.every((update: unknown) => update !== null));
  assert.deepEqual(parsed.map((update: { kind: string }) => update.kind),
    events.map((event: PentacleEvent) => (event.raw as any).lane_update.kind));
  assert.equal(parseLaneUpdateEvent({ ...events[0], publish_kind: 'status' }), null);
  assert.equal(parseLaneUpdateEvent({ ...events[0], raw: {} }), null);
  assert.equal(parseLaneUpdateEvent({ ...events[0], raw: { lane_update: { kind: 'worker_start' } } }), null);
});

test('an unsupported visible_chat.kind fails closed as unavailable, never a tap target', () => {
  const base = fixture.inventory_frame.lanes[0];
  for (const kind of [undefined, 'hidden', 7]) {
    const inventory = normalizeWorkLanesInventory({
      ...fixture.inventory_frame,
      lanes: [{ ...base, visible_chat: { ...base.visible_chat, kind, available: 'open' } }],
    });
    assert.ok(inventory);
    assert.equal(inventory.lanes.length, 1);
    assert.deepEqual(resolveWorkLaneTap(inventory.lanes[0]), { action: 'unavailable' });
  }
});

test('counts must be non-negative integers; a malformed inventory keeps the previous projection', () => {
  for (const open of [-1, 1.5, '4', Number.NaN]) {
    assert.equal(normalizeWorkLanesInventory({ ...fixture.inventory_frame, counts: { ...fixture.inventory_frame.counts, open } }), null);
  }
  const good = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);
  const bad = applyWorkLanesInventory(good, { ...fixture.inventory_frame, counts: { open: -1, active: 0, paused: 0, blocked: 0 } });
  assert.equal(selectOpenLaneCount(bad), fixture.expected.header_count);
  assert.ok(normalizeWorkLanesInventory({ ...fixture.inventory_frame, counts: undefined }));
});
