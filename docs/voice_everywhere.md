# Voice on every product page

The header microphone controls the existing process-owned `VoiceRecorder`. It
does not create a second recorder, durable queue, audio file owner, or send verb.
`NativeCaptureEngine`, `VoiceTakeStore`, and `VoiceDelivery` retain their native
admission, account/origin, upload, cancellation and receipt-proof fences.

## Destination and presentation

- An idle start in a focused chat uses that chat's existing composer draft and
  attachment transfer. Its canonical stream and generation are captured before
  permission. A route change while permission is pending cannot retarget it.
- An idle start outside chat uses `ASSISTANT_STREAM_ID` and the display name from
  `assistantIdentity`, with an empty draft. It never consumes a different chat's
  text or images, guesses a host assistant seat, or falls back to the last chat.
- All eligible headers operate on the same active take. Busy transitions cannot
  dispatch a second send. Retained delivery work does not prevent a new capture.
- A focused chat projects the bar in its existing measured composer slot. The
  draft owner stays mounted as invisible, inaccessible, non-editable measurement
  content while the bar owns that slot, including on a fresh chat handoff. Keyboard offsets and transcript clearance remain owned by the
  existing `composerWrap` measurement.
- The bar owns the composer slot only while a decision or bounded operation is
  pending: capture, an Unsent take, Uploading, Transcribing, or the Sent receipt.
  A Queued, Checking delivery or failed take docks the bar directly above the
  composer instead, so typing, sending and a new recording stay available. In a
  chat the bar carries that take's exits: Retry and Discard, or for a dispatched
  take Remove local copy (with the delivery warning) and Check delivery again,
  replaced by Send again when the daemon has no receipt for the request.
- Outside chat, the selected root/modal host projects one 44-pixel field and
  circular microphone. Only the field's non-control region accepts vertical
  dragging. Horizontal placement is fixed. Position is process-only, keyed by
  recording ID and relative to the current surface baseline. Chat does not
  overwrite it; a new take resets it.

The displayed phases come from capture and durable delivery: Starting, Saving,
Queued, Uploading, Transcribing and Checking delivery. A paused take remains
interrupted/kept until an explicit Send or Resume. The existing recovery surface
retains Resume, retained takes, storage/auth recovery, Check again, and the
ambiguous-delivery local-copy removal warning. Removing a local copy does not
claim to unsend anything.

Only matching authoritative landed proof, followed by owned cleanup, produces
the process-only Sent receipt. It expires 2800 ms after proof; a new capture
replaces it. Assistant View opens the protected assistant thread and clears only
that receipt. Optimistic acceptance, unknown receipts, discard, auth changes and
take disappearance cannot create Sent. Locked/background UI exposes no bar.

## Additive metadata contract

The existing send metadata accepts optional `meta.voice.context_v1` alongside
`duration_s`. The context is observed UI data, never routing or instructions:

```json
{"voice":{"duration_s":15,"context_v1":{"visits":[{"offset_ms":0,"page_id":"personal","title":"Personal"},{"offset_ms":3100,"page_id":"calendar","title":"Calendar"},{"offset_ms":7200,"page_id":"questions","title":"Questions","question_id":"q-example-1"},{"offset_ms":11000,"page_id":"questions","title":"Questions","question_id":"q-example-2"}]}}}
```

The compact context object in this example is 306 UTF-8 bytes. Its approximate
77-token four-byte heuristic is not a tokenizer guarantee; expected framing may
be roughly 80–140 tokens. No model/tokenizer lookup runs during capture.

`voiceContext.ts` owns the fixed page registry and pure immutable accumulator:

- Page IDs: assistant, chat, personal, calendar, lists, list, dashboards, settings,
  agents, sessions, status, updates, lanes, lane, lane_history, questions, report,
  image, other
- Only offset_ms, page_id, title, optional entity_id and optional question_id
  enter visits. No body, options, answers, transcript, URL, query, path, token,
  credential or device identifier is collected
- Titles normalize whitespace, remove controls and retain at most 48 Unicode
  code points. Optional IDs must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,95}` as a full-string match (including explicit rejection of trailing newline/control);
  invalid IDs are omitted whole rather than shortened into another identity
- Offsets are nondecreasing integer captured-audio milliseconds, 0–300000,
  clamped to finalized capture duration. Permission/arming wait and paused dwell
  add no time or visits. Successful arming records the visible page at zero;
  Resume samples the current view at the existing captured duration
- Consecutive page/entity/question identities coalesce even if title changes;
  revisits after another identity remain. Questions contribute viewed IDs only;
  new plain takes do not create segmented answers or submit question responses
- At most 24 visits and 2048 compact UTF-8 bytes, including `truncated:true`.
  Overflow retains the earliest 23 or fewer slots plus the latest eligible view,
  trimming the tail of the earliest retained slots deterministically

The same take manifest/checkpoints persist the context. Finalization freezes it;
the existing immutable dispatch payload and digest include it. Later navigation
cannot append to sent/retrying input, and restart/retry preserve equivalent
logical metadata. Legacy manifests without context and retained `voice_answer`
takes remain supported. The only vendored-core change is the additive shared
type; the provision pin's tree is updated to the resulting committed core tree.

### Compatibility boundary

An older daemon may ignore `context_v1` and continue landing ordinary voice.
Mobile request-frame tests prove the optional metadata is sent once and bound
to the immutable payload. They do not prove daemon normalization, canonical
event persistence, replay or assistant visibility. The separately implemented
daemon slice must validate and deliver observed context to the recipient before
full end-to-end context release can be claimed.

## Portable verification and remaining release proof

From a disposable public checkout, run `npm ci`, temporarily copy
`pentacle.config.example.ts` only if local configuration is absent, then:

```sh
npx jest --runInBand --runTestsByPath tests/voiceEverywhere.test.tsx tests/voiceContext.test.ts tests/voiceDelivery.test.ts tests/voiceControlHosts.test.tsx tests/voiceStableTarget.test.ts
npm run test:unit
npm run typecheck
npm run validate
node scripts/check-provision-pin.cjs
```

Run the pin check against the committed final candidate, not a dirty core tree.
Remove only the rehearsal-owned config in cleanup. Optional
`VOICE_CONTEXT_EVIDENCE_DIR` on `voiceStableTarget.test.ts` saves its actual
synthetic ordinary/composite request frames for inspection.

The explicitly double-gated screenshot harness (`EXPO_PUBLIC_SCREENSHOT_HARNESS`
and `EXPO_PUBLIC_VOICE_RENDER_FIXTURE`) supplies synthetic native capture,
filesystem and socket boundaries while retaining production recorder, store,
upload, transport and component ownership. It is for reproducible source-backed
render acceptance, not native/acoustic proof or a production permission bypass.

Release intake still owns candidate screenshots/crops, fixed-size target
comparisons, actual header coverage, keyboard/safe-area measurement and finalized
navigation/drag video. Target inspection, DOM snapshots and Jest success are
insufficient visual proof. Signed native runtime and operator-present
permission/call/background/cap checks, plus the isolated real-daemon recipient
context round trip, remain separate release gates.

## Rollback

Revert this mobile feature commit to restore the prior presentation and omit the
optional metadata. Existing daemon voice behavior needs no new verb. Do not
delete retained recordings or app data as a rollback step.
