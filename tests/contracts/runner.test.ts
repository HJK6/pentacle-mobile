// Unit tests for the trace-contract runner. Uses the in-memory fake daemon harness
// so the runner can be exercised without any RN component tree.

import {
  createFakeDaemonHarness,
  runTrace,
  type FakeDaemonHarness,
  type TraceContract,
} from './traces';

const STREAM_ID = 'hostc:claude:alpha';

function blankTrace(steps: TraceContract['steps'], name = 't_blank'): TraceContract {
  return { name, fixture: 'unused', description: 'unit test', steps };
}

function makeHarness(): FakeDaemonHarness {
  return createFakeDaemonHarness({ streamId: STREAM_ID });
}

describe('runTrace — positive ordering', () => {
  test('passes a trivial all-positive trace', async () => {
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      injectDaemonEvent: async (step, h) => {
        h.emit({ source: 'daemon', name: step.event, payload: step.payload });
        h.setTextByTestID('assist-row', 'hi');
      },
    });
    const trace = blankTrace([
      { actor: 'user', action: 'tap' },
      { actor: 'daemon', event: 'ASSIST', payload: { text: 'hi' } },
      {
        actor: 'screen',
        effect: 'assist_row_renders',
        assert: (snap) => snap.observers.screen.queryTextByTestID('assist-row') === 'hi',
      },
    ]);

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(true);
    expect(result.failedAtStep).toBeUndefined();
    expect(result.observedSequence.length).toBeGreaterThanOrEqual(2);
    const names = result.observedSequence.map((e) => e.name);
    expect(names).toContain('tap');
    expect(names).toContain('ASSIST');
  });

  test('fails a positive step when its assert returns false', async () => {
    const harness = makeHarness();
    const trace = blankTrace([
      { actor: 'user', action: 'tap' },
      {
        actor: 'reducer',
        effect: 'never_true',
        assert: () => ({ ok: false, msg: 'predicate intentionally returns false' }),
        assertLabel: 'never_true',
      },
    ]);

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(false);
    expect(result.failedAtStep?.index).toBe(1);
    expect(result.failedAtStep?.reason.kind).toBe('positive_step_assert_failed');
    expect(result.failedAtStep?.reason.message).toBe('predicate intentionally returns false');
  });
});

describe('runTrace — negative steps', () => {
  test('captures a synchronous same-tick negative violation (listener installs before act flush)', async () => {
    // The injectDaemonEvent override fires the negated event synchronously, before
    // any explicit flush could happen. The runner must arm the negative-step
    // listener BEFORE invoking the preceding positive step's action so this
    // violation is captured.
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      injectDaemonEvent: async (step, h) => {
        // Synchronously emit BOTH the daemon event and an extra "screen" event that
        // matches the upcoming negative step.
        h.emit({ source: 'daemon', name: step.event });
        h.emit({ source: 'screen', name: 'working_dock_mounts' });
      },
    });

    const trace = blankTrace([
      { actor: 'daemon', event: 'TURN_END' },
      {
        not: { actor: 'screen', effect: 'working_dock_mounts' },
        within_steps: 5,
        assertLabel: 'working-dock MUST NOT re-mount after TURN_END',
      },
    ]);

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(false);
    expect(result.failedAtStep?.reason.kind).toBe('negative_step_violation');
    expect(result.failedAtStep?.reason.message).toBe(
      'working-dock MUST NOT re-mount after TURN_END',
    );
    expect(result.failedAtStep?.reason.offendingEvent?.name).toBe('working_dock_mounts');
  });

  test('negative step passes when the negated event never fires inside the window', async () => {
    const harness = makeHarness();
    const trace = blankTrace([
      { actor: 'daemon', event: 'TURN_END' },
      {
        not: { actor: 'screen', effect: 'working_dock_mounts' },
        within_steps: 3,
        assertLabel: 'working-dock MUST NOT re-mount after TURN_END',
      },
      { actor: 'user', action: 'noop_1' },
      { actor: 'user', action: 'noop_2' },
      { actor: 'user', action: 'noop_3' },
    ]);

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(true);
  });

  test('negative step decays after within_steps elapses (violation after window does not fail trace)', async () => {
    const harness = makeHarness();
    const trace = blankTrace([
      { actor: 'daemon', event: 'TURN_END' },
      // Window of 1 step.
      {
        not: { actor: 'screen', effect: 'working_dock_mounts' },
        within_steps: 1,
      },
      { actor: 'user', action: 'after_window' },
      // Violation here is outside the window (the negative was armed at index 1 and
      // window=1, so by the time we hit index 3 the negative is disarmed).
      {
        actor: 'user',
        action: 'trigger_violation',
      },
    ]);

    // Drive the violation in step 3's user action via a wrapper harness.
    const wrappedHarness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      driveUserAction: async (step, h) => {
        h.emit({ source: 'user', name: step.action });
        if (step.action === 'trigger_violation') {
          h.emit({ source: 'screen', name: 'working_dock_mounts' });
        }
      },
    });

    const result = await runTrace(trace, wrappedHarness.setup);

    expect(result.ok).toBe(true);
    // Sanity: the violating event WAS emitted; it just landed outside the window.
    expect(wrappedHarness.setup.observers.screen.wasMountedAtAnyPointByTestID('working-dock')).toBe(
      false,
    );
    // Used a direct effect event instead of setMounted, so wasMounted-tracking won't
    // light up — but the event will be in the observedSequence.
    expect(
      result.observedSequence.some((e) => e.name === 'working_dock_mounts'),
    ).toBe(true);
  });
});

describe('runTrace — failure-message quality (M9)', () => {
  test('failure report includes step index, step object, last events, and assert message', async () => {
    const harness = makeHarness();
    const trace = blankTrace(
      [
        { actor: 'user', action: 'first' },
        { actor: 'user', action: 'second' },
        { actor: 'user', action: 'third' },
        {
          actor: 'reducer',
          effect: 'fail_here',
          assert: () => ({ ok: false, msg: 'intentional failure for report assertion' }),
          assertLabel: 'fail_here_label',
        },
      ],
      'failure_report_trace',
    );

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(false);
    expect(result.failureReport).toBeTruthy();
    const report = result.failureReport!;
    expect(report).toContain('Trace `failure_report_trace` failed at step 3');
    expect(report).toContain('intentional failure for report assertion');
    // last observed events table
    expect(report).toContain('| ts_monotonic | source | name | payload |');
    expect(report).toContain('| ---: | --- | --- | --- |');
    expect(report).toContain('first');
    expect(report).toContain('second');
    expect(report).toContain('third');
    // step object should be JSON-stringified (with assert fn redacted)
    expect(report).toContain('"effect": "fail_here"');
    expect(report).toContain('<assert fn>');
  });

  test('negative-step failure report includes the offending event', async () => {
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      injectDaemonEvent: async (step, h) => {
        h.emit({ source: 'daemon', name: step.event });
        h.emit({ source: 'screen', name: 'dock_mounts' });
      },
    });
    const trace = blankTrace([
      { actor: 'daemon', event: 'TICK' },
      { not: { actor: 'screen', effect: 'dock_mounts' }, within_steps: 5, assertLabel: 'no dock' },
    ]);

    const result = await runTrace(trace, harness.setup);

    expect(result.ok).toBe(false);
    expect(result.failureReport).toContain('Offending event');
    expect(result.failureReport).toContain('"name": "dock_mounts"');
  });
});

describe('runTrace — jest parallel safety (M10)', () => {
  test('two runTrace invocations execute concurrently without cross-contaminating event logs', async () => {
    const harnessA = createFakeDaemonHarness({ streamId: 'stream:A' });
    const harnessB = createFakeDaemonHarness({ streamId: 'stream:B' });

    const traceA = blankTrace(
      [
        { actor: 'user', action: 'A-tap' },
        { actor: 'daemon', event: 'A-EVENT', payload: { tag: 'A' } },
        {
          actor: 'reducer',
          effect: 'A-reducer-check',
          assert: (snap) =>
            snap.streamId === 'stream:A' && snap.observed.some((e) => e.name === 'A-EVENT'),
        },
      ],
      'parallel-A',
    );

    const traceB = blankTrace(
      [
        { actor: 'user', action: 'B-tap' },
        { actor: 'daemon', event: 'B-EVENT', payload: { tag: 'B' } },
        {
          actor: 'reducer',
          effect: 'B-reducer-check',
          assert: (snap) =>
            snap.streamId === 'stream:B' && snap.observed.some((e) => e.name === 'B-EVENT'),
        },
      ],
      'parallel-B',
    );

    const [resultA, resultB] = await Promise.all([
      runTrace(traceA, harnessA.setup),
      runTrace(traceB, harnessB.setup),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const namesA = resultA.observedSequence.map((e) => e.name);
    const namesB = resultB.observedSequence.map((e) => e.name);
    expect(namesA).toContain('A-tap');
    expect(namesA).toContain('A-EVENT');
    expect(namesA).not.toContain('B-tap');
    expect(namesA).not.toContain('B-EVENT');
    expect(namesB).toContain('B-tap');
    expect(namesB).toContain('B-EVENT');
    expect(namesB).not.toContain('A-tap');
    expect(namesB).not.toContain('A-EVENT');
  });

  test('createFakeDaemonHarness returns a fresh instance each call (no module-level state)', () => {
    const a = createFakeDaemonHarness({ streamId: 'x' });
    const b = createFakeDaemonHarness({ streamId: 'x' });
    expect(a).not.toBe(b);
    expect(a.setup).not.toBe(b.setup);
    a.setMounted('foo', true);
    expect(a.setup.observers.screen.isMountedByTestID('foo')).toBe(true);
    expect(b.setup.observers.screen.isMountedByTestID('foo')).toBe(false);
  });
});

describe('runTrace — out-of-order detection', () => {
  test('stale screen state that was already true before the driver step does not satisfy an effect', async () => {
    const harness = createFakeDaemonHarness({ streamId: STREAM_ID });
    harness.setMounted('working-dock', true);

    const trace = blankTrace([
      { actor: 'daemon', event: 'WORKING' },
      {
        actor: 'screen',
        effect: 'working_dock_mounts',
        assert: (snap) => snap.observers.screen.isMountedByTestID('working-dock'),
        assertLabel: 'working-dock mounts because of this WORKING event',
        t: 'sameTick',
      },
    ]);

    const result = await runTrace(trace, harness.setup);
    expect(result.ok).toBe(false);
    expect(result.failedAtStep?.index).toBe(1);
    expect(result.failedAtStep?.reason.kind).toBe('positive_step_timeout');
  });

  test('screen effects emitted before the expected daemon step do not satisfy the later effect step', async () => {
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      driveUserAction: async (step, h) => {
        h.emit({ source: 'user', name: step.action });
        h.setTextByTestID('assist-row', 'stale assist text');
      },
    });

    const trace = blankTrace([
      { actor: 'user', action: 'seed_stale_assist' },
      { actor: 'daemon', event: 'ASSIST', payload: { text: 'fresh assist text' } },
      {
        actor: 'screen',
        effect: 'assist_row_renders',
        assert: (snap) => snap.observers.screen.queryTextByTestID('assist-row') === 'stale assist text',
        assertLabel: 'assist-row renders because of this ASSIST event',
        t: 'sameTick',
      },
    ]);

    const result = await runTrace(trace, harness.setup);
    expect(result.ok).toBe(false);
    expect(result.failedAtStep?.index).toBe(2);
    expect(result.failedAtStep?.reason.kind).toBe('positive_step_timeout');
  });

  test('reducer assert that expects state set by a later daemon event fails fast', async () => {
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      injectDaemonEvent: async (step, h) => {
        if (step.event === 'WORKING') {
          h.patchState({
            sessions: [
              {
                stream_id: STREAM_ID,
                host: 'hostc',
                provider: 'claude',
                session_name: 'alpha',
                last_event_at: '2026-05-16T00:00:00.000Z',
                last_text: '',
                last_kind: 'WORKING',
                draft: '',
                pending: false,
                working: true,
                online: true,
              },
            ],
            workingStates: {
              [STREAM_ID]: {
                stream_id: STREAM_ID,
                timestamp: '2026-05-16T00:00:00.000Z',
                tokens_input: 0,
                tokens_output: 0,
                tokens_cache_read: 0,
                tokens_cache_creation: 0,
                tokens_phase: 'down',
                shell_count_started: 0,
                tasks: [],
                task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
                elapsed_ms: 0,
              },
            },
          });
        }
        h.emit({ source: 'daemon', name: step.event });
      },
    });

    // Assert that turn is "working" BEFORE the WORKING event has been injected.
    const trace = blankTrace([
      {
        actor: 'reducer',
        effect: 'turn_should_already_be_working_oops',
        assert: (snap) =>
          snap.observers.reducer.getTurn(snap.streamId)?.phase === 'working' || {
            ok: false,
            msg: 'turn is not yet in working state (the trace asserts out of order)',
          },
      },
      { actor: 'daemon', event: 'WORKING' },
    ]);

    const result = await runTrace(trace, harness.setup);
    expect(result.ok).toBe(false);
    expect(result.failedAtStep?.index).toBe(0);
    expect(result.failedAtStep?.reason.kind).toBe('positive_step_assert_failed');
  });

  test('same trace passes when steps are in the correct order', async () => {
    const harness = createFakeDaemonHarness({
      streamId: STREAM_ID,
      injectDaemonEvent: async (step, h) => {
        if (step.event === 'WORKING') {
          h.patchState({
            sessions: [
              {
                stream_id: STREAM_ID,
                host: 'hostc',
                provider: 'claude',
                session_name: 'alpha',
                last_event_at: '2026-05-16T00:00:00.000Z',
                last_text: '',
                last_kind: 'WORKING',
                draft: '',
                pending: false,
                working: true,
                online: true,
              },
            ],
            workingStates: {
              [STREAM_ID]: {
                stream_id: STREAM_ID,
                timestamp: '2026-05-16T00:00:00.000Z',
                tokens_input: 0,
                tokens_output: 0,
                tokens_cache_read: 0,
                tokens_cache_creation: 0,
                tokens_phase: 'down',
                shell_count_started: 0,
                tasks: [],
                task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
                elapsed_ms: 0,
              },
            },
          });
        }
        h.emit({ source: 'daemon', name: step.event });
      },
    });

    const trace = blankTrace([
      { actor: 'daemon', event: 'WORKING' },
      {
        actor: 'reducer',
        effect: 'turn_is_working_after_event',
        assert: (snap) => snap.observers.reducer.getTurn(snap.streamId)?.phase === 'working',
      },
    ]);

    const result = await runTrace(trace, harness.setup);
    expect(result.ok).toBe(true);
  });
});
