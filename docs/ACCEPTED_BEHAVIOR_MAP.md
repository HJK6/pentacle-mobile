# Accepted mobile behavior map

This integration combines the accepted public mobile baseline `f772f511417e4855520d40464af9994e8c7ffa62` with the accepted image and Retry behavior, then repairs image loading state and displays durable notification delivery.

| Behavior | Product paths | Meaningful controls |
| --- | --- | --- |
| Configured assistant first, protected row/menu actions; ordinary ordering unchanged | `app/(tabs)/chats.tsx`, `app/pentacle/session/[streamId].tsx`, `src/components/ChatActionSheet.tsx`, `src/config/local.ts`, `app.config.ts` | Chat list/action-menu tests, priority actions, config serialization; absent feature stays off and exact enabled role beats attention/recency |
| Configured host sigils, settings roster, top-level objective omission and offline Force delete | Existing public config, settings, SummonModal and pentacleStream paths | Host/sigil, settings, summon, close-reply and protected-close tests remain present |
| Pending question button and transcript Retry remain independently usable | `src/components/MobileQuestions.tsx`, `app/pentacle/session/[streamId].tsx` | Question dock occupies measured composer space; composer/keyboard geometry, retained pending-question native Retry center tap, one delivery and normal question access |
| Retained-photo Retry reconnects through the existing connection owner | `src/services/pentacleStream.ts` | Backoff, in-flight auth readiness, offline expiry, repeated tap, late echo cancellation, retained upload and acknowledgment-loss/replay controls |
| Independently encoded large-image chunks and agent image rows | `src/services/pentacleStream.ts`, `app/pentacle/session/[streamId].tsx` | Byte-for-byte multichunk assembly; actual user/assistant media row and viewer tests |
| Decoded images clear their loading overlay | `src/components/MediaBubble.tsx` | Normal/cached callback orders, replacement URI, stale callback, empty/error, same-source rerender and viewer tap; state telemetry omits URLs/content |
| Saved answer differs from delivery | `src/components/NotificationCard.tsx`, core notification types | Pending/queued, delivered, positively failed, unconfirmed and unknown-reason fallback; stale transport error and late proof; stable-request reconnect tests |
| Wrapper/caption deduplication plus accepted send status and agent images | Vendored `pentacle-chat-core` | Wrapper fallback/LIVE/replay controls, accepted/proof_unavailable captions, image interpreter/reducer, public synthetic fixtures and cursor binding |

## Core identity

The exact reconciled core commit is `08eff799e2a30394329f37f097b25d4a7453d879`, tree `2e9110a31f8ff0b6c3c22de271f61e08da223e76`. Public mobile vendors that entire reviewed tree, including its license and tests. The consumer uses `file:./pentacle-chat-core`; it needs no remote submodule or private history.

## Public dependency boundary

Product projection selects only the session image-render delta, stream Retry/blob deltas, MediaBubble and NotificationCard changes, the exact core tree, and their tests. `base64-js` becomes a direct dependency using its existing lockfile resolution. The public Retry test file selects 11 accepted tests and only their local WebSocket/storage/helper dependencies. Existing public pin/host/settings/summon/close paths remain the public baseline. Public build/version/configuration commands remain unchanged.

The public example omits `features.assistantRole`. A private fleet overlay can explicitly set it to `assistant` and configure each host's sigil. Local configuration, credentials, native signing inputs, private storage/gate scripts and temporary evidence are excluded from this projection.

## Validation boundary

Public source validation uses `npm run test:unit`, `npm run typecheck` and `npm run validate`. A final `--output-dir` argument can direct the Expo export to an owned scratch directory. These checks validate source and bundle generation; native visual acceptance, certified release gates and installed artifact/PID evidence are recorded separately by the release owner.
