# Mobile Chat Client Specification

## Goal

Build an iPhone client that can:

- discover available host adapters;
- browse Claude and Codex sessions;
- follow a structured transcript in real time;
- start a session through an authorized adapter;
- send text and display working state.

The experience should feel deliberate and readable rather than like a generic
administration console.

## Platform

Use React Native / Expo. The first release needs websocket state, secure
storage, biometric unlock, and local iOS builds; it does not require a custom
native framework. Native modules may be added later behind a small adapter.

## Security boundary

The client may handle sensitive conversation data, so:

1. protect app resume with platform authentication when enabled;
2. keep credentials in SecureStore/Keychain, never ordinary preferences;
3. require an authorized session before send or spawn actions;
4. avoid logging message bodies, credentials, or device identifiers.

The public export uses a fixture adapter and contains no enrollment code, raw
token, private endpoint, or deployment shortcut. A production adapter should
use short-lived session credentials, per-device revocation, and server-side
audit records.

## Transport

The default development URL is `ws://localhost:8080`. The websocket envelope
uses:

- `snapshot` for initial state;
- `chat.event` for transcript updates;
- `host.status` for reachability;
- `session.inventory` for session changes;
- `working.state` for authoritative working metadata.

A client hello may look like:

```json
{
  "type": "hello",
  "client": "mobile-example",
  "auth": { "method": "fixture", "credential_ref": "demo" }
}
```

The fixture value `demo` is not a credential. Real authentication must be
provided by the adapter and stored securely by the app.

### Control messages

```json
{
  "type": "send",
  "request_id": "request-example-1",
  "host": "example.local",
  "session_name": "sample-session",
  "text": "hello from a public fixture"
}
```

Session creation, rename, close, and interrupt use the same correlated request
pattern. A request id is a client correlation key, not a secret.

### Notifications

Notification-driven surfaces use the existing list and resolve RPCs:

```json
{
  "type": "notification.list",
  "request_id": "request-example-2",
  "limit": 20
}
```

Actionable records are resolved by notification id and action id. Durable
question records stay in the Unified question drawer and their originating
chat. The Updates tab does not consume the notifications feed. The notification
store and push-notification behavior are unchanged.

## Mobile UX

### Home and chats

- connection status and a compact welcome card;
- host cards with discovered labels and session counts;
- recent sessions grouped by host;
- provider and activity badges;
- a create-session affordance when authorized.

### Session detail

- bounded transcript with optional tool/system filters;
- draft, queued, and working state;
- host/provider metadata;
- composer at the bottom;
- structured question cards and answer bubbles.

### Updates

The Updates tab is the Bart status surface. Its header shows a 38 px lamp ring,
`Bart`, the existing status tag plus WORKING or IDLE from the `bart:assistant`
session's `working` field, and the open-lane count. It has no close button.

- Latest update and All updates · N use only events in `bart:assistant` whose
  `publish_kind` is `status`. N is the count in loaded, retained history. Prose,
  questions, results, and events from other streams are excluded.
- Tapping the latest card or the link opens the update log, newest first. The
  latest row is green and pulsing; older rows are dim. Back returns to the card.
- The shared event bucket and existing `requestStreamEvents` mount-fetch and
  older-page paths own history, cursor exhaustion, and live updates. Scrolling
  the log requests older history with no pagination controls. One end-of-list
  demand crosses status-empty pages until a status, exhaustion, no progress,
  interruption, or error. This avoids stranding a short filtered log. The
  source stream remains the only history request target; there is no per-lane
  polling or second notification/history store.
- Open lanes reuse the Chats working/needs-you selectors and visibility rules,
  excluding `bart:assistant`. Each row shows its machine mark, title, and active
  plan step, falling back to card update, then working label. Needs-you rows
  use amber and show Blocked. The caret expands the existing CardStatusMini;
  the row body uses the existing duplicate-safe session navigation path.
- ETA comes only from the session row's optional nullable `eta_at` and
  `eta_set_at`. A local clock refreshes its display every 15 seconds while the
  tab is focused; this does not fetch data. Future and late durations round
  to the nearest minute, with a one-minute minimum and hours above 59 minutes.
  Missing/invalid timestamps or a non-positive interval show —. Needs-you
  wins over every estimate. No overrun percentage is displayed.

Empty status history uses plain text. A history failure recovers on refocus or
reconnect; no retry polling, settings, filters, search, or new controls were
added. Question cards remain in Unified. The other screens are unchanged.
See [status surface validation](status_surface_validation.md) for synthetic
coverage, collection proof, and the patch-series handoff boundary.

## State and rendering rules

The shared reducer owns ordering, reconnect, and optimistic reconciliation.
Selectors own cache invalidation, filtering, and projection. The screen must
not create a second turn state machine or infer a reply from transport counters
alone. A rendered assistant row is the success criterion for transcript walks.

## Build and validation

```bash
npm install
npm run test:unit
npm run typecheck
npm run validate
npx expo run:ios
```

Local signing values belong in ignored configuration. Release signing and
deployment are intentionally outside this public specification.

## Open risks

- provider schemas can evolve, so unknown event fields must be ignored safely;
- reconnect snapshots can arrive while a turn is in flight;
- image and attachment uploads need bounded size/type validation;
- a fixture adapter must never be mistaken for an authenticated service.

## Voice dictation to the originating chat

An empty shared composer displays a mic control. Tap to record while scrolling
or navigating; tap again to stop and send. Discard cancels capture. A global
Recording · duration · Return pill and Stop and send control remain available
outside the originating chat. Session and unified composers capture the selected
stream at start; changing the selection never redirects a take.

Stopped audio is sent to the configured transcription backend for English
recognition. A waveform user row shows
TRANSCRIBING and an X until text dispatch. Errors or empty recognition offer
Retry/Discard; interrupted/backgrounded takes continue with an interruption
caption. The final message is plain text, with a durable microphone/duration
caption. Audio never reaches the selected agent. Capture uses microphone
permission, AAC/M4A 16 kHz mono and a five-minute cap, without background audio
entitlement or playback. See [chat surface contract](chat_surface.md#voice-input)
for state ownership, cancellation and retry details; measurable vocabulary
acceptance uses [voice fixtures](../test/fixtures/voice/README.md).
