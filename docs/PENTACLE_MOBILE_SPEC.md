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

The Updates tab may use list and resolve RPCs:

```json
{
  "type": "notification.list",
  "request_id": "request-example-2",
  "limit": 20
}
```

Actionable records are resolved by notification id and action id. Durable
question records stay with the chat that asked them; the Updates feed can
filter them out. Terminal records remain visible with an in-place outcome.

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

Message-only notifications render as plain cards. Declared actions get one
button each, with immediate pending feedback and in-place terminal status.
Refresh performs a backfill; a push/deep link may open the Updates tab.

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
