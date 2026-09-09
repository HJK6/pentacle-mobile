# Trace Contracts

Trace contracts are Layer 1 test artifacts for chat-surface scenarios whose
meaning is the ordered sequence of behavior rather than one isolated
assertion. They live under `tests/contracts/traces/` and run through
`runTrace` from `tests/contracts/traces/runner.ts`.

## Shipped surface

- `types.ts` defines `TraceContract`, `TraceStep`, actor steps, negative steps,
  observers, timing policies, and failure results;
- `runner.ts` exports `runTrace` and an in-memory fixture adapter;
- `index.ts` exports the trace inventory;
- `tests/contracts/fixtures/*.jsonl` contains synthetic event fixtures;
- `tools/print_trace.ts` renders a trace as a markdown table.

The inventory should cover representative flows such as:

| Trace | Purpose | Fixture |
|---|---|---|
| `composer_send_with_newline` | Return preserves a newline; Send submits once. | `composer_send_with_newline_v1` |
| `send_turn_claude` | Send through assistant reply and dock settle. | `claude_simple_reply_v1` |
| `send_turn_codex` | Send through a provider turn divider and dock settle. | `codex_simple_reply_v1` |
| `existing_chat_assist_arrives` | An open chat updates without remounting. | `existing_chat_assist_v1` |
| `question_ask_answer_display` | Ask, select, submit, and render a structured answer. | `question_answer_v1` |
| `chat_event_ordering_replay` | Out-of-order events render deterministically. | `event_ordering_v1` |
| `optimistic_echo_reconcile` | A server echo does not duplicate an optimistic row. | `optimistic_echo_v1` |
| `pending_send_live_apply` | A pending send does not block a later assistant event. | `pending_send_v1` |
| `history_fetch_retry_hydrate` | A retry applies fetched history after an error. | `history_retry_v1` |

## Regression assertions

Every trace protecting a regression needs a red-capable assertion. Useful cells
include:

- option preview appears only in the preview region;
- a committed answer renders as an answer bubble, not raw builder grammar;
- a question resolves only on the explicit submit action;
- event ordering uses timestamp and sequence tie-breaks;
- optimistic echoes reconcile without duplicate rows;
- committed assistant events apply while another send is pending;
- an existing chat receives an assistant row without an unmount;
- one divider row is emitted per provider turn;
- a retry response hydrates a summary-mode screen;
- stale current-tail data cannot replace newer live data, while an explicit
  older page remains additive.

Question-specific component tests may cover selection bounds, free text, cancel,
stale questions, and failure fallback without promoting each case to a trace.

## When to write a trace

Write one for sequence, cross-surface coordination, or a high-value user flow:
for example, Send → optimistic row → working dock → reply → dock settle. Keep
fine-grained parsers, formatters, reducers, and small rendering branches as
ordinary unit tests. Do not turn every test into a trace.

## Authoring guide

1. Choose a snake_case scenario name and a fixture name. Fixtures must be
   synthetic and stored under the documented fixture directory.
2. Validate fixture rows before writing steps. Mark generated events
   `synthetic: true` and explain why near the step.
3. Use actors for the surface that owns the behavior: `user`, `daemon`,
   `reducer`, `screen`, and `composer`.
4. Add predicates when an event name is not enough. Predicates receive a typed
   snapshot with state, stream id, events, and observers.
5. Add a negative step immediately after the positive step that opens a
   must-not-happen window.
6. Add the trace to `index.ts` only when it is part of the public test surface.
7. Record how a regression would turn red; do not hide a known pending behavior
   behind an unexplained skip.

## Worked example

`composer_send_with_newline` can begin with:

```ts
{ actor: 'user', action: 'composer_change_text',
  payload: { text: 'line one\nline two' }, t: 'sameTick' }
```

The composer observer checks that the newline is preserved. A negative step is
then armed before the Return-key action to assert that `actions.sendMessage`
does not fire. The explicit Send action must fire once with the full text,
append a pending user row, mount the dock, and disable Send. A synthetic
assistant event such as `{ kind: 'ASSIST_TEXT', text: 'got it' }` completes the
flow, followed by a synthetic turn-summary event when the fixture needs one.

## CLI and relationship to E2E

```bash
npx tsx tools/print_trace.ts --list
npx tsx tools/print_trace.ts send_turn_claude
npx tsx tools/print_trace.ts --all
```

Trace contracts model app-visible reducer/screen/composer behavior through a
fixture adapter. A device E2E harness may consume the same discipline, but a
transport receipt or timeout is not a substitute for a mounted content row.
Record evidence as artifact paths and verdict JSON; never paste captured
transcripts into source.
