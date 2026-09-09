## Pentacle Chat Model Spec

Date: 2026-04-24

### Goal

Make Pentacle mobile production-ready for live chat browsing by separating:

- transport and raw store updates
- domain/state processing
- platform-specific rendering

The mobile app should feel close to desktop Pentacle in behavior and information density while staying native on iPhone.

### Boundary

The shared boundary is not just the websocket client. It is the full chat domain model that turns raw Pentacle daemon data into UI-ready state.

Shared layer responsibilities:

- websocket protocol handling
- snapshot and incremental event reduction
- host/session/draft normalization
- session activity classification
- preview text selection
- transcript item shaping
- connection and machine summary derivation

Platform layer responsibilities:

- React Native or desktop rendering
- navigation
- local authentication
- gestures, layout, and visual styling
- platform composer ergonomics

### Shared Inputs

The model consumes `PentacleStreamState`:

- `connected`
- `connecting`
- `lastError`
- `hosts`
- `sessions`
- `events`
- `drafts`

### Shared Outputs

The model exposes pure selectors that return UI-facing state:

- `selectMachineStatusList`
- `selectChatList`
- `selectChatOverview`
- `selectSessionDetail`

These selectors derive:

- machine labels
- machine online/offline state
- machine session counts
- session status: `working | pending | live | idle | offline`
- preview text and summary labels
- transcript rows with canonical role/tone metadata
- session header data including draft and activity state

### Status Rules

Session status is derived once in shared code:

- `offline`: session summary says offline
- `working`: session summary says working
- `pending`: session summary says pending
- `live`: session is online and has recent active transcript state
- `idle`: fallback online state when the session is present but not marked working/pending

### Transcript Rules

Transcript items are normalized into UI-facing rows:

- role label
- tone
- visibility under filters
- timestamp label
- body text

The renderer should not decide what a `TOOL` or `THINK` event means. It only receives normalized rows.

### Mobile UI Direction

The iPhone UI should preserve these desktop Pentacle traits:

- machine-scoped session browsing
- clear activity state
- dense but readable list cards
- transcript view that feels live
- strong host/provider identity

It should not try to copy the desktop xterm grid. Mobile is a chat browser/controller, not a terminal dashboard.

### Implementation Path

1. Keep the current websocket store in place.
2. Add a pure shared model module inside `src/services`.
3. Move screen-specific mapping logic into shared selectors.
4. Rebuild Chats and Session screens against the selectors.
5. Later extract the same shared module into a cross-repo package for desktop adoption.
