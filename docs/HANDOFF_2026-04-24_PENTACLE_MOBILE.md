# Mobile Client Handoff

This handoff records the public shape of the standalone mobile client. It is a
maintenance guide, not a record of a live deployment. All host, session, and
authentication examples below are synthetic.

## Goal

The app provides:

- a compact home view of discovered host adapters;
- a session list and structured transcript for Claude and Codex providers;
- live updates over a websocket event stream;
- draft, queued, and working indicators;
- a composer for sending text to an explicitly configured adapter.

The mobile UI consumes normalized events through the shared client model. It
does not reconstruct transcript state from terminal buffers.

## Public file map

- `app/(tabs)/_layout.tsx` — tab navigation;
- `app/(tabs)/pentacle.tsx` — home view;
- `app/(tabs)/chats.tsx` — session list;
- `app/(tabs)/settings.tsx` — user preferences;
- `app/pentacle/session/[streamId].tsx` — session view;
- `src/hooks/usePentacleToken.ts` — secure credential access;
- `src/services/pentacleStream.ts` — websocket client/store;
- `src/types/pentacle.ts` — wire and view types;
- `app.json` — public application configuration.

## Data-plane contract

The client expects a configured structured-event adapter. A local development
example is `ws://localhost:8080`. The adapter sends `snapshot`,
`session.inventory`, `chat.event`, `working.state`, and `host.status` frames.
Unknown auxiliary frames are ignored for forward compatibility.

Each event is normalized around `host`, `provider`, `session_name`, `stream_id`,
`timestamp`, `kind`, and `text`. The public fixture roster uses `hosta` and
`hostb`; production users can supply their own labels in local configuration.

## Authentication boundary

The application keeps credentials in the platform secure store and should use
the host application's documented authentication adapter. This public export
contains no enrollment code, raw token, endpoint pin, device identifier, or
recovery shortcut. A fixture adapter may run without authentication on
`localhost`.

## UI behavior

### Home and chats

Host cards show a name, reachability, and session count. The list discovers
hosts from the snapshot rather than assuming a fixed roster. Tapping a session
opens its stream id; provider badges and working status remain visible.

### Session view

The session view has a bounded initial transcript window, loads earlier history
when the user scrolls upward, preserves a composer draft, and displays tool and
system rows according to user preferences. Reconnects keep the focused session
mounted and preserve an in-flight turn.

### Working and sending

The working indicator is derived from normalized session state and local turn
state. The composer stays editable while a turn is running, while Send follows
the turn-phase policy. Optimistic user rows reconcile with matching server
events and become visibly failed when their bounded reconciliation window ends.

## Validation loop

```bash
npm run test:unit
npm run typecheck
npm run validate
```

For a simulator use `npx expo run:ios`. Use only synthetic rows for screenshot
and end-to-end checks. Render-level evidence must show a mounted assistant row;
transport receipt alone is not a passing reply assertion.

## Known integration boundaries

- the websocket adapter owns host discovery and event normalization;
- the mobile client owns local selection, caching, optimistic reconciliation,
  and presentation;
- secrets belong in secure storage, not AsyncStorage or source fixtures;
- remote deployment, signing, and private infrastructure are outside this
  public handoff.

## Resume checklist

1. Start the local fixture adapter or select an approved public endpoint.
2. Check `snapshot` and `session.inventory` shapes against the client types.
3. Run focused reducer and screen tests before the full validation loop.
4. Exercise a synthetic send, reconnect, history backfill, and rendered reply.
5. Review new fixtures for identifiers, paths, credentials, and copied text.
