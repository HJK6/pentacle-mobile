// Codex terminal furniture never reaches the transcript.
//
// Scenario: a codex turn emits multiple terminal-divider candidates (the codex
// CLI prints repeated "─ Worked for Xs ──" rows). The mobile reducer must
// filter every row so no divider mounts in the conversation surface.
//
// Daemon events mirror the upstream codex shapes in
// tests/contracts/fixtures/codex_three_dividers_v1.jsonl. The
// terminal-divider derivation itself is synthetic in the upstream fixture —
// the daemon synthesizes divider events from codex stdout — so the divider
// daemon events here are marked SYNTHETIC.

import type { TraceContract } from './types';

export const CODEX_SINGLE_DIVIDER_PER_TURN: TraceContract = {
  name: 'codex_single_divider_per_turn',
  fixture: 'codex_three_dividers_v1',
  description:
    'Codex turn emits multiple terminal-divider candidates; no divider row mounts in the conversation surface.',
  steps: [
    { actor: 'user', action: 'composer_press_send', payload: { text: 'hello from codex' }, t: 'sameTick' },

    // Daemon USER ack — codex history append. Row 0 of the fixture.
    {
      actor: 'daemon',
      event: 'USER',
      payload: { text: 'hello from codex' },
      fixtureRow: 0,
      t: 'sameTick',
    },

    {
      actor: 'reducer',
      effect: 'turn_pending',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.phase === 'pending' || turn?.phase === 'working' || {
          ok: false,
          msg: `turn phase should be pending|working, got ${turn?.phase ?? '<no turn>'}`,
        };
      },
      assertLabel: "turn.phase in {'pending','working'}",
      t: 'sameTick',
    },

    // First divider — core presentation must filter it.
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { source: 'codex', subtype: 'terminal-divider', text: 'Worked for 1s' },
      // SYNTHETIC: codex stdout produces multiple visual divider rows; the daemon
      // synthesizes a SYSTEM terminal-divider event per row. The upstream fixture
      // captures the codex history row but not the synthesized divider — the
      // mobile reducer's coalescer is exercised against this synthesized shape.
      synthetic: true,
      t: '<50ms',
    },

    {
      actor: 'screen',
      effect: 'divider_row_absent',
      assert: (snap) => !snap.observers.screen.isMountedByTestID('divider-row'),
      assertLabel: 'divider-row stays absent after terminal furniture',
      t: '<50ms',
    },

    // Second + third divider remain filtered.
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { source: 'codex', subtype: 'terminal-divider', text: 'Worked for 2s' },
      synthetic: true,
      t: '<50ms',
    },

    // NEGATIVE: a second divider-row mount MUST NOT happen in the turn window.
    // The window spans the next 3 steps (third divider + turn-duration + final
    // assert) — long enough to cover all subsequent dividers in this turn.
    {
      not: { actor: 'screen', effect: 'divider_row_mounts' },
      within_steps: 3,
      assertLabel: 'divider-row must never mount in the conversation surface',
    },

    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { source: 'codex', subtype: 'terminal-divider', text: 'Worked for 3s' },
      synthetic: true,
      t: '<50ms',
    },

    // Daemon turn-end — row 1 of the fixture.
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { source: 'codex', subtype: 'turn_duration', durationMs: 2400 },
      fixtureRow: 1,
      t: 'end',
    },

    {
      actor: 'screen',
      effect: 'divider_row_count_is_zero',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        const count = turn?.dividerCount ?? (snap.observers.screen.isMountedByTestID('divider-row') ? 1 : 0);
        return count === 0 || {
          ok: false,
          msg: `expected no divider rows in the turn, observed ${count}`,
        };
      },
      assertLabel: 'no divider rows in the turn window',
      t: 'sameTick',
    },
  ],
};
