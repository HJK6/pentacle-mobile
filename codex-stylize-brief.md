# Structured tool-row styling brief

## Context

The structured event transport already gives the mobile reducer enough data to
render provider tool activity. This brief describes a public, provider-neutral
presentation for a session screen. Examples use synthetic event data only.

## Visual vocabulary

The transcript can render these rows:

- `⏺ Bash(npm run test)` — a tool invocation in monospace.
- `  ⎿ all green ✓ 12 tests passed` — a nested tool result preview.
- `⏺ Read src/services/chatModel.ts` — a file-read invocation.
- `  ⎿ Read 1 file (ctrl+o to expand).` — a concise long-result summary.
- `⏺ Agent: Audit event grouping  3 child events` — a collapsed child group.
- `── Worked for 4m 52s · 12 msgs ──` — a compact turn summary.

The working dock may show labels such as `Building fixtures… (8s · thinking)`.
Keep the ellipsis and parenthetical signal, while allowing the label to wrap or
truncate safely in the available width.

## Rendering rules

1. **Tool use.** Render `TOOL_USE` with a `⏺` prefix, the tool name and a
   monospace argument preview. The interpreter's normalized text remains
   unchanged so duplicate/coalesce matching remains stable.
2. **Tool result.** Render `TOOL_RESULT` beneath its paired invocation with a
   `⎿` glyph and an indent. Limit long results to about five lines and append a
   `… +N lines` hint. File tools keep their existing code-block treatment.
3. **Turn summary.** Map `SYSTEM` records with `subtype: "turn-summary"` to a
   dedicated display rule and center the duration/message-count divider.
4. **Working dock.** Read the normalized `working_label` without stripping
   status details; use middle truncation or wrapping when necessary.

Keep existing rendering for legacy event kinds and provider-specific rows.
Only the structured transport branch should opt into the new display rule.

## Implementation notes

The row renderer should branch on `displayRule`, while the event interpreter
continues to own classification and normalization. A `TOOL_RESULT` should be
paired by its `tool_use_id`; if no pair exists, render the same bounded result
as a standalone tool row. The `turn-summary` branch must be safe for empty or
malformed labels and should return no visible row for empty text.

Use synthetic fixtures such as:

```json
{
  "kind": "TOOL_USE",
  "provider": "codex",
  "text": "Bash(npm run test)",
  "raw": { "tool_use_id": "tool-example-1", "tool_name": "Bash" }
}
```

Tests should assert the display rule and the visible bounded text. They should
also cover a normal assistant paragraph beginning with “I'm” or “I'll”; that
prose must remain an assistant bubble rather than becoming a progress pill.
