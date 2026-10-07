import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyWorkLanesInventory, initialPentacleStreamState, applyPentacleSessionInventory,
  type PentacleEvent, type WorkLane,
} from 'pentacle-chat-core';
import {
  formatLaneEtaState, laneLeadStatusCard, laneStateLabel, selectLaneUpdates, selectLaneViewModels,
} from '../src/services/workLanes';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));
const NOW = Date.parse('2026-10-07T19:01:00Z');
const lane = (id: string): WorkLane => fixture.inventory_frame.lanes.find((item: WorkLane) => item.lane_id === id);

describe('shared parity fixture', () => {
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);

  test('view models keep daemon order, count and per-lane tap/eta facts', () => {
    const models = selectLaneViewModels(state, NOW);
    expect(models.map((model) => model.lane.lane_id)).toEqual(fixture.expected.order);
    for (const model of models) {
      expect(model.tap).toEqual(fixture.expected.tap[model.lane.lane_id]);
      expect(model.etaStale).toBe(fixture.expected.eta_stale[model.lane.lane_id]);
    }
  });

  test('session churn never alters lanes', () => {
    const churned = applyPentacleSessionInventory(state, []);
    expect(selectLaneViewModels(churned, NOW).map((model) => model.lane.lane_id)).toEqual(fixture.expected.order);
  });
});

describe('formatLaneEtaState', () => {
  test('stale ETA is named instead of reported late', () => {
    expect(formatLaneEtaState(lane('wl-paused-0003'), NOW)).toBe('ETA stale');
    expect(formatLaneEtaState(lane('wl-paused-0004'), NOW)).toBe('ETA stale');
  });
  test('blocked lanes read Blocked and live ETAs reuse the shared formatter', () => {
    expect(formatLaneEtaState(lane('wl-blocked-0001'), NOW)).toBe('Blocked');
    expect(formatLaneEtaState(lane('wl-active-0002'), NOW)).toBe('~8h 59m');
  });
  test('a lane with no lead or no estimate shows a dash', () => {
    expect(formatLaneEtaState({ ...lane('wl-active-0002'), lead: null }, NOW)).toBe('—');
    const noEta = lane('wl-active-0002');
    expect(formatLaneEtaState({ ...noEta, lead: { ...noEta.lead!, status_card: { ...noEta.lead!.status_card, eta_at: null } } }, NOW)).toBe('—');
  });
});

test('state labels are only the three header states', () => {
  expect(['active', 'paused', 'blocked'].map((state) => laneStateLabel(state as WorkLane['state'])))
    .toEqual(['ACTIVE', 'PAUSED', 'BLOCKED']);
});

test('lead status card adapts to the shared status-card shape', () => {
  expect(laneLeadStatusCard(lane('wl-active-0002'))).toEqual({
    goal: 'Mobile lanes UI',
    plan: [{ text: 'LanesSurface', status: 'active' }],
    update: undefined,
    eta_at: '2026-10-08T04:00:00Z',
    eta_set_at: '2026-10-07T18:30:00Z',
    updated_at: '2026-10-07T18:50:00Z',
  });
  expect(laneLeadStatusCard({ ...lane('wl-active-0002'), lead: null })).toBeNull();
});

test('lane updates are the lane_update events of the Bart timeline, newest first, no duplicates', () => {
  const events: PentacleEvent[] = fixture.lane_update_events.map((frame: { event: PentacleEvent }) => frame.event);
  const base = { ...initialPentacleStreamState, events: [...events, events[0], {
    ...events[0], daemon_seq: 2000, message_id: 'prose-1', publish_kind: 'prose', text: 'not a lane update',
  }] };
  const updates = selectLaneUpdates(base as any);
  expect(updates.map((item) => item.update.update_id)).toEqual(
    [...events].sort((a, b) => b.daemon_seq - a.daemon_seq).map((event) => (event.raw as any).lane_update.update_id),
  );
});
