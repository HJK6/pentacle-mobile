import {
  AssertStableError,
  assertStable,
  createFakeDaemonHarness,
  rowIdsStable,
  type AssertStablePredicate,
} from './runner';
import type { PentacleEvent, PentacleStreamState } from 'pentacle-chat-core';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

const STREAM_ID = 'hostc:claude:stable';
const NOISE_STREAM_ID = 'hostc:codex:noise';

function harnessWithState(state: PentacleStreamState = baseState()) {
  return createFakeDaemonHarness({ streamId: STREAM_ID, initialState: state });
}

function baseState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [],
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    notifications: [],
    workingStates: {},
    ...overrides,
  };
}

function rowEvent(
  rowId: string,
  reactIdentity: string,
  daemonSeq: number,
  streamId = STREAM_ID,
): PentacleEvent {
  return {
    daemon_seq: daemonSeq,
    host: 'hostc',
    provider: 'claude',
    session_id: 'session-alpha',
    session_name: 'alpha',
    stream_id: streamId,
    timestamp: '2026-05-16T00:00:00.000Z',
    kind: 'ASSIST',
    text: rowId,
    raw: {
      row_id: rowId,
      content_version: 1,
      react_identity: reactIdentity,
      mount_generation: reactIdentity,
    },
  };
}

describe('assertStable', () => {
  test('false-pass case: condition stays true for the quiet window', async () => {
    const harness = harnessWithState();
    const condition: AssertStablePredicate = (snap) => snap.state.connected;

    const result = await assertStable(harness.setup, {
      condition,
      initial: condition,
      settle_ms: 20,
      quiet_window_ms: 15,
      max_wait_ms: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.quiet_window_ms).toBe(15);
  });

  test('false-fail case: condition flips false during the quiet window and reports the mutation log', async () => {
    const harness = harnessWithState();
    const condition: AssertStablePredicate = (snap) =>
      snap.state.connected || { ok: false, msg: 'stream disconnected' };

    setTimeout(() => {
      harness.patchState({ connected: false });
    }, 5);

    let thrown: unknown;
    try {
      await assertStable(harness.setup, {
        condition,
        initial: condition,
        settle_ms: 20,
        quiet_window_ms: 40,
        max_wait_ms: 100,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AssertStableError);
    expect(thrown).toMatchObject({
      kind: 'condition_violated_during_quiet_window',
      message: expect.stringContaining('condition violated during quiet window'),
    });
    expect((thrown as AssertStableError).message).toContain(
      'chronological log of state mutations during the window',
    );
  });

  test('initial-never-reached case: initial predicate stays false', async () => {
    const harness = harnessWithState(baseState({ connected: false }));

    await expect(
      assertStable(harness.setup, {
        condition: (snap) => snap.state.connected,
        initial: (snap) => snap.state.connected,
        settle_ms: 10,
        quiet_window_ms: 10,
        max_wait_ms: 100,
      }),
    ).rejects.toMatchObject({
      kind: 'initial_state_never_reached',
      message: expect.stringContaining('initial state never reached'),
    });

    await expect(
      assertStable(harness.setup, {
        condition: (snap) => snap.state.connected,
        initial: (snap) => snap.state.connected,
        settle_ms: 1,
        quiet_window_ms: 1,
        max_wait_ms: 100,
      }),
    ).rejects.toThrow('"connected": false');
  });

  test('max-wait-exceeded case: max_wait bounds a still-true but too-long quiet window', async () => {
    const harness = harnessWithState();
    const condition: AssertStablePredicate = (snap) => snap.state.connected;

    await expect(
      assertStable(harness.setup, {
        condition,
        initial: condition,
        settle_ms: 20,
        quiet_window_ms: 80,
        max_wait_ms: 10,
      }),
    ).rejects.toMatchObject({
      kind: 'max_wait_exceeded',
      message: expect.stringContaining('max_wait exceeded'),
    });
  });

  test('a stalled phase-one poll reports the earlier expired deadline', async () => {
    const settleFirst = harnessWithState(baseState({ connected: false }));
    let settleFirstNow = 0;
    settleFirst.setup.monotonic = () => settleFirstNow;
    settleFirst.setup.flush = async () => {
      settleFirstNow = 150;
    };
    await expect(assertStable(settleFirst.setup, {
      condition: (snap) => snap.state.connected,
      initial: (snap) => snap.state.connected,
      settle_ms: 10,
      quiet_window_ms: 10,
      max_wait_ms: 100,
    })).rejects.toMatchObject({ kind: 'initial_state_never_reached' });

    const maxFirst = harnessWithState(baseState({ connected: false }));
    let maxFirstNow = 0;
    maxFirst.setup.monotonic = () => maxFirstNow;
    maxFirst.setup.flush = async () => {
      maxFirstNow = 150;
    };
    await expect(assertStable(maxFirst.setup, {
      condition: (snap) => snap.state.connected,
      initial: (snap) => snap.state.connected,
      settle_ms: 100,
      quiet_window_ms: 10,
      max_wait_ms: 10,
    })).rejects.toMatchObject({ kind: 'max_wait_exceeded' });
  });

  test('FlatList-remount-equivalence case: same row_id set with new React identities passes', async () => {
    const before = baseState({
      events: [rowEvent('row-a', 'native-1', 1), rowEvent('row-b', 'native-2', 2)],
    });
    const after = baseState({
      events: [rowEvent('row-b', 'native-9', 2), rowEvent('row-a', 'native-8', 1)],
    });
    const harness = harnessWithState(before);

    expect(rowIdsStable(before, after)).toBe(true);

    setTimeout(() => {
      harness.setState(after);
    }, 5);

    const result = await assertStable(harness.setup, {
      condition: 'row_ids_stable',
      initial: 'required',
      settle_ms: 20,
      quiet_window_ms: 30,
      max_wait_ms: 100,
    });

    expect(result.ok).toBe(true);
  });

  test('row_ids_stable ignores unrelated streams', async () => {
    const before = baseState({
      events: [
        rowEvent('row-a', 'native-1', 1),
        rowEvent('row-b', 'native-2', 2),
        rowEvent('noise-row-a', 'native-noise-1', 1, NOISE_STREAM_ID),
      ],
    });
    const after = baseState({
      events: [
        rowEvent('row-a', 'native-8', 1),
        rowEvent('row-b', 'native-9', 2),
        rowEvent('noise-row-b', 'native-noise-2', 2, NOISE_STREAM_ID),
      ],
    });
    const harness = harnessWithState(before);

    expect(rowIdsStable(before, after)).toBe(false);
    expect(rowIdsStable(before, after, STREAM_ID)).toBe(true);

    setTimeout(() => {
      harness.setState(after);
    }, 5);

    const result = await assertStable(harness.setup, {
      condition: 'row_ids_stable',
      initial: 'required',
      settle_ms: 20,
      quiet_window_ms: 30,
      max_wait_ms: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.mutations.length).toBeGreaterThan(1);
  });

  test('transcript_count_unchanged ignores unrelated streams', async () => {
    const before = baseState({
      events: [
        rowEvent('row-a', 'native-1', 1),
        rowEvent('row-b', 'native-2', 2),
        rowEvent('noise-row-a', 'native-noise-1', 1, NOISE_STREAM_ID),
      ],
    });
    const after = baseState({
      events: [
        rowEvent('row-a', 'native-1', 1),
        rowEvent('row-b', 'native-2', 2),
        rowEvent('noise-row-a', 'native-noise-1', 1, NOISE_STREAM_ID),
        rowEvent('noise-row-b', 'native-noise-2', 2, NOISE_STREAM_ID),
      ],
    });
    const harness = harnessWithState(before);

    setTimeout(() => {
      harness.setState(after);
    }, 5);

    const result = await assertStable(harness.setup, {
      condition: 'transcript_count_unchanged',
      initial: 'required',
      settle_ms: 20,
      quiet_window_ms: 30,
      max_wait_ms: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.mutations.length).toBeGreaterThan(1);
  });

  test('race-on-max-wait: initial true exactly at max_wait expiry fails deterministically', async () => {
    const harness = harnessWithState();

    await expect(
      assertStable(
        {
          ...harness.setup,
          monotonic: () => 0,
        },
        {
          condition: (snap) => snap.state.connected,
          initial: (snap) => snap.state.connected,
          settle_ms: 10,
          quiet_window_ms: 0,
          max_wait_ms: 0,
        },
      ),
    ).rejects.toMatchObject({
      kind: 'max_wait_exceeded',
      message: expect.stringContaining('max_wait exceeded'),
    });
  });
});
