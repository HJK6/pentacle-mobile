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
- No route or covering surface renders a top delivery card or retained-send list.
  Each retained message owns its status and recovery controls in its destination
  transcript, including while the global overlay host is mounted.
- In the selected, uncovered destination chat, all send progress, failures and
  proof-derived Sent receipts are hidden from the bottom bar. Exact ordinary
  stream IDs and the assistant composite identity determine the destination.
  Capture and unsent controls remain available before Send.
- Other chats, lists and covering surfaces show active send progress as SENDING
  with View to open its original destination. A send observed turning failed or
  overdue while its chat is not open shows FAILED SENDING with Go to chat for
  5 seconds; otherwise failure belongs to the message row. Progress expires 130
  seconds after persisted `sendRequestedAt` or the last explicit retry;
  navigation and relaunch never renew that display budget. Expiry shows Failed
  sending without changing delivery truth or sending anything. An older
  failed/overdue take cannot hide a newer active send.
- A focused chat uses its existing measured composer slot for capture, unsent
  work and off-target bounded Uploading/Transcribing/Sent presentation. Queued
  and server-owned off-target progress docks above the live composer. Its draft
  owner stays mounted while capture owns the slot; the existing `composerWrap`
  measurement owns keyboard offsets and transcript clearance.
- A voice message uses the text send row under its bubble: Uploading while the
  audio uploads, then Sending, or "!" Failed sending with a retry symbol and an
  X (one shared row for text and voice, `src/components/SendStatusRow.tsx`). The
  symbol runs the existing guarded command for the state: retry for definite
  failure, lookup for uncertain dispatch or server ownership, and exact replay
  only for authoritative absence of the client intent. It shows Sending again
  until the outcome or a fresh 130-second budget. X deletes the local copy at
  once with no confirm; a server-owned send gets a cancel attempt first.
  Multiple messages retain independent exits.
- Outside chat, the selected root/modal host projects one 44-pixel field and
  circular microphone. Only the field's non-control region accepts vertical
  dragging. Horizontal placement is fixed. Position is process-only, keyed by
  recording ID and relative to the current surface baseline. Chat does not
  overwrite it; a new take resets it.

Capture phases are Starting and Saving; every delivery phase reads Sending
(Uploading in the message row while the audio uploads). A paused take remains
interrupted/kept until an explicit Send or Resume. The bottom capture surface
retains Resume, Send and Discard. Held-account, unrecoverable-recording and storage
recovery notices remain available; delivery recovery belongs to each message. Removing a local copy does not
claim to unsend anything.

Only matching authoritative landed proof, followed by owned cleanup, produces
the process-only Sent receipt. It expires 3000 ms after proof; a new capture
replaces it. The destination chat hides that receipt without consuming it. Leaving
before its original deadline reveals only the remaining time; navigation cannot
renew it, and nothing reappears after expiry. View opens the original destination
(the protected assistant thread for a composite send) and clears only that receipt. Optimistic acceptance, unknown receipts, discard, auth changes and
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
