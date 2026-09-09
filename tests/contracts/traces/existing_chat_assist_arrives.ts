// Bug C — existing chat live render.
//
// Scenario: user opens an existing chat that is already idle; a fresh assistant
// message arrives from the daemon. The assist row MUST render in-place WITHOUT
// an intervening screen unmount-remount cycle (that's the Bug C class). The
// composer state and the dock state are not disturbed.

import type { TraceContract } from './types';

export const EXISTING_CHAT_ASSIST_ARRIVES: TraceContract = {
  name: 'existing_chat_assist_arrives',
  fixture: 'claude_existing_chat_assist_v1',
  description:
    'Existing chat is open and idle; daemon emits ASSIST; assist row renders without a ' +
    'screen unmount-remount cycle (Bug C class).',
  steps: [
    // Step 0: precondition — chat screen is mounted and the turn is idle.
    {
      actor: 'screen',
      effect: 'session_screen_mounted',
      assert: (snap) => snap.observers.screen.isMountedByTestID('session-screen'),
      assertLabel: 'session-screen testID is mounted before the assist arrives',
      t: 'sameTick',
    },

    {
      actor: 'reducer',
      effect: 'turn_idle_before_assist',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.phase === 'idle' || { ok: false, msg: 'turn must be idle before the assist arrives' };
      },
      assertLabel: "turn.phase === 'idle' before assist",
      t: 'sameTick',
    },

    // Step 2: daemon ASSIST — claude-jsonl assistant row from the fixture (row 0).
    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { text: 'I am Claude, continuing this thread.' },
      fixtureRow: 0,
      t: '<200ms',
    },

    // Step 3 (NEGATIVE): the session-screen MUST NOT unmount during the live-render
    // window. Spec §"Bug C negative-step example" — window covers the next 3 steps.
    {
      not: { actor: 'screen', effect: 'session_screen_unmounts' },
      within_steps: 3,
      assertLabel: 'Bug C — assist_row must render without an unmount-remount cycle',
    },

    // Step 4: assist row renders in-place.
    {
      actor: 'screen',
      effect: 'assist_row_renders',
      assert: (snap) => {
        const text = snap.observers.screen.queryTextByTestID('assist-row');
        return (text?.includes('Claude') ?? false) || {
          ok: false,
          msg: `assist-row should contain "Claude", got ${JSON.stringify(text)}`,
        };
      },
      assertLabel: 'assist-row contains the new assist text',
      t: '<50ms',
    },

    // Step 5: session screen is still the same instance — wasMountedAtAnyPoint
    // and isMounted both true. (If an unmount-remount cycle happened the
    // negative step at index 3 would already have fired.)
    {
      actor: 'screen',
      effect: 'session_screen_still_mounted',
      assert: (snap) =>
        snap.observers.screen.isMountedByTestID('session-screen') &&
        snap.observers.screen.wasMountedAtAnyPointByTestID('session-screen'),
      assertLabel: 'session-screen remains mounted across the assist arrival',
      t: 'sameTick',
    },

    // Step 6: composer remains unchanged.
    {
      actor: 'composer',
      effect: 'composer_undisturbed',
      assert: (snap) => !snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'composer send button is still enabled after passive assist arrival',
      t: 'sameTick',
    },

    // Step 7: turn-duration closes the daemon-emitted activity.
    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: { subtype: 'turn_duration', durationMs: 520 },
      fixtureRow: 1,
      t: 'end',
    },
  ],
};
