import { fleetOverrunPct, formatLaneEta } from '../src/services/laneEta';
import { applyPentacleSessionInventory, applyPentacleSnapshotMessage, initialPentacleStreamState, type PentacleSessionSummary, type SessionStatusCard } from 'pentacle-chat-core';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const eta = { eta_set_at: at(0), eta_at: at(100) };

describe('formatLaneEta', () => {
  test.each([
    [60, '~40m'],
    [60.5, '~40m'],
    [60 + 31 / 60, '~39m'],
    [40, '~1h'],
    [20, '~1h 20m'],
    [100 - 20 / 60, '~1m'],
    [100, 'late 1m'],
    [100 + 20 / 60, 'late 1m'],
    [135, 'late 35m'],
    [160, 'late 1h'],
    [225, 'late 2h 5m'],
    [100 + 59.5, 'late 1h'],
  ])('at minute %s renders %s', (minutes, expected) => {
    expect(formatLaneEta({ ...eta, now: T0 + minutes * 60_000 })).toBe(expected);
  });

  test.each([
    {},
    { eta_at: null, eta_set_at: at(0) },
    { eta_at: at(100) },
    { eta_at: at(100), eta_set_at: null },
    { eta_at: at(0), eta_set_at: at(0) },
    { eta_at: at(-1), eta_set_at: at(0) },
    { eta_at: 'invalid', eta_set_at: at(0) },
    { eta_at: at(100), eta_set_at: 'invalid' },
  ])('unknown or invalid estimate %j renders a dash', (fields) => {
    expect(formatLaneEta({ ...fields, now: T0 })).toBe('—');
  });

  test('needs-you takes precedence over future, past and invalid estimates', () => {
    for (const fields of [eta, { ...eta, eta_at: at(1) }, {}]) {
      expect(formatLaneEta({ ...fields, now: T0 + 60 * 60_000, needsYou: true })).toBe('Blocked');
    }
  });

  test('invalid clock renders a dash', () => {
    expect(formatLaneEta({ ...eta, now: Number.NaN })).toBe('—');
  });

  test('defaults to the current clock', () => {
    jest.useFakeTimers().setSystemTime(T0 + 60 * 60_000);
    expect(formatLaneEta(eta)).toBe('~40m');
  });
});

describe('fleetOverrunPct (test parity only, never displayed)', () => {
  test.each([[60, 0], [135, 35], [300, 200]])('minute %s gives %s%%', (minutes, expected) => {
    expect(fleetOverrunPct({ ...eta, now: T0 + minutes * 60_000 })).toBe(expected);
  });
  test('invalid intervals do not produce infinite or misleading values', () => {
    expect(fleetOverrunPct({ now: T0 })).toBe(0);
    expect(fleetOverrunPct({ eta_at: at(0), eta_set_at: at(0), now: T0 })).toBe(0);
    expect(fleetOverrunPct({ ...eta, now: Number.NaN })).toBe(0);
  });
});

test('ETA fields are optional nullable wire fields on sessions and status cards', () => {
  const session: Pick<PentacleSessionSummary, 'eta_at' | 'eta_set_at'> = eta;
  const card: SessionStatusCard = { updated_at: at(0), eta_at: null, eta_set_at: null };
  expect(session.eta_at).toBe(at(100));
  expect(card.eta_set_at).toBeNull();
});


test('snapshot and inventory preserve nullable ETA fields without a custom normalizer', () => {
  const session: PentacleSessionSummary = {
    stream_id: 'hosta:codex:example', host: 'hosta', provider: 'codex', session_name: 'example',
    last_event_at: at(0), last_text: '', last_kind: 'ASSIST', draft: '', pending: false,
    working: true, online: true, ...eta, status_card: { updated_at: at(0), ...eta },
  };
  const snapshot = applyPentacleSnapshotMessage(initialPentacleStreamState, { sessions: [session], events: [] });
  expect(snapshot.sessions[0]).toMatchObject({ ...eta, status_card: eta });
  const inventory = applyPentacleSessionInventory(snapshot, [{
    ...session, eta_at: null, eta_set_at: null,
    status_card: { updated_at: at(0), eta_at: null, eta_set_at: null },
  }]);
  expect(inventory.sessions[0]).toMatchObject({ eta_at: null, eta_set_at: null,
    status_card: { eta_at: null, eta_set_at: null } });
});
