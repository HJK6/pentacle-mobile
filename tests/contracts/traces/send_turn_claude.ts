// Bug B reference — claude full-turn lifecycle.
//
// Scenario: user sends a message; optimistic insert appears; working dock mounts;
// daemon emits assist text + turn-duration; working dock unmounts; send button
// re-enables. A trailing negative step asserts the working dock does NOT re-mount
// after the turn ends (a Bug-D-class regression class — even though the Bug D
// trace itself ships in a follow-up, this baseline catches the same regression
// shape in the claude lane).
//
// Daemon events mirror real claude-jsonl shapes from
// tests/contracts/fixtures/claude_simple_reply_v1.jsonl. Events not present in
// the fixture are flagged SYNTHETIC inline.

import type { TraceContract } from './types';

export const SEND_TURN_CLAUDE: TraceContract = {
  name: 'send_turn_claude',
  fixture: 'claude_simple_reply_v1',
  description:
    'User sends one message; assistant replies "hosta online"; working dock mounts then ' +
    'unmounts cleanly. Negative step: the dock must NOT re-mount after turn end.',
  steps: [
    { actor: 'user', action: 'composer_press_send', payload: { text: 'hi' }, t: 'sameTick' },

    {
      actor: 'reducer',
      effect: 'append_optimistic_user',
      assert: (snap) =>
        snap.observers.reducer.getTurn(snap.streamId)?.phase === 'pending' || {
          ok: false,
          msg: 'turn phase should be "pending" after optimistic append',
        },
      assertLabel: "turn.phase === 'pending'",
      t: 'sameTick',
    },

    {
      actor: 'screen',
      effect: 'working_dock_mounts',
      assert: (snap) => snap.observers.screen.isMountedByTestID('working-dock'),
      assertLabel: 'working-dock mounts after press_send',
      t: 'sameTick',
    },

    {
      actor: 'composer',
      effect: 'send_button_disabled',
      assert: (snap) => snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'send button is disabled during the pending+working window',
      t: 'sameTick',
    },

    // Daemon WORKING event — first server-side signal. Daemon wraps the upstream
    // claude-jsonl assistant message in a WORKING update before the ASSIST row
    // arrives.
    {
      actor: 'daemon',
      event: 'WORKING',
      payload: { working: true, working_label: '' },
      // SYNTHETIC: pentacle daemon synthesizes a WORKING update from the upstream
      // assistant message arrival; no dedicated WORKING row exists in the
      // upstream fixture.
      synthetic: true,
      t: '<50ms',
    },

    {
      actor: 'reducer',
      effect: 'phase_transitions_to_working',
      assert: (snap) =>
        snap.observers.reducer.getTurn(snap.streamId)?.phase === 'working' || {
          ok: false,
          msg: 'turn phase should be "working" after first server event',
        },
      assertLabel: "turn.phase === 'working'",
      t: 'sameTick',
    },

    {
      actor: 'screen',
      effect: 'timer_starts',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.firstServerEventAt != null || {
          ok: false,
          msg: 'turn.firstServerEventAt should be set once the first server event arrives',
        };
      },
      assertLabel: 'working dock timer starts after first server event',
      t: 'sameTick',
    },

    // Daemon ASSIST — claude-jsonl assistant row from the fixture (row 0).
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { text: 'hosta online' },
      fixtureRow: 0,
      t: 'any',
    },

    {
      actor: 'screen',
      effect: 'assist_row_renders',
      assert: (snap) => {
        const text = snap.observers.screen.queryTextByTestID('assist-row');
        return (text?.startsWith('hosta online') ?? false) || {
          ok: false,
          msg: `assist-row should start with "hosta online", got ${JSON.stringify(text)}`,
        };
      },
      assertLabel: 'assist-row renders daemon reply',
      t: '<50ms',
    },

    // Daemon turn-duration — system row from the fixture (row 1).
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { subtype: 'turn_duration', durationMs: 1842 },
      fixtureRow: 1,
      t: 'end',
    },

    {
      actor: 'reducer',
      effect: 'phase_transitions_to_idle',
      assert: (snap) =>
        snap.observers.reducer.getTurn(snap.streamId)?.phase === 'idle' || {
          ok: false,
          msg: 'turn phase should be "idle" after turn-duration',
        },
      assertLabel: "turn.phase === 'idle'",
      t: 'sameTick',
    },

    {
      actor: 'screen',
      effect: 'working_dock_unmounts',
      assert: (snap) => !snap.observers.screen.isMountedByTestID('working-dock'),
      assertLabel: 'working-dock unmounts after turn-duration',
      t: '<50ms',
    },

    {
      actor: 'composer',
      effect: 'send_button_enabled',
      assert: (snap) => !snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'send button is re-enabled after turn end',
      t: 'sameTick',
    },

    // Negative: working dock must not re-mount through the rest of this trace.
    {
      not: { actor: 'screen', effect: 'working_dock_mounts' },
      within_steps: 100,
      assertLabel: 'working-dock MUST NOT re-mount after turn end',
    },
  ],
};
