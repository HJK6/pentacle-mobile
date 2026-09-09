// Bug A — composer newline submission.
//
// Scenario: user types a multi-line message containing a newline, then presses the
// send button. Exactly one `sendMessage` action MUST fire (positive path). The
// return-key path MUST NOT fire `sendMessage` on its own — that's the bug class.
//
// Daemon events here mirror real claude-jsonl shapes from the upstream pentacle
// fixtures (see tests/contracts/fixtures/composer_send_with_newline_v1.jsonl).
// Events not present in the fixture are flagged SYNTHETIC inline.

import type { TraceContract } from './types';

export const COMPOSER_SEND_WITH_NEWLINE: TraceContract = {
  name: 'composer_send_with_newline',
  fixture: 'composer_send_with_newline_v1',
  description:
    'User types multiline text with a newline character. Return-key press alone MUST NOT submit; ' +
    'tapping the send button MUST submit exactly once. After submission the composer optimistic ' +
    'user row appears and the daemon ack arrives.',
  steps: [
    // Step 0: user focuses + types a multiline string into the composer.
    { actor: 'user', action: 'composer_change_text', payload: { text: 'line one\nline two' }, t: 'sameTick' },

    // Step 1: composer reflects the new text (no submit yet).
    {
      actor: 'composer',
      effect: 'composer_text_includes_newline',
      assert: (snap) => {
        const text = snap.observers.composer.composerText();
        return text.includes('\n')
          ? { ok: true }
          : { ok: false, msg: `composer text "${text}" does not include a newline` };
      },
      assertLabel: 'composer text retains the embedded newline',
      t: 'sameTick',
    },

    // Step 2: user presses Return key inside the multi-line composer.
    { actor: 'user', action: 'composer_submit_editing', t: 'sameTick' },

    // Step 3 (NEGATIVE): the return-key path MUST NOT trigger sendMessage. Window
    // spans the next 2 steps (covering the post-return tick and the send-button press
    // that follows). Listener installs BEFORE the preceding act() flush so a
    // synchronous same-tick violation is captured.
    {
      not: { actor: 'user', action: 'actions.sendMessage' },
      within_steps: 2,
      assertLabel: 'Bug A — actions.sendMessage MUST NOT fire on return-key path',
    },

    // Step 4: user taps the send button.
    { actor: 'user', action: 'composer_press_send', t: 'sameTick' },

    // Step 5: sendMessage fires exactly once via the send-button path.
    { actor: 'user', action: 'actions.sendMessage', payload: { text: 'line one\nline two' }, t: 'sameTick' },

    // Step 6: optimistic user message is appended in the reducer.
    {
      actor: 'reducer',
      effect: 'append_optimistic_user',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.phase === 'pending'
          ? { ok: true }
          : { ok: false, msg: `expected turn.phase === 'pending', got ${turn?.phase ?? '<no turn>'}` };
      },
      assertLabel: "turn.phase === 'pending' after optimistic append",
      t: 'sameTick',
    },

    // Step 7: sending status mounts so the user gets immediate feedback.
    {
      actor: 'screen',
      effect: 'sending_status_mounts',
      assert: (snap) => snap.observers.screen.isMountedByTestID('status-tag-sending'),
      assertLabel: 'sending status tag is mounted',
      t: 'sameTick',
    },

    // Step 8: send button disables while in-flight.
    {
      actor: 'composer',
      effect: 'send_button_disabled',
      assert: (snap) => snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'send button is disabled while turn is pending',
      t: 'sameTick',
    },

    // Step 9: daemon ack — claude-jsonl assistant text row from the fixture (row 1).
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { text: 'got it' },
      fixtureRow: 1,
      t: '<200ms',
    },

    // Step 10: assist row renders.
    {
      actor: 'screen',
      effect: 'assist_row_renders',
      assert: (snap) => {
        const rendered = snap.observers.screen.queryTextByTestID('assist-row');
        return rendered != null && rendered.includes('got it')
          ? { ok: true }
          : { ok: false, msg: `assist-row text was ${JSON.stringify(rendered)}` };
      },
      assertLabel: 'assist-row contains daemon reply text',
      t: '<50ms',
    },

    // Step 11: turn ends.
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { source: 'claude-jsonl', subtype: 'turn-summary' },
      // SYNTHETIC: turn-end shape borrowed from the existing sessionScreenWorkingDock
      // test pattern. The upstream fixture has no explicit SYSTEM turn-summary row;
      // the daemon synthesizes one when claude-jsonl emits durationMs.
      synthetic: true,
      t: 'end',
    },
    {
      actor: 'reducer',
      effect: 'phase_returns_to_idle',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.phase === 'idle'
          ? { ok: true }
          : { ok: false, msg: `expected turn.phase === 'idle', got ${turn?.phase ?? '<no turn>'}` };
      },
      assertLabel: "turn.phase === 'idle' after turn-summary",
      t: 'sameTick',
    },
  ],
};
