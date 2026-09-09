# Chat Surface Contract

The chat surface is the focused session view in
`app/pentacle/session/[streamId].tsx`. It reads user preferences, selects
transcript rows through the shared model, renders working state, and sends text
through the optimistic-message path.

The shared event core is a platform-neutral package or in-repository module
provided by the application. Its public seams are event interpretation,
reducer state, selectors, host configuration, telemetry names, and shared
types. This document does not prescribe a repository layout or dependency pin.

## Transcript filter

`selectSessionDetail` accepts `showToolActions`. When true, tool and system
rows are included for the session view. When false, tool and thinking rows drop
unless they are always-visible system milestones. The effective modes belong
in the cache key.

| Row class | Display rule | Tone | Hidden by default? |
|---|---|---|---|
| User bubble | `bubble:user` | user | no |
| Assistant bubble | `bubble:assistant` | assistant | no |
| Tool command/output/batch | `activity:*` | tool | yes |
| Explore/file/code activity | `activity:*` | tool | yes |
| Thinking | `activity:thinking` | thinking | yes |
| Structured tool use/result | provider `activity:*` | tool | yes |
| Turn summary | `activity:turn-summary` | system | yes |
| Terminal divider | `terminal:divider` | system | no when non-empty |
| Context compacted | `system:compacted` | system | no |
| Hidden noise | `hidden:*` | any | yes |

Empty non-bubble rows are skipped. `showTurnDuration` is a later render-layer
preference that hides duration rows without removing them from reducer state or
turn-end detection. A focused screen continues selecting live details while a
transcript-ready animation gate controls only list visibility.

## Preferences

`showToolActions` and `showTurnDuration` default to false and use the ordinary
preference store described in `docs/user_preferences.md`. Hydration does not
block layout. The Settings screen exposes both switches.

## Working indicator

The working row appears above the composer when:

```ts
const turnWorking = turn.phase === 'pending' || turn.phase === 'working';
const showWorking = Boolean(session?.working) || turnWorking;
```

The row uses a spinner, elapsed time, and an icon-only stop action. Elapsed
seconds prefer fresh `working.state.elapsed_ms`, anchored to the local clock,
and fall back to `turn.firstServerEventAt`. A transient remote elapsed dip must
not move the display backward within one working episode.

The stop action uses the same interrupt request as the keyboard escape path.
Repeated presses in one turn are latched to one effective request; an
unconfirmed result re-arms the action and reports that the stop did not take.

## Composer

The composer stays editable while work is in progress. The Send action follows
the turn-phase and connection gates. The attachment menu collapses when the
user types, focuses the field, taps Send, or chooses an attachment.

### Photo attachments

The composer accepts text, one to five synthetic or user-selected photos, or a
photo-only message. Items are staged FIFO, removable, and bounded by
`MAX_CHAT_ATTACHMENTS`. Before upload, the client validates type/size and may
transcode HEIC to JPEG. A batch send is all-or-nothing: if upload or send
fails, text and staged photos are restored.

Wire attachments contain a blob key, MIME type, and optional dimensions/size
and hash. Local `file://` preview URIs are display-only and never go over the
wire. A user bubble renders media above its caption and retains local preview
fields through server reconciliation.

## Send while working and interrupt

If a send occurs while `turnWorking` is true, append a queued optimistic row
with its own `optimistic_id` and preserve the request id. The provider adapter
owns FIFO release when the active turn becomes idle. Queued rows are not
editable or removable in the default UI. Once acknowledged, a queued row uses
the normal sent-user-bubble style.

The stop action reports a structured outcome such as `interrupted`,
`interrupt_unconfirmed`, `not_working`, or `coalesced`. The client never
auto-resends after an interrupt. A new turn identity re-arms the stop latch.

## Optimistic user messages

Send clears the local composer and inserts a synthetic USER event before the
transport promise resolves. The event has a non-server origin, stable
`optimistic_id`, pending status, and optional attachment previews. Transcript
item ids use server sequence for server rows and the optimistic id for client
rows.

A server USER event reconciles when stream id, text, origin, and a bounded
timestamp window match. The reducer replaces the optimistic row in one state
update. Snapshots use the same matching pass and preserve unresolved pending
rows. When the reconciliation window expires, the row remains visible with a
failed status rather than disappearing silently.

## Copy and peer messages

Message and code bubbles use native long-press selection/copy. Visible per-row
copy buttons are unnecessary; a short confirmation is sufficient.

Trusted peer messages render as a collapsed `bubble:agent` card with a sender
label and one-line preview. Tapping expands it and long-pressing copies it.
Malformed protocol payloads and housekeeping rows remain hidden. A local USER
event without a trusted peer envelope always remains the user's own bubble.

## Status indicators

Header and list status share `idle`, `working`, and `sending`. Working takes
priority over sending, which takes priority over idle. Working uses the fluid
elapsed value; fast text sends may delay the sending indicator briefly to avoid
visual strobe, while attachment sends can show it immediately.

## Session creation idempotency

One explicit create-session intent must create at most one session. Enforce
this at three layers:

1. the modal disables and latches its submit action synchronously;
2. the screen keeps a synchronous in-flight guard;
3. the adapter receives an idempotency key and replays the terminal result for
   a duplicate key.

The payload hash excludes request and idempotency keys. A changed host/provider
tuple creates a new intent. Transport failure keeps the key for convergence;
an explicit retry after a terminal error creates a new intent.

## History backfill

The initial snapshot may be summary-only. A focused connected session requests
recent history, tracks fetched and in-flight ids, retries failures after 1000 ms,
and clears those sets on disconnect. A successful response is folded as one
historical batch so it cannot overwrite live working state. Emit a
`chat:history_backfill_rendered` signal only after a real content row exists.

## Questions

The session view combines visible pane questions and open durable questions
into one list. Option taps update local state; only Submit resolves a question.
Multiple-choice selection enforces min/max bounds, custom text is mutually
exclusive with predefined options, and cancellation leaves the question open.
Answered projections stay next to their ask row and share one notification id.
The Updates tab may hide question records because their owning chat renders
them.

## Telemetry

Telemetry is local structured metadata, not a content source. Useful events
include:

- `chat_surface:trailing_blank_dropped`;
- `chat.compose.optimistic_insert`;
- `chat.compose.optimistic_reconciled`;
- `chat.compose.optimistic_failed`;
- `chat.session.first_event_after_send`;
- `chat.session.spawn_summary_applied`;
- `harness:row_rendered` for render-level test evidence.

Do not include message bodies, credentials, absolute paths, host inventories, or
private URLs in telemetry. A render beacon must carry only a bounded prefix or
digest.

## Shared-core parity

When desktop and mobile use a shared core, keep one decision surface for event
interpretation, transcript selection, optimistic lifecycle, working metadata,
question projections, and ordering. Consumers should move through reviewed
public releases together and must not fork these decisions locally. The parity
contract is behavioral; no private commit, remote, or source pin belongs in
this document.
