# Structured JSONL Transport

Status: public design

This document describes a structured JSONL adapter for Claude-style provider
events. The examples are synthetic and use `example.local`; they are not
captures from a live session.

## Goal

Replace pane-text reconstruction with typed JSONL records while keeping the
websocket envelope and the existing Codex path compatible. The mobile reducer
and screen should consume structured events rather than attempting to infer
tool boundaries from terminal text.

## Why structured records help

| Symptom in a pane parser | Structured representation |
|---|---|
| Draft keystrokes look like user messages | Only submitted `type:"user"` records become USER events. |
| Read and Bash lines lose parentage | Each `tool_use` has an explicit id and child metadata. |
| Spinner text leaks into the transcript | Working state is derived from turn metadata. |
| File output wraps as ordinary prose | `tool_result.content` is typed and can use code styling. |

## Adapter architecture

```text
provider event source ─► JSONL normalizer ─┐
legacy pane adapter   ────────────────────┼─► event queue ─► websocket
Codex event source     ──────────────────┘
```

The structured watcher discovers only sessions explicitly supplied by the
application and reads a configured local data directory. It tails each file
from the beginning, normalizes records, and pushes them onto the existing
queue. A caller may disable the legacy adapter for the provider without
changing the websocket envelope.

## Wire event shape

The envelope remains `{ type: "chat.event", event: { ... } }`. New event kinds
are:

| kind | source record | meaning |
|---|---|---|
| `USER` | `type:"user"` without a tool result | submitted user message |
| `ASSIST_TEXT` | assistant text block | rendered assistant paragraph |
| `THINKING` | assistant thinking block | collapsed thinking row |
| `TOOL_USE` | assistant tool-use block | invocation with id, name, input |
| `TOOL_RESULT` | user tool-result block | result paired by tool id |
| `SYSTEM` | `type:"system"` | subtype and content passthrough |
| `WORKING` | derived from an incomplete tool turn | authoritative working state |

Each normalized event has a stable public shape:

```json
{
  "daemon_seq": 42,
  "host": "example.local",
  "provider": "claude",
  "session_id": "session-example-1",
  "session_name": "sample-session",
  "stream_id": "example.local:sample-session",
  "timestamp": "2026-01-01T00:00:00Z",
  "kind": "TOOL_USE",
  "text": "Bash(npm test)",
  "raw": {
    "source": "claude-jsonl",
    "host": "example.local",
    "provider": "claude",
    "session_name": "sample-session",
    "uuid": "record-example-1",
    "parent_uuid": null,
    "is_sidechain": false,
    "tool_use_id": "tool-example-1",
    "tool_name": "Bash",
    "tool_input": { "command": "npm test" }
  }
}
```

The normalizer may include `tool_content`, `thinking`, `cwd`, and
`stop_reason` when relevant. Any credential-shaped field must be omitted from
fixtures or replaced with an obvious short test value.

## Working state

A turn is working when the latest assistant record ends with
`stop_reason:"tool_use"` and at least one tool-use id has no matching result.
The label is the single tool name or `ToolName + N more`. Emit a synthetic
`WORKING` event when the boolean or label changes, and update the existing
session summary rather than inventing a new envelope.

## Tool grouping and code rendering

Sidechain child records carry `is_sidechain:true`. The chat model groups them
under the parent Agent invocation using the parent id chain and shows one
collapsed row with a child count.

Read, Write, and Edit results may carry line-numbered content and use the
existing monospace code-block display. Markdown fences inside assistant text
continue through the normal text parser. The legacy code-collapse step is a
no-op for `raw.source === "claude-jsonl"`.

## Client changes

1. The reducer accepts the new kinds and preserves them during snapshots.
2. The interpreter trusts structured kind/source pairs and skips pane cleaners,
   spinner detection, and code collapse for JSONL events.
3. The chat model pairs results by `tool_use_id`, groups sidechains, and maps
   file results to code rows.
4. The screen keeps legacy rows working while adding the structured display
   branches.

## Rollout and configuration

Use a local feature flag such as `CHAT_EVENT_TRANSPORT=jsonl` to select the
adapter in development and test profiles. The default remains compatible with
legacy events until both paths have equivalent fixtures. No production endpoint
or deployment command is part of this public document.

## Synthetic fixtures

Fixtures should be generated from small, hand-authored records under the test
fixture directory. Include:

- a submitted user message and an assistant text block;
- a thinking block;
- Bash tool use plus a bounded result;
- a Read result with line numbers;
- an Agent parent with a sidechain child;
- working state before and after a matching result;
- fenced assistant code;
- a pane draft with no JSONL record until submission.

Never copy live transcripts, local file paths, host inventories, or real session
ids into fixtures. The loader may feed one record or an ordered scenario through
the normalizer, reducer, selector, and screen assertion.

## Testing layers

- normalizer tests compare synthetic records with the wire shape;
- reducer tests verify kind passthrough and absence of draft echoes;
- model tests verify pairing, grouping, and working-state derivation;
- screen tests verify code rows, Agent summaries, and working labels;
- adapter tests verify that local file rotation and malformed lines fail safely.

## Child record layout

If a provider stores child records separately, the adapter may look for a
provider-configured child directory beneath the session's local fixture root.
Each child record carries `is_sidechain:true` and a parent session id. Correlate
the child to its Agent invocation by an explicit parent tool id when available;
otherwise use the parent UUID chain. Do not expose the absolute local root in a
wire event or documentation example.

## Open implementation choices

- discovery for sessions not created by the adapter should use an explicit
  caller-provided mapping rather than scanning arbitrary host files;
- history backfill should replay a bounded recent tail;
- timestamp order is the default when sidechain events interleave with the
  primary turn, with the parent invocation retaining its original position.
