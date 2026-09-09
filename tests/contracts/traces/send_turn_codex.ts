// Bug D — codex turn lifecycle and dock-dismiss contract.
//
// Scenario: user sends a codex turn; the optimistic pending phase appears
// immediately; the first codex reply preserves the user-send anchor; the codex
// terminal divider closes the turn; the working dock MUST NOT re-mount after the
// end-of-turn event.
//
// Daemon events mirror codex fixture shapes in
// tests/contracts/fixtures/codex_simple_reply_v1.jsonl. The progressive_update row
// is hand-written fixture coverage until a captured upstream codex row is available;
// the terminal-divider row is the real chat-stream pane parser shape covered by
// pentacle/services/chat-stream/tests/test_chat_streamd.py.

import type { TraceContract } from './types';

export const SEND_TURN_CODEX: TraceContract = {
  name: 'send_turn_codex',
  fixture: 'codex_simple_reply_v1',
  description:
    'User sends one codex message; assistant reply arrives; verbose dock timing keeps the ' +
    'user-send anchor; codex terminal-divider closes the turn and the dock stays dismissed.',
  steps: [
    { actor: 'user', action: 'composer_press_send', payload: { text: 'hello from codex' }, t: 'sameTick' },

    {
      actor: 'reducer',
      effect: 'append_optimistic_user',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId) as
          | ({ sentAt?: number; optimisticId?: string; phase: string })
          | undefined;
        return turn?.phase === 'pending' && typeof turn.sentAt === 'number'
          ? { ok: true }
          : { ok: false, msg: `expected pending turn with sentAt, got ${JSON.stringify(turn)}` };
      },
      assertLabel: "turn.phase === 'pending' and turn.sentAt records user-send anchor",
      t: 'sameTick',
    },

    {
      actor: 'screen',
      effect: 'working_dock_mounts',
      assert: (snap) => snap.observers.screen.isMountedByTestID('working-dock'),
      assertLabel: 'working-dock mounts immediately after codex send',
      t: 'sameTick',
    },

    {
      actor: 'composer',
      effect: 'send_button_disabled',
      assert: (snap) => snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'send button is disabled while codex turn is in flight',
      t: 'sameTick',
    },

    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { source: 'codex-jsonl', subtype: 'progressive_update', text: 'codex rep' },
      fixtureRow: 1,
      t: '<200ms',
    },

    {
      actor: 'reducer',
      effect: 'phase_transitions_to_working_with_user_send_anchor',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId) as
          | ({ phase: string; sentAt?: number; firstServerEventAt?: number | null })
          | undefined;
        const anchorOk =
          typeof turn?.sentAt === 'number' &&
          typeof turn?.firstServerEventAt === 'number' &&
          turn.sentAt <= turn.firstServerEventAt;
        return turn?.phase === 'working' && anchorOk
          ? { ok: true }
          : { ok: false, msg: `expected working turn preserving user-send anchor, got ${JSON.stringify(turn)}` };
      },
      assertLabel: 'verbose dock timer has reducer user-send anchor available on codex reply',
      t: 'sameTick',
    },

    {
      actor: 'daemon',
      event: 'ASSIST',
      payload: { text: 'codex reply' },
      fixtureRow: 2,
      t: '<200ms',
    },

    {
      actor: 'screen',
      effect: 'assist_row_renders',
      assert: (snap) => {
        const text = snap.observers.screen.queryTextByTestID('assist-row');
        return text?.includes('codex reply') || {
          ok: false,
          msg: `assist-row should contain codex reply, got ${JSON.stringify(text)}`,
        };
      },
      assertLabel: 'codex assist row renders',
      t: '<50ms',
    },

    {
      actor: 'daemon',
      event: 'SYSTEM',
      payload: {
        source: 'codex',
        subtype: 'terminal-divider',
        text: '─ Worked for 1m 14s ─────────────────────────────────────────────────────────────────────────────',
      },
      fixtureRow: 3,
      t: 'end',
    },

    {
      actor: 'reducer',
      effect: 'phase_transitions_to_idle',
      assert: (snap) => {
        const turn = snap.observers.reducer.getTurn(snap.streamId);
        return turn?.phase === 'idle'
          ? { ok: true }
          : { ok: false, msg: `expected turn.phase === 'idle', got ${turn?.phase ?? '<no turn>'}` };
      },
      assertLabel: "turn.phase === 'idle' after codex terminal-divider",
      t: 'sameTick',
    },

    {
      actor: 'screen',
      effect: 'working_dock_unmounts',
      assert: (snap) => !snap.observers.screen.isMountedByTestID('working-dock'),
      assertLabel: 'working-dock unmounts after codex terminal-divider',
      t: '<50ms',
    },

    {
      actor: 'composer',
      effect: 'send_button_enabled',
      assert: (snap) => !snap.observers.composer.isSendButtonDisabled(),
      assertLabel: 'send button is re-enabled after codex terminal-divider',
      t: 'sameTick',
    },

    {
      not: { actor: 'screen', effect: 'working_dock_mounts' },
      within_steps: 100,
      assertLabel: 'Bug D — working-dock MUST NOT re-mount after codex terminal-divider',
    },
  ],
};
