# Chat Transcript Rendering Contract

This contract defines how the focused session screen renders normalized Claude
and Codex events. It describes public UI behavior and synthetic examples; the
transport adapter remains responsible for removing provider-specific noise.

## Tool invocation cards

Bash, Read, Edit, Write, Grep, Glob, Agent, and TodoWrite invocations render as
a `ToolInvocationCard`:

- bold accent tool name in monospace;
- parsed arguments in smaller muted monospace text;
- Bash bodies limited to two lines;
- other tool bodies limited to six lines;
- no leading decoration that is not part of the card design.

Only events from the provider branch that supports this card should use it.
Legacy Codex rows continue through their existing assistant-block parser. JSONL
`TOOL_USE` rows route directly to the card; legacy command-like activity rows
may route there when they match `ToolName(args)`.

## Tool results

Tool results render as a one-line nested preview by default. Empty or
whitespace-only results render nothing. A successful Read result may be hidden
when the parent card already names the file. Other summaries are:

- Write → `Wrote N lines to <relative-path>`;
- Edit → `Added X lines`, `Removed Y lines`, both, or `Updated file`;
- a background Bash start → `Running in the background`;
- a not-read error → `File must be read first`;
- anything else → a bounded first line with a `… +N lines` tail.

The source text is never allowed to leak provider-specific XML error markup.
The interpreter marks file results as `activity:code-block` and other results
as `activity:tool-output`; a hidden code result remains available in reducer
state for replay and accessibility decisions.

## Tool batch summaries

An enriched span may render as `activity:tool-batch`, for example:
`Searched for 1 pattern, read 3 files, listed 2 directories`. The row is plain
indented text without a second result glyph. When a visible summary contains a
tool-use id, the selector suppresses the paired invocation/result rows only in
the view. The reducer keeps all source events.

## Transcript derivation and cache invalidation

`selectSessionDetail` is the render-path selector. It may reuse transcript item
objects whose visible content is unchanged, but it must return a new detail
object whenever the open stream's rendered content changes.

The reducer owns invalidation:

- `eventContentVersionByStream[streamId]` increments on append;
- progressive same-sequence updates use `mergeProgressiveUpdate` and create a
  new event on a valid prefix extension;
- snapshot replacement bumps the version when its content fingerprint changes;
- stream removal deletes the version entry.

Events are immutable after insertion. Development and test builds may freeze
them; production builds may skip freezing for cost. A content change always
uses a fresh event object or a replacement array, never in-place mutation.

## Text cleanup and activity pills

`stripClaudeExpandHint` removes only end-of-line `(ctrl+o to expand)` and
`(↓ to manage)` affordances. Mid-text occurrences remain intact. The cleanup
is applied consistently in the interpreter, fallback path, and renderer.

`activity:*` rows render as a title/detail pill without a global leading dot.
Only the latest `activity:thinking` row in the visible window uses an animated
spinner; historical thinking rows use a static glyph.

## Structured question answers

A USER row containing the builder's `Answering your question(s):` sentinel is
parsed into an `AnswerBubble`. It shows the question label, selected option
labels (bulleted for multiple selections), and an optional note. Parsing is
primary and uniform for optimistic, live, and history rows; malformed or
ordinary text falls back to a normal user bubble. The on-wire text is not
changed, so copy still returns the raw answer grammar.

An answer keeps the position and timestamp of its matching transcript receipt, even when a resolved-notification projection replaces that receipt during deduplication. If the receipt is outside the loaded window, immutable `resolved_at` or `resolution.at` orders the answer among real event timestamps. Later notification `updated_at` values never move it. Local answers capture submission time once. Legacy untimed records retain their original question anchor when available.

Complete multi-question coverage is still required before suppressing the echoed answer. Partial coverage preserves the echo so no child answer disappears, and each replacement projection is inserted once. Tests cover plaintext answer receipts, later arrivals, and reopening without the receipt in the loaded window.

## Peer messages

Messages marked as trusted peer input render as a collapsed `bubble:agent` card
with a sender label and one-line preview. Tapping expands the body and
long-pressing copies it. The operator's own USER events remain user bubbles.
Malformed protocol payloads and daemon housekeeping stay hidden.

## Working dock

The screen subscribes to `state.workingByStream[streamId] ?? IDLE_TURN` and
derives the local signal as:

```ts
const isWorking = turn.phase === 'pending' || turn.phase === 'working';
const showWorking = Boolean(session?.working) || isWorking;
```

`showWorking` controls the header status and dock visibility. The composer lock
uses only `turn.phase !== 'idle'`, so a stale remote flag cannot wedge input.

The elapsed timer prefers an authoritative `working.state.elapsed_ms`, anchored
once per fresh snapshot, and falls back to `turn.firstServerEventAt`. The dock
may append token direction, shell counts, and a bounded task summary. It uses a
spinner for active work and never re-anchors on every render.

## Tables and code

Markdown tables, box-drawing tables, and code blocks render through one
horizontal `ScrollView` containing one monospace `Text` node with embedded
newlines. `normalizePipeTable` pads pipe-table cells to stable widths and keeps
non-table preformatted text byte-identical.

## Pair propagation

The selector propagates `tool_input` from a `TOOL_USE` to a paired
`TOOL_RESULT` by `tool_use_id`. The normalizer carries a relative working
directory when available so file summaries can display relative paths.

## Preferences and tests

Tool actions and turn duration are render-layer preferences. Their source events
remain available for turn-end detection. Tests should cover tool cards/results,
batch suppression, immutable event updates, answer parsing/order, working dock
timers, and the distinction between a rendered assistant row and a received
transport event.

The following are intentionally outside this contract: tap-to-expand hidden
results and provider-specific restyling beyond the documented display rules.
