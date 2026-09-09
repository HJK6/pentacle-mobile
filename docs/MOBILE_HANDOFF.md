# Mobile Client Architecture Handoff

This document is the public handoff for extending a mobile client over a
structured chat/session stream. It contains no private repository links,
deployment state, or live credentials.

## Goal

The app lists sessions, opens Claude and Codex transcripts, streams updates,
shows draft/queued/working state, and sends messages through a configured
transport adapter. The UI reuses normalized event data rather than scraping
terminal output.

## Data plane

The stream adapter is an independent service boundary. Mobile connects to the
configured websocket URL, for example `ws://localhost:8080` in a fixture
environment. It must support:

- `snapshot` for initial state;
- `session.inventory` for session list updates;
- `chat.event` for transcript events;
- `working.state` and `host.status` for status indicators.

Events use `host`, `provider`, `session_name`, `stream_id`, `timestamp`, `kind`,
and `text`. Draft-related metadata may include `raw.draft`, `raw.pending`, and
`raw.working`. Unknown auxiliary frames are ignored without breaking the
forward-compatible client.

## Session model

The reducer owns event ordering, optimistic sends, reconnect handling, and
working state. The model selector owns transcript filtering, cache invalidation,
tool grouping, and answer projections. The screen owns layout and explicit user
actions. Keep those boundaries intact when adding a feature.

The client supports any number of discovered hosts and must not hard-code a
machine roster. The synthetic public fixtures use labels such as `hosta` and
`hostb`.

## Mobile MVP

1. **Session list** — host grouping, provider badge, and activity state.
2. **Session detail** — unified transcript, tool/system filters, and working
   indicator.
3. **Composer** — local draft, optimistic row, and send result.
4. **Fallback** — a raw-event diagnostic view may be added later; it is not a
   requirement for the core chat surface.

## Control messages

The adapter may expose correlated commands such as:

```json
{
  "type": "send",
  "request_id": "request-example-1",
  "host": "example.local",
  "session_name": "sample-session",
  "text": "hello from the fixture"
}
```

Every request gets an explicit success or error envelope. Authentication and
authorization are adapter responsibilities; the mobile client stores any
credential only in the platform secure store.

## Questions and updates

Question notifications are rendered in the focused chat and resolve only when
the user submits the complete answer. The Updates tab may display ordinary
notifications while excluding question records that belong in a chat. All
question and notification examples must be synthetic.

## Files to read first

- `src/services/pentacleStream.ts` — transport client and store;
- `src/services/pentacleStreamReducer.ts` — state transitions;
- `src/services/pentacleChatModel.ts` — selectors and transcript rows;
- `src/services/pentacleEventInterpreter.ts` — normalized event cases;
- `docs/CLAUDE_JSONL_TRANSPORT.md` — structured provider events;
- `docs/e2e_render_evidence_contract.md` — rendered-content evidence.

## Extension rules

1. Update types, normalizer, reducer/model fixtures, and screen assertions as a
   unit.
2. Keep source paths relative and examples host-neutral.
3. Do not add raw tokens, device paths, captured transcripts, private remotes,
   or deployment commands.
4. Prefer a synthetic fixture adapter for tests and screenshots.
