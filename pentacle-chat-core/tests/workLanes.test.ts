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

// Sweep matrix (QA r1): every present-but-invalid shape of every top-level and nested field.
const lane0 = () => fixture.inventory_frame.lanes[0];
const lane1 = () => fixture.inventory_frame.lanes[1];
const INVALID_SHAPES: unknown[] = [null, 7, 'x', true, [], {}];

test('sweep: present counts of any non-object shape, or missing any of the four counts, reject the inventory', () => {
  for (const counts of [null, 7, 'x', true, [], {}, { open: 4 }, { open: 4, active: 1, paused: 2 }]) {
    assert.equal(normalizeWorkLanesInventory({ ...fixture.inventory_frame, counts }), null, JSON.stringify(counts));
  }
  const good = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);
  const truncated = { ...fixture.inventory_frame, lanes: fixture.inventory_frame.lanes.slice(0, 2), truncated: true,
    counts: { open: 9, active: 1, paused: 2, blocked: 6 } };
  const withBadCounts = applyWorkLanesInventory(applyWorkLanesInventory(good, truncated), { ...truncated, counts: null });
  assert.equal(selectOpenLaneCount(withBadCounts), 9);
  const { counts: _omitted, ...withoutCounts } = fixture.inventory_frame;
  assert.equal(normalizeWorkLanesInventory(withoutCounts)?.counts.open, 4);
});

test('sweep: present non-boolean truncated and non-string generated_at reject the inventory', () => {
  for (const bad of [null, 1, 'yes', [], {}]) {
    assert.equal(normalizeWorkLanesInventory({ ...fixture.inventory_frame, truncated: bad }), null, `truncated ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, 7, [], {}]) {
    assert.equal(normalizeWorkLanesInventory({ ...fixture.inventory_frame, generated_at: bad }), null, `generated_at ${JSON.stringify(bad)}`);
  }
});

test('sweep: a present-but-invalid visible_chat keeps the lane and fails the tap closed', () => {
  const chats: unknown[] = [
    ...INVALID_SHAPES, { available: 'open' }, { stream_id: 's' }, { stream_id: 's', available: 'bogus' },
    { stream_id: 's', available: 'open', kind: 'nope' }, { stream_id: 7, available: 'open', kind: 'session' },
    { stream_id: 's', available: 'history', kind: 'session', generation: 7 },
  ];
  for (const visible_chat of chats) {
    const inventory = normalizeWorkLanesInventory({ ...fixture.inventory_frame, lanes: [{ ...lane0(), visible_chat }] });
    assert.ok(inventory, JSON.stringify(visible_chat));
    assert.equal(inventory.lanes.length, 1, JSON.stringify(visible_chat));
    assert.deepEqual(resolveWorkLaneTap(inventory.lanes[0]), { action: 'unavailable' }, JSON.stringify(visible_chat));
  }
});

test('sweep: a present-but-invalid lead never leaves a lane ACTIVE; blocked stays blocked', () => {
  for (const lead of [...INVALID_SHAPES, { stream_id: 7 }, { stream_id: '' }]) {
    const inventory = normalizeWorkLanesInventory({
      ...fixture.inventory_frame,
      lanes: [{ ...lane1(), lead }, { ...lane0(), lane_id: 'wl-b', lead }],
    });
    assert.ok(inventory, JSON.stringify(lead));
    const [active, blocked] = inventory.lanes;
    assert.equal(active.state, 'paused', JSON.stringify(lead));
    assert.equal(active.lead, null);
    assert.equal(blocked.state, 'blocked');
  }
  for (const nested of INVALID_SHAPES) {
    const inventory = normalizeWorkLanesInventory({
      ...fixture.inventory_frame,
      lanes: [{ ...lane1(), lead: { ...lane1().lead, presence: nested, status_card: nested } }],
    });
    const lead = inventory!.lanes[0].lead!;
    assert.equal(lead.presence.online, false, JSON.stringify(nested));
    assert.equal(lead.status_card.eta_at, null);
  }
});

test('sweep: invalid scalar lane fields take safe defaults without throwing or dropping the lane', () => {
  const bad = { ...lane0(), version: 'x', title: 5, summary: null, blocker: 7, updated_at: [], last_update: 'x' };
  const inventory = normalizeWorkLanesInventory({ ...fixture.inventory_frame, lanes: [bad] });
  assert.ok(inventory);
  const [lane] = inventory.lanes;
  assert.equal(lane.version, 0);
  assert.equal(lane.title, '');
  assert.equal(lane.blocker, null);
  assert.equal(lane.last_update, null);
});

test('sweep: a lane with an invalid identity, state or owner is dropped; duplicate lane ids keep the first', () => {
  const lanes = [
    { ...lane0(), lane_id: 7 }, { ...lane0(), lane_id: '' }, { ...lane0(), state: null }, { ...lane0(), owner_kind: 'x' },
    lane1(), { ...lane1(), title: 'duplicate must be ignored' }, 'x', null, [],
  ];
  const inventory = normalizeWorkLanesInventory({ ...fixture.inventory_frame, lanes });
  assert.ok(inventory);
  assert.deepEqual(inventory.lanes.map((lane) => lane.lane_id), ['wl-active-0002']);
  assert.equal(inventory.lanes[0].title, lane1().title);
});

test('sweep: lane_update parsing rejects every present-but-invalid nested shape without throwing', () => {
  const base = fixture.lane_update_events[0].event;
  const withUpdate = (patch: Record<string, unknown>) => ({ ...base, raw: { lane_update: { ...base.raw.lane_update, ...patch } } });
  for (const field of ['kind', 'update_id', 'lane_id', 'summary']) {
    for (const bad of [null, 7, [], {}]) {
      assert.equal(parseLaneUpdateEvent(withUpdate({ [field]: bad })), null, `${field} ${JSON.stringify(bad)}`);
    }
  }
  for (const raw of INVALID_SHAPES) assert.equal(parseLaneUpdateEvent({ ...base, raw }), null);
  for (const lane_update of INVALID_SHAPES) assert.equal(parseLaneUpdateEvent({ ...base, raw: { lane_update } }), null);
  const loose = parseLaneUpdateEvent(withUpdate({ source: 'x', state: 'bogus', prior_state: 7, owner_kind: [], title: 5, ts: null }));
  assert.ok(loose);
  assert.equal(loose.state, null);
  assert.equal(loose.title, '');
});

// QA r2 repair (advisor ruling 6bcd63e1): bounded delta.
test('visible_chat with a present non-string generation fails closed whatever the availability', () => {
  for (const available of ['open', 'history', 'unavailable']) {
    for (const generation of [7, true, [], {}, 0]) {
      const inventory = normalizeWorkLanesInventory({
        ...fixture.inventory_frame,
        lanes: [{ ...lane0(), visible_chat: { stream_id: 's', kind: 'session', available, generation } }],
      });
      assert.ok(inventory, `${available} ${JSON.stringify(generation)}`);
      assert.equal(inventory.lanes.length, 1);
      assert.equal(inventory.lanes[0].visible_chat.available, 'unavailable', `${available} ${JSON.stringify(generation)}`);
      assert.deepEqual(resolveWorkLaneTap(inventory.lanes[0]), { action: 'unavailable' });
    }
  }
  // null/absent generation stays valid for an open pointer (composite and open session chats carry none).
  for (const generation of [null, undefined]) {
    const inventory = normalizeWorkLanesInventory({
      ...fixture.inventory_frame,
      lanes: [{ ...lane0(), visible_chat: { stream_id: 's', kind: 'composite', available: 'open', generation } }],
    });
    assert.deepEqual(resolveWorkLaneTap(inventory!.lanes[0]), { action: 'open_chat', stream_id: 's' });
  }
});

test('frame and lanes shapes: every non-object frame and non-array lanes is rejected', () => {
  for (const frame of [undefined, null, 7, 'x', true, []]) {
    assert.equal(normalizeWorkLanesInventory(frame), null, `frame ${JSON.stringify(frame)}`);
  }
  for (const lanes of [undefined, null, 7, 'x', true, {}]) {
    assert.equal(normalizeWorkLanesInventory({ ...fixture.inventory_frame, lanes }), null, `lanes ${JSON.stringify(lanes)}`);
  }
  const kept = applyWorkLanesInventory(applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame), 'x');
  assert.equal(selectOpenLaneCount(kept), fixture.expected.header_count);
});

test('counts: each of open/active/paused/blocked rejects every invalid value, and a missing key rejects', () => {
  const frame = fixture.inventory_frame;
  for (const key of ['open', 'active', 'paused', 'blocked']) {
    for (const bad of [-1, 1.5, '3', null, Number.NaN, Infinity, [], {}, true]) {
      assert.equal(normalizeWorkLanesInventory({ ...frame, counts: { ...frame.counts, [key]: bad } }), null, `${key}=${String(bad)}`);
    }
    const { [key]: _gone, ...missing } = frame.counts;
    assert.equal(normalizeWorkLanesInventory({ ...frame, counts: missing }), null, `missing ${key}`);
  }
  assert.ok(normalizeWorkLanesInventory({ ...frame, counts: { open: 0, active: 0, paused: 0, blocked: 0 } }));
});
