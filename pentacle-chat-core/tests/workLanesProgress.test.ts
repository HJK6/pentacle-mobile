import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyPentacleSnapshotMessage,
  applyWorkLanesInventory,
  initialPentacleStreamState,
  normalizeWorkLanesInventory,
  parseWorkLaneShow,
  resolveWorkLaneTap,
  selectOpenLaneCount,
} from '../src/index.ts';

const fixtureBytes = readFileSync(new URL('./fixtures/work-lanes-inventory.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const progress = fixture.progress_v2 as { name: string; frame: Record<string, any> }[];
const sampleFrame = progress[0].frame;
const sampleLane = sampleFrame.lanes[0];
const sampleMember = sampleLane.members[0];
const absent = (value: object, field: string) => assert.equal(Object.hasOwn(value, field), false, field);
const normalizePatch = (patch: Record<string, unknown>) => normalizeWorkLanesInventory({
  ...sampleFrame, lanes: [{ ...sampleLane, ...patch }],
})!;

// The fixture is the byte-for-byte public daemon contract, never a client rewrite.
test('shared work-lanes fixture v2 has its exact accepted SHA256', () => {
  assert.equal(fixture.fixture_version, 2);
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),
    '2be3dd8d99046c3c8dc293ae4d90a187ab72cb082ef36153d957037a39ddcce1');
  assert.deepEqual(progress.map((entry) => entry.name), [
    'active_progress', 'paused_leadless', 'blocked', 'missing_member',
    'ambiguous_member', 'missing_estimate', 'no_spec', 'index_unavailable',
  ]);
});

for (const entry of progress) {
  test(`progress_v2 ${entry.name}: all projected facts, membership order and counts survive`, () => {
    const normalized = normalizeWorkLanesInventory(entry.frame);
    assert.ok(normalized);
    assert.deepEqual(normalized.lanes, entry.frame.lanes);
    assert.deepEqual(normalized.work_index, entry.frame.work_index);
    assert.deepEqual(normalized.counts, entry.frame.counts);
    const state = applyWorkLanesInventory(initialPentacleStreamState, entry.frame);
    assert.equal(selectOpenLaneCount(state), entry.frame.counts.open);
    assert.equal(applyWorkLanesInventory(state, entry.frame), state);
    const shown = parseWorkLaneShow({ type: 'work_lanes.show.ok', lane: { lane_id: entry.frame.lanes[0].lane_id },
      projection: entry.frame.lanes[0], members: entry.frame.lanes[0].members, events: [], updates: [],
      work_index: entry.frame.work_index });
    assert.ok(shown);
    assert.deepEqual(shown.projection, normalized.lanes[0]);
    assert.deepEqual(shown.members, entry.frame.lanes[0].members);
    assert.deepEqual(shown.work_index, entry.frame.work_index);
  });
}

test('optional inc1 fields are absent on v1, and the reconnect inventory upgrades the same state', () => {
  const v1 = { ...sampleFrame, lanes: fixture.inventory_frame.lanes, work_index: undefined };
  const before = applyWorkLanesInventory(initialPentacleStreamState, v1);
  for (const lane of before.workLanes!.lanes) {
    for (const key of ['members', 'members_total', 'items_total', 'open_estimate_h', 'freshness_at']) absent(lane, key);
  }
  absent(before.workLanes!, 'work_index');
  const after = applyPentacleSnapshotMessage(before, { sessions: [], work_lanes: sampleFrame });
  assert.deepEqual(after.workLanes!.lanes[0].members, sampleLane.members);
  assert.equal(after.workLanes!.work_index!.available, true);
  const downgraded = applyWorkLanesInventory(after, v1);
  absent(downgraded.workLanes!.lanes[0], 'members');
});

test('each malformed optional count disappears without rejecting the lane or changing v1 counts', () => {
  for (const key of ['members_total', 'items_total', 'items_completed', 'items_dropped', 'items_open',
    'items_unresolved', 'ac_members', 'open_estimated']) {
    for (const bad of [undefined, null, -1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '2', {}, [], true]) {
      const inventory = normalizePatch({ [key]: bad });
      assert.ok(inventory, `${key}=${String(bad)}`);
      absent(inventory.lanes[0], key);
      assert.deepEqual(inventory.counts, sampleFrame.counts);
      assert.deepEqual(inventory.lanes[0].members, sampleLane.members);
    }
    assert.equal(normalizePatch({ [key]: 0 }).lanes[0][key as 'items_total'], 0);
  }
});

test('nullable optional AC, strings, estimate and boolean retain null/zero/false and omit malformed values', () => {
  for (const key of ['ac_checked', 'ac_total']) {
    for (const bad of [undefined, -1, 1.5, Infinity, '2', {}, [], true]) absent(normalizePatch({ [key]: bad }).lanes[0], key);
    assert.equal(normalizePatch({ [key]: null }).lanes[0][key as 'ac_total'], null);
    assert.equal(normalizePatch({ [key]: 0 }).lanes[0][key as 'ac_total'], 0);
  }
  for (const key of ['no_spec_reason', 'freshness_at']) {
    for (const bad of [undefined, 4, {}, [], true]) absent(normalizePatch({ [key]: bad }).lanes[0], key);
    assert.equal(normalizePatch({ [key]: null }).lanes[0][key as 'freshness_at'], null);
  }
  for (const bad of [undefined, null, 1, 'true', [], {}]) absent(normalizePatch({ estimate_complete: bad }).lanes[0], 'estimate_complete');
  assert.equal(normalizePatch({ estimate_complete: false }).lanes[0].estimate_complete, false);
  for (const bad of [undefined, 1, '2–4', [], {}, { p25: 4, p75: 2, median: 3 },
    { p25: 1, p75: Infinity, median: 2 }, { p25: 1, p75: 3, median: -2 }]) {
    absent(normalizePatch({ open_estimate_h: bad }).lanes[0], 'open_estimate_h');
  }
  assert.equal(normalizePatch({ open_estimate_h: null }).lanes[0].open_estimate_h, null);
});

test('malformed optional memberships disappear rather than producing a falsely complete subset', () => {
  for (const members of [null, 1, true, {}, 'members', [null], [{ spec_id: '' }], [{ spec_id: 7 }],
    [sampleMember, { title: 'Incomplete' }], [sampleMember, sampleMember]]) {
    const inventory = normalizePatch({ members });
    assert.ok(inventory);
    absent(inventory.lanes[0], 'members');
    assert.equal(inventory.lanes[0].members_total, sampleLane.members_total);
  }
  assert.deepEqual(normalizePatch({ members: [] }).lanes[0].members, []);
});

test('malformed member facts are independently absent without losing its identity or other facts', () => {
  const fields = ['title', 'status', 'terminal', 'ac_checked', 'ac_total', 'estimate',
    'status_text', 'next_action_text', 'source_changed_at', 'observation', 'obs_rev'];
  for (const field of fields) {
    for (const bad of [undefined, [], {}, true]) {
      const member = normalizePatch({ members: [{ ...sampleMember, [field]: bad }] }).lanes[0].members![0];
      absent(member, field);
      assert.equal(member.spec_id, sampleMember.spec_id);
    }
  }
  const member = normalizePatch({ members: [{ ...sampleMember, obs_rev: 0, terminal: 'done',
    estimate: { ...sampleMember.estimate, provisional: 'yes' },
    observation: { quality: 'error', observed_at: 9, error: 'Unreadable source' } }] }).lanes[0].members![0];
  absent(member, 'obs_rev');
  absent(member, 'terminal');
  absent(member.estimate!, 'provisional');
  assert.deepEqual(member.observation, { quality: 'error', error: 'Unreadable source' });
  const invalid = normalizePatch({ members: [{ ...sampleMember, observation: { quality: 'unknown' } }] }).lanes[0].members![0];
  absent(invalid, 'observation');
});

test('all observation qualities are retained, including inline derived error quality', () => {
  for (const quality of ['fresh', 'stale', 'error', 'missing', 'ambiguous'] as const) {
    const observation = { quality, observed_at: sampleMember.source_changed_at, error: quality === 'error' ? 'Read failed' : null };
    const member = normalizePatch({ members: [{ ...sampleMember, observation }] }).lanes[0].members![0];
    assert.deepEqual(member.observation, observation);
  }
});

test('work_index is independently tolerant, including unavailable snapshots and malformed subfields', () => {
  for (const work_index of [null, 7, 'yes', [], {}, { available: null }, { available: 'false' }]) {
    const inventory = normalizeWorkLanesInventory({ ...sampleFrame, work_index });
    assert.ok(inventory);
    absent(inventory, 'work_index');
    assert.deepEqual(inventory.lanes, sampleFrame.lanes);
  }
  const inventory = normalizeWorkLanesInventory({ ...sampleFrame,
    work_index: { available: false, root_configured: 'yes', snapshot_at: 7, last_sweep_at: [], error: null } });
  assert.deepEqual(inventory!.work_index, { available: false, error: null });
});

test('optional additions never change unled-to-paused or fail-closed navigation rules', () => {
  const inventory = normalizePatch({ lead: null, visible_chat: { ...sampleLane.visible_chat, generation: 7 },
    members_total: -1, completion_pending: true, lead_reported_done: true, stale: true });
  const lane = inventory.lanes[0];
  assert.equal(lane.state, 'paused');
  assert.equal(lane.state_reason, 'lead_lost_unreconciled');
  assert.deepEqual(resolveWorkLaneTap(lane), { action: 'unavailable' });
  for (const key of ['members_total', 'completion_pending', 'lead_reported_done', 'stale']) absent(lane, key);
  assert.deepEqual(lane.members, sampleLane.members);
});

const showBase = () => ({ type: 'work_lanes.show.ok', lane: { lane_id: sampleLane.lane_id },
  projection: sampleLane, members: sampleLane.members, events: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] });
const changeSnapshot = { status: 'in_progress', ac_checked: 1, ac_total: 3,
  estimate: { p25: 2, p75: 4, median: 3, provisional: true } };
const changeEvent = (patch: Record<string, unknown> = {}) => ({
  event_id: 'item-1', lane_id: sampleLane.lane_id, operation: 'item_change', created_at: '2026-01-02T04:00:00Z',
  payload: { spec_id: sampleMember.spec_id, obs_rev: 2, prior: changeSnapshot,
    next: { status: 'completed', ac_checked: 3, ac_total: 3, estimate: null }, source_changed_at: '2026-01-02T03:00:00Z' },
  ...patch,
});

test('show expands status, AC and estimate changes independently, resolving titles from all members', () => {
  const reply = { ...showBase(), events: [changeEvent()] };
  const before = JSON.stringify(reply);
  const shown = parseWorkLaneShow(reply)!;
  assert.equal(shown.events.length, 0);
  assert.deepEqual(shown.spec_changes.map((row) => [row.field, row.before, row.after]), [
    ['status', 'in_progress', 'completed'], ['ac', '1/3', '3/3'], ['estimate', '2–4 h (median 3; provisional)', '—'],
  ]);
  for (const row of shown.spec_changes) {
    assert.equal(row.title, sampleMember.title);
    assert.equal(row.created_at, '2026-01-02T04:00:00Z');
    assert.equal(row.obs_rev, 2);
  }
  assert.equal(JSON.stringify(reply), before);
});

test('show AC row includes checked-only, total-only and null coverage changes', () => {
  for (const next of [{ ...changeSnapshot, ac_checked: 2 }, { ...changeSnapshot, ac_total: 4 },
    { ...changeSnapshot, ac_checked: null, ac_total: null }]) {
    const event = changeEvent({ payload: { spec_id: 'spec_demo__unlisted', prior: changeSnapshot, next } });
    const rows = parseWorkLaneShow({ ...showBase(), events: [event] })!.spec_changes;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, 'ac');
    assert.equal(rows[0].title, 'spec_demo__unlisted');
  }
});

test('show estimate compares normalized facts, including median and provisional only, never key order', () => {
  for (const estimate of [{ p25: 2, p75: 4, median: 2.5, provisional: true },
    { p25: 2, p75: 4, median: 3, provisional: false }]) {
    const rows = parseWorkLaneShow({ ...showBase(), events: [changeEvent({ payload: {
      spec_id: sampleMember.spec_id, prior: changeSnapshot, next: { ...changeSnapshot, estimate },
    } })] })!.spec_changes;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, 'estimate');
    assert.notEqual(rows[0].before, rows[0].after);
  }
  const same = { ...changeSnapshot, estimate: { median: 3, provisional: true, p75: 4, p25: 2 } };
  assert.deepEqual(parseWorkLaneShow({ ...showBase(), events: [changeEvent({ payload: {
    spec_id: sampleMember.spec_id, prior: changeSnapshot, next: same,
  } })] })!.spec_changes, []);
});

test('show orders each log tab by created_at descending then event id and retains every row for local paging', () => {
  const events = Array.from({ length: 61 }, (_, n) => ({
    event_id: `event-${String(n).padStart(3, '0')}`, operation: n % 2 ? 'item_change' : 'set_state',
    created_at: n < 60 ? '2026-01-02T01:00:00Z' : '2026-01-02T02:00:00Z',
    update_id: `update-${n}`, payload: n % 2 ? changeEvent().payload : { summary: `Update ${n}` },
  }));
  const updates = events.map((event) => ({ update_id: event.update_id, kind: 'milestone', ts: event.created_at }));
  const shown = parseWorkLaneShow({ ...showBase(), events, updates })!;
  assert.equal(shown.updates.length, 61);
  assert.equal(shown.events.length, 31);
  assert.equal(shown.spec_changes.length, 90);
  assert.equal(shown.updates[0].event_id, 'event-060');
  assert.equal(shown.updates[1].event_id, 'event-059');
  assert.equal(shown.events[1].event_id, 'event-058');
  assert.equal(shown.spec_changes[0].event_id, 'event-059');
});

test('show joins updates to audit summaries and falls back to metadata, including last_update', () => {
  const reply = { ...showBase(), projection: { ...sampleLane,
    last_update: { update_id: 'latest', kind: 'milestone', event_id: 10, ts: '2026-01-02T04:00:00Z' } },
  events: [
    { event_id: 'audit-1', operation: 'update', update_id: 'u1', created_at: '2026-01-02T01:00:00Z', payload: { summary: 'Verified milestone' } },
    { event_id: 'audit-2', operation: 'set_state', update_id: 'u2', created_at: '2026-01-02T02:00:00Z', payload: {} },
  ], updates: [
    { update_id: 'u1', kind: 'milestone', event_id: 100, ts: '2026-01-02T01:00:00Z' },
    { update_id: 'u2', kind: 'lane_blocked', event_id: 101, ts: '2026-01-02T02:00:00Z' },
    { update_id: 'u3', kind: 'major_decision', ts: '2026-01-02T03:00:00Z', summary: 'Unlinked text must not be used' },
  ] };
  const shown = parseWorkLaneShow(reply)!;
  assert.deepEqual(shown.updates.map((row) => [row.update_id, row.summary]), [
    ['latest', null], ['u3', null], ['u2', null], ['u1', 'Verified milestone'],
  ]);
  assert.deepEqual(shown.events.map((row) => row.operation), ['set_state', 'update']);
});

test('show accepts all 32 members in daemon order, independent of the eight-member inventory preview', () => {
  const members = Array.from({ length: 32 }, (_, n) => ({ ...sampleMember, spec_id: `spec_demo__member_${n}`, title: `Member ${n}` }));
  const shown = parseWorkLaneShow({ ...showBase(), projection: { ...sampleLane, members: members.slice(0, 8), members_total: 32 }, members })!;
  assert.equal(shown.projection!.members!.length, 8);
  assert.deepEqual(shown.members, members);
});

test('show v1 response has no fabricated progress and no membership requirement', () => {
  const lane = fixture.inventory_frame.lanes[0];
  const shown = parseWorkLaneShow({ type: 'work_lanes.show.ok', lane: { lane_id: lane.lane_id }, projection: lane, events: [], updates: [] })!;
  assert.ok(shown);
  assert.deepEqual(shown.members, []);
  absent(shown.projection!, 'items_total');
  absent(shown, 'work_index');
});

test('show refuses errors/missing identity and mismatched projection identity without throwing', () => {
  for (const input of [null, 1, [], {}, { type: 'work_lanes.show.error', error: 'Unavailable' },
    { ...showBase(), type: 'other' }, { ...showBase(), lane: { lane_id: 'other-lane' } }]) {
    assert.equal(parseWorkLaneShow(input), null);
  }
  assert.ok(parseWorkLaneShow({ ...showBase(), projection: null }));
});

test('show independently tolerates malformed optional lists, index and audit payloads', () => {
  for (const bad of [undefined, null, 1, 'bad', {}, true]) {
    const shown = parseWorkLaneShow({ ...showBase(), events: bad, updates: bad, members: bad, work_index: bad })!;
    assert.ok(shown);
    assert.deepEqual(shown.members, sampleLane.members);
    assert.deepEqual(shown.spec_changes, []);
    assert.deepEqual(shown.events, []);
    absent(shown, 'work_index');
  }
  const shown = parseWorkLaneShow({ ...showBase(), events: [null, {}, changeEvent({ payload: null }),
    changeEvent({ lane_id: 'different-lane' }), changeEvent({ payload: { spec_id: sampleMember.spec_id, prior: {}, next: {} } })],
  updates: [null, {}, { update_id: 'u1', kind: 'unknown' }] })!;
  assert.deepEqual(shown.updates, []);
  assert.deepEqual(shown.spec_changes, []);
});

test('show equal-time numeric event IDs sort numerically, and update publication linkage is explicit', () => {
  const events = [9, 10].map((event_id) => ({ event_id, operation: 'update', created_at: '2026-01-02T01:00:00Z',
    publication_event_id: 100 + event_id, payload: { summary: `Summary ${event_id}` } }));
  const updates = [9, 10].map((id) => ({ update_id: `u${id}`, kind: 'milestone', event_id: 100 + id, ts: '2026-01-02T01:00:00Z' }));
  const shown = parseWorkLaneShow({ ...showBase(), events, updates })!;
  assert.deepEqual(shown.events.map((row) => row.event_id), ['10', '9']);
  assert.deepEqual(shown.updates.map((row) => row.summary), ['Summary 10', 'Summary 9']);
});
