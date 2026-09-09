# Unified Feed

The mobile Unified tab is a read-only cross-chat view over the existing global stream store. It does not subscribe to a separate daemon feed and does not backfill unopened-chat history in v1.

## Data Contract

- `selectUnifiedFeed(state)` lives in `pentacle-chat-core` and reads `PentacleStreamState.events`.
- The selector returns assistant message rows only: raw `ASSIST` and `ASSIST_TEXT` events whose interpreted display rule is `bubble:assistant`.
- Tool, thinking, system, user, peer-agent, hidden status, and sub-agent rows stay out of the Unified feed.
- The screen applies the same mobile visibility rule as Chats: sessions with missing or `"default"` `visibility` are visible, while any other daemon `visibility` is excluded from feed rows and question drawer entries.
- Rows are sorted in flat chronological order and carry stream metadata: `streamId`, host, provider, chat title, host title/accent, timestamp label, text, and the source event.
- After chronological sorting, adjacent rows with the same `streamId` render as one bubble with a single chat title/header and all distinct timestamp labels.
- Completeness is limited to events already delivered into the client store. Summary-mode cold snapshots omit event history; per-chat history fetch remains owned by the chat-detail screen.

## Reply Path

The Unified screen renders agent rows from `selectUnifiedFeed(state)` and overlays client-origin `USER` events from the same store so replies show as destination-labeled sent content. Reply selection opens the existing `ComposerBar`; sends route to the selected row's `streamId`.

- Idle target stream: `sendTurn(streamId, text, attachments)` inserts the optimistic row, then `sendMessage({host, sessionName, text, attachments})` transmits.
- Working target stream: `enqueueTurn(streamId, text, attachments)` inserts a held optimistic row, then `flushQueuedSends(streamId)` dispatches once payloads are ready.
- Image staging, capture/library pick, compression, upload, attachment cap, and optimistic attachment replacement are delegated to the shared `ComposerBar`.

## Questions Drawer Boundary

The drawer derives pending durable questions from open `state.notifications` records with `producer === 'agent_question.v1'` and an open `question` payload. It maps each record through `durableQuestionCardModel(...)`, renders the exported chat-detail `QuestionCard`, and submits through `actions.resolveNotification(...)` with selected option values and the optional note.

The Unified tab owns only the floating badge, drawer chrome, chat metadata, and open-chat affordance. Question entries expose no reply button; the shared card's select/note/submit interaction is the reply path.
