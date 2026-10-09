import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyWorkLanesInventory, initialPentacleStreamState,
  type PentacleStreamState, type WorkLane, type WorkLaneMember,
} from 'pentacle-chat-core';
import {
  formatLaneCardProgress, formatLaneFreshness, formatWorkLaneEstimate,
  laneCardStateLabel, selectLaneCardViewModels,
} from '../src/services/workLanes';
import { selectPendingQuestionCount, selectQuestionDeck } from '../src/components/questions/questionSelectors';
import {
  HOSTS_CONFIG, SESSION_C, HIDDEN_SEAT, fixtureState, optimisticAnswer, twoItemQuestion,
} from './questions/fixtures';
// The shared question fixture lists the assistant composite session first.
const COMPOSITE_STREAM = fixtureState().sessions[0].stream_id;

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const fixture = JSON.parse(readFileSync(join(__dirname, '../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8'));
const NOW = Date.parse('2026-01-02T00:02:00.000Z');
const progress = (name: string): WorkLane => fixture.progress_v2.find((item: { name: string }) => item.name === name).frame.lanes[0];
const base = (): WorkLane => progress('active_progress');
const stateFor = (lanes: WorkLane[], extra: Record<string, unknown> = {}): PentacleStreamState =>
  applyWorkLanesInventory(initialPentacleStreamState, { lanes, ...extra });

beforeEach(() => { (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG; });
afterEach(() => { delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__; });

describe('lane progress truth precedence', () => {
  test.each<[string, Partial<WorkLane>, string]>([
    ['empty', { items_total: 0, items_open: 0, items_completed: 0, items_dropped: 0 }, 'No specs'],
    ['empty with reason', { items_total: 0, no_spec_reason: 'Exploratory conversation.' }, 'Exploratory conversation.'],
    ['unresolved', { items_total: 3, items_unresolved: 1, items_open: 0, items_completed: 3 }, '1 unresolved'],
    ['open', { items_total: 3, items_open: 2 }, 'est. open work 2–4h'],
    ['all completed', { items_total: 3, items_open: 0, items_completed: 3, items_dropped: 0 }, 'All specs done'],
    ['all dropped', { items_total: 3, items_open: 0, items_completed: 0, items_dropped: 3 }, 'All specs dropped'],
    ['completed and dropped', { items_total: 3, items_open: 0, items_completed: 2, items_dropped: 1 }, 'No open work'],
  ])('%s', (_name, patch, expected) => {
    expect(formatLaneCardProgress({ ...base(), ...patch })).toBe(expected);
  });

  test('a reason wins over unresolved and incomplete estimates', () => {
    expect(formatLaneCardProgress({ ...base(), no_spec_reason: 'Exploratory conversation.', items_unresolved: 2 }))
      .toBe('Exploratory conversation.');
  });

  test('missing and inconsistent counts never imply done from zero open work', () => {
    expect(formatLaneCardProgress({ ...base(), items_total: undefined, items_open: 0 })).toBe('—');
    expect(formatLaneCardProgress({ ...base(), items_total: 3, items_open: 0, items_completed: 1, items_dropped: 1 })).toBe('—');
  });

  test.each<[string, string]>([
    ['active_progress', 'est. open work 2–4h'],
    ['paused_leadless', 'est. open work 2–4h'],
    ['blocked', 'est. open work 2–4h'],
    ['missing_member', '1 unresolved'],
    ['ambiguous_member', '1 unresolved'],
    ['missing_estimate', 'est. open work —'],
    ['no_spec', 'Exploratory conversation.'],
    ['index_unavailable', 'est. open work 2–4h'],
  ])('shared progress fixture %s', (name, expected) => {
    const sample = fixture.progress_v2.find((item: { name: string }) => item.name === name);
    const state = applyWorkLanesInventory(initialPentacleStreamState, sample.frame);
    const model = selectLaneCardViewModels(state, NOW)[0];
    expect(model.progressLabel).toBe(expected);
    expect(model.members.map((member) => member.spec_id)).toEqual(sample.frame.lanes[0].members.map((member: WorkLaneMember) => member.spec_id));
    expect(model.indexSnapshotAt).toBe(name === 'index_unavailable' ? sample.work_index.snapshot_at : null);
  });

  test('unavailable index retains its snapshot marker before the remaining precedence rules', () => {
    const model = selectLaneCardViewModels(stateFor([{ ...base(), no_spec_reason: 'Exploratory conversation.' }], {
      work_index: { available: false, snapshot_at: '2026-01-02T00:00:00.000Z' },
    }), NOW)[0];
    expect(model.indexSnapshotAt).toBe('2026-01-02T00:00:00.000Z');
    expect(model.progressLabel).toBe('Exploratory conversation.');
    expect(model.members).toEqual([]);
    expect(model.segments).toEqual([]);
  });

  test('estimate labels are a dash, range or incomplete range with a plus', () => {
    expect(formatWorkLaneEstimate(null, false)).toBe('—');
    expect(formatWorkLaneEstimate({ p25: 2, p75: 4, median: 3 })).toBe('2–4h');
    expect(formatWorkLaneEstimate({ p25: 2, p75: 4, median: 3 }, false)).toBe('2–4h+');
    expect(formatWorkLaneEstimate({ p25: 0.25, p75: 0.5, median: 0.4 })).toBe('15–30m');
    expect(formatWorkLaneEstimate({ p25: 0.5, p75: 2, median: 1 })).toBe('30m–2h');
    expect(formatLaneCardProgress({ ...base(), estimate_complete: false })).toBe('est. open work 2–4h+');
  });
});

describe('one lane model for list and map', () => {
  test.each<[WorkLane['state'], string, boolean, string]>([
    ['active', 'fd', true, 'WORKING'], ['active', 'fd', false, 'ACTIVE · IDLE'],
    ['paused', 'fd', true, 'PAUSED'], ['paused', 'lead_lost', false, 'PAUSED · LEAD LOST'],
    ['paused', 'lead_lost_unreconciled', false, 'PAUSED · LEAD LOST'], ['blocked', 'fd', true, 'BLOCKED'],
  ])('%s / %s / working %s', (state, state_reason, working, label) => {
    const lane = { ...base(), state, state_reason, lead: { ...base().lead!, presence: { ...base().lead!.presence, working } } };
    expect(laneCardStateLabel(lane)).toBe(label);
    expect(selectLaneCardViewModels(stateFor([lane]), NOW)[0].stateLabel).toBe(label);
  });

  test('segments follow member order and exact acceptance fractions for every member status', () => {
    const statuses = ['completed', 'in_progress', 'needs_qa', 'ready_for_dev', 'analysis', 'backlog', 'deprecated', 'missing', 'ambiguous'];
    const members = statuses.map((status, index) => ({ ...base().members![0], spec_id: `spec-${index}`, status, ac_checked: 1, ac_total: 4 }));
    const active = selectLaneCardViewModels(stateFor([{ ...base(), members }]), NOW)[0];
    expect(active.segments.map((segment) => segment.specId)).toEqual(members.map((member) => member.spec_id));
    expect(active.segments.map((segment) => segment.fraction)).toEqual([1, 0.25, 0.25, 0, 0, 0, 0, 0, 0]);
    expect(active.segments.map((segment) => segment.tone)).toEqual(['green', 'green', 'green', 'green', 'green', 'green', 'muted', 'red', 'red']);
    const paused = selectLaneCardViewModels(stateFor([{ ...base(), state: 'paused', members }]), NOW)[0];
    expect(paused.segments.map((segment) => segment.tone)).toEqual(['muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'muted', 'red', 'red']);
    const blocked = selectLaneCardViewModels(stateFor([{ ...base(), state: 'blocked', members }]), NOW)[0];
    expect(blocked.segments.slice(0, 3).map((segment) => segment.tone)).toEqual(['amber', 'amber', 'amber']);
  });

  test('missing acceptance and error quality never fabricate progress; fractions are bounded', () => {
    const members = [
      { ...base().members![0], spec_id: 'absent', ac_total: null, observation: { quality: 'error' as const, error: 'read_failed' } },
      { ...base().members![0], spec_id: 'over', ac_checked: 8, ac_total: 4 },
      { ...base().members![0], spec_id: 'zero', ac_checked: 0, ac_total: 4 },
    ];
    expect(selectLaneCardViewModels(stateFor([{ ...base(), members }]), NOW)[0].segments.map((segment) => segment.fraction))
      .toEqual([0, 1, 0]);
  });

  test('v1 to increment-one inventory changes preserve lane identity and enable members', () => {
    const old = { ...base() };
    for (const key of ['members', 'members_total', 'items_total', 'items_completed', 'items_dropped', 'items_open', 'items_unresolved', 'open_estimate_h', 'estimate_complete'] as const) delete old[key];
    const v1 = stateFor([old]);
    const oldModel = selectLaneCardViewModels(v1, NOW)[0];
    expect(oldModel.membersPending).toBe(true);
    expect(oldModel.members).toEqual([]);
    expect(oldModel.progressLabel).toBe('—');
    const upgraded = applyWorkLanesInventory(v1, { lanes: [base()] });
    const newModel = selectLaneCardViewModels(upgraded, NOW)[0];
    expect(newModel.lane.lane_id).toBe(oldModel.lane.lane_id);
    expect(newModel.membersPending).toBe(false);
    expect(newModel.members).toHaveLength(2);
  });

  test('daemon order, full-member count, freshness and lead host remain presentation facts', () => {
    const lanes = [{ ...base(), members_total: 32 }, { ...progress('paused_leadless') }];
    const models = selectLaneCardViewModels(stateFor(lanes), NOW);
    expect(models.map((model) => model.lane.lane_id)).toEqual(lanes.map((lane) => lane.lane_id));
    expect(models[0]).toMatchObject({ membersTotal: 32, total: 2, completed: 1, freshnessLabel: '2m ago', leadHost: 'fixture-host' });
    expect(models[1].presenceLabel).toBe('no lead');
    expect(formatLaneFreshness('bad-date', NOW)).toBe('—');
    expect(formatLaneFreshness(new Date(NOW + 1000).toISOString(), NOW)).toBe('Just now');
  });

  test('last update joins publication summary by update id and otherwise uses only kind and time', () => {
    const event = fixture.lane_update_events[0].event;
    const update = event.raw.lane_update;
    const lane = { ...base(), lane_id: update.lane_id, last_update: { update_id: update.update_id, kind: update.kind, ts: update.ts, event_id: 1 } };
    const state = { ...stateFor([lane]), events: [event] };
    expect(selectLaneCardViewModels(state, NOW)[0].lastUpdateText).toBe(update.summary);
    expect(selectLaneCardViewModels(stateFor([lane]), NOW)[0].lastUpdateText).toBe(`${update.kind} · ${update.ts}`);
    const newer = { ...event, daemon_seq: event.daemon_seq + 1, message_id: 'publication-newer', raw: { ...event.raw, lane_update: { ...update, summary: 'Newer summary.' } } };
    expect(selectLaneCardViewModels({ ...state, events: [event, newer] }, NOW)[0].lastUpdateText).toBe('Newer summary.');
  });
});

describe('waiting on you uses the actual Questions deck', () => {
  function withLanes(state: PentacleStreamState): PentacleStreamState {
    const ids = [...new Set(selectQuestionDeck(state).map((entry) => entry.streamId))];
    return applyWorkLanesInventory(state, { lanes: ids.map((streamId, index) => ({
      ...base(), lane_id: `question-lane-${index}`, state: 'blocked', blocker: 'Materials needed.',
      visible_chat: { ...base().visible_chat, stream_id: streamId },
    })) });
  }

  test('durable, multi-item, legacy and composite-visible questions match the overlay count', () => {
    const state = withLanes(fixtureState());
    const models = selectLaneCardViewModels(state, NOW);
    expect(models.reduce((sum, model) => sum + model.waitingOnYou, 0)).toBe(selectPendingQuestionCount(state));
    expect(models.find((model) => model.lane.visible_chat.stream_id === SESSION_C)).toMatchObject({
      waitingOnYou: 2, blockerLabel: 'Waiting on you · 2 questions', stateLabel: 'BLOCKED',
    });
    expect(models.find((model) => model.lane.visible_chat.stream_id === COMPOSITE_STREAM)?.waitingOnYou).toBe(1);
    for (const model of models) {
      expect(model.waitingOnYou).toBe(selectQuestionDeck(state).filter((entry) => entry.streamId === model.lane.visible_chat.stream_id).length);
    }
  });

  test('optimistic answers and acknowledged answered items both disappear from the lane', () => {
    const state = fixtureState({ optimisticSends: { first: optimisticAnswer('n-deploy', 'q-n-deploy-a') } });
    state.notifications = state.notifications.map((entry: { notification_id: string }) => entry.notification_id === 'n-deploy'
      ? twoItemQuestion(SESSION_C, 'n-deploy', { b: { state: 'answered' } }) : entry);
    const lanes = applyWorkLanesInventory(state, { lanes: [{ ...base(), state: 'blocked', blocker: 'Materials needed.', visible_chat: { ...base().visible_chat, stream_id: SESSION_C } }] });
    expect(selectLaneCardViewModels(lanes, NOW)[0]).toMatchObject({ waitingOnYou: 0, waitingOnYouLabel: null, blockerLabel: 'Materials needed.' });
  });

  test('a hidden producer routed to the visible composite counts on that composite lane', () => {
    const state = fixtureState();
    state.notifications = state.notifications.map((entry: { notification_id: string }) => entry.notification_id === 'n-hidden'
      ? { ...entry, surfaced_to_stream_id: COMPOSITE_STREAM } : entry);
    const lanes = applyWorkLanesInventory(state, { lanes: [{
      ...base(), lead: { ...base().lead!, stream_id: HIDDEN_SEAT },
      visible_chat: { ...base().visible_chat, stream_id: COMPOSITE_STREAM, kind: 'composite' },
    }] });
    const deck = selectQuestionDeck(lanes);
    expect(deck.filter((entry) => entry.streamId === COMPOSITE_STREAM)).toHaveLength(2);
    expect(deck.filter((entry) => entry.streamId === HIDDEN_SEAT)).toHaveLength(0);
    expect(selectLaneCardViewModels(lanes, NOW)[0].waitingOnYou).toBe(2);
  });

  test('questions on other streams and a lane blocker text do not invent waiting on you', () => {
    const state = applyWorkLanesInventory(fixtureState(), { lanes: [{ ...base(), blocker: 'Waiting on you: check the model.', visible_chat: { ...base().visible_chat, stream_id: 'other:chat' } }] });
    expect(selectLaneCardViewModels(state, NOW)[0].waitingOnYou).toBe(0);
  });
});
