# Continuous voice and retained delivery

## Capture ownership and controls

The process-wide `VoiceRecorder` is the only capture owner. Routes, chat selection,
question overlays, and app-owned modal hosts project its state; they do not create
recorders or independent delivery queues. In-app navigation never changes the
recording's destination, pauses capture, or sends a take.

The iOS capture path uses the in-repository `pentacle-voice-capture` Expo module.
Background, inactive, lock and interruption pause the same native recorder. Returning
to active/unlocked only changes eligibility; recording requires explicit Resume,
unlocked foreground, the original credential/server scope and no authoritative
closure or replacement of the origin. Missing network inventory alone does not
invalidate a previously authenticated origin. No Expo Audio recorder or audio-mode
API is used by this capture path; the installed dependency stays unchanged.

Captured audio is capped at 300,000 ms, with the existing mono AAC/M4A profile. The
cap finalizes one retained, unsent take. Pause, cap, recovery, and accepting a finished
take never imply Send. The operator explicitly sends or discards it. Queued finalized
takes do not hold the microphone; a new capture may start while delivery is pending.

Question-origin takes use a process-owned binding, with visits measured in captured
milliseconds. Paused dwell adds no coverage. Each visit must independently meet
1,500 ms; short visits are not accumulated. Finalization clamps and freezes the
binding to the actual captured duration. The frozen carrier is persisted with the
take, including for capped-unsent work, and every Send path uses it. No-covered-answer
Send retains the existing explicit no-answers behavior. A chat-origin take never
acquires a question binding by navigating to questions.

Global controls appear on the root and covering app-owned modal/route surfaces, with
one accessible active host. They retain the original label/time, Return, Send,
Discard, and explicit Resume when paused. Locked UI hides these labels and actions.
Multiple retained takes are accessible through the take list. A proved successful
send removes its control immediately; no Sent/Return banner, timer, or toast remains.

## Native capture contract (CAP-01)

`NativeCaptureEngine` keeps the existing `RecordingEngine` interface. Before reading
microphone permission, requesting permission or creating durable draft ownership,
it checks a synchronous `getCaptureContract()` response:

    {contract: "pentacle-voice-capture", revision: 1, nativeBuild: "<CFBundleVersion>"}

The contract name and single `ACCEPTED_CAPTURE_REVISION` constant must match exactly.
The nonempty native build string must equal the build identity already resolved by
`src/config/appIdentity.ts`. Missing/throwing modules, malformed responses, another
revision, missing bridge functions or a build mismatch fail closed with typed
`capture_unsupported` and the existing plain error surface. The draft is retained;
there is no permission prompt, ownership transfer or capture fallback. This also
protects a new OTA JavaScript bundle running against an old binary. Android has no
capture implementation and is unavailable under this handshake.

The module owns one `AVAudioRecorder` and file for each opaque native capture handle.
That handle is engine-local and is not the take repository's UUID, upload identity,
or send identity. The engine passes the sole file URI through the existing ownership
checkpoint/finalization seam. Resume never prepares another recorder or file. Discard
stops/releases capture; the take repository remains the only deletion owner and
commits its tombstone before cleanup.

All native observer and command events feed the pure Swift `VoiceCapturePolicy`
reducer on one serial executor. The iOS observer for interruption-began,
`willResignActive`, background and protected-data-unavailable synchronously revokes
admission and applies the policy pause before returning. Every such pause advances
`pauseEpoch`. Interruption-end (including `shouldResume`), foreground/active,
protected-data-available and route changes never produce a record action. A complete
begin/end pair between JS polls therefore leaves sticky paused state. The engine
uses the current native epoch on explicit Resume. The controller consumes settled
native captured time before closing a question visit or testing final answer
eligibility, including delayed pause responses and page changes while paused. A
queued Resume cannot merge two separate short visits across that pause.

A synchronous, lock-protected admission generation is revoked as the first engine
statement in pause, stop and discard, before any await. A queued or session-activating
start/resume checks its captured token again immediately before its native record
action, together with the current handle, paused state/epoch for Resume, active app,
protected data and session activation. This supplements the controller's existing
JS operation epochs. Pure cached status snapshots cannot wait behind activation
and delay that cancellation. A refusal leaves capture paused or stopped, with a
fixed error such as `cancelled`, `stale_epoch`, `not_paused`, `not_foreground`,
`locked`, `capped`, `recorder_reset`, `session_failed` or `resume_failed`.

Media-services reset is terminal for the handle. Polling, including while paused,
consumes the sticky native interrupted state and projects the existing retained
finalized controls with `Interrupted. Send or Discard.`; Resume is unavailable.
The file is retained for best-effort finalization/recovery and is never replaced by
another recorder for that take. A save/discard failure does not make it resumable.
Neither reset, pause, cap nor recovery requests Send.

Native captured time excludes paused dwell and never reports more than 300,000 ms.
The native deadline finalizes while JS is stalled; acoustic samples beyond that cap
are forbidden. The accepted container-duration tolerance is at most 250 ms of AAC
encoder padding, not extra acoustic capture. The format remains mono AAC/M4A,
16 kHz and 32 kbps with metering. No audio background mode or app permission change
is introduced. The recording session configuration is released on pause/finalize.

The shared `contract/capture-contract-v1.json` sequences exercise the Swift reducer
and the same JavaScript native model used by the engine/controller tests. The
separate `CAP-01 NEW-CONTRACT PROBE` runs the short interruption schedule against
that amended engine/model. The sealed `CAP-01` RED at mobile `0053d68f` remains the
old Expo engine baseline; running that old probe on the new adapter would be a setup
failure and is not evidence of a new RED.

These are source-policy and modeled-bridge checks, not iOS compilation or acoustic
proof. Signed Release compilation/Expo bindings, real interruptions, lock with and
without a passcode, denied unlock, media reset, same-file audible prefix, foreground
transitions, the cap plus long paused dwell, encoder tolerance and coexistence with
installed Expo Audio session observers still require the requester's native/device
acceptance. Portable green does not certify the native executor.

## Device repository and recovery

`VoiceTakeStore` is the sole writer of manifests and owned-file lifecycle:

    documents/voice-takes-v1/<scopeHash>/<recordingId>/

`scopeHash` is SHA256 of UTF-8 JSON `[serverIdentity, credentialId]`. The identity
contains the configured credential-free server scheme/host/path and the parsed v2
operator credential ID, never a proof key or token. A take UUID, origin ID/generation,
original draft, operation kind and build identity are captured once. Image assets
are copied into the owned directory and verified before the composer transfers its
draft. The store never deletes picker originals.

Manifests are version 1 JSON, staged in a same-directory temporary file. On iOS the
locked Expo legacy text-write API replaces `manifest.json` via Foundation
`String.write(atomically: true)`; the staged file is subsequently removed. The iOS
legacy move API is deliberately not used for replacement because it unlinks the old
destination first. Android uses the locked same-directory `renameTo` move primitive.
Writes are serialized per take; a required commit must
succeed before its new snapshot is published. Temporary JSON is not recovery truth.
Audio finalization first journals its expected owned path/size/hash, moves the single
native file into documents, verifies it, and commits the finalized state. Both sides
of an interrupted move are recoverable. A final-manifest failure can be retried from
the already moved artifact without recording again.

Finalized audio, copied images, uploaded references, transcript, and exact send intent
are retained across ordinary process restart, termination and reboot on the same
installation. The platform-specific primitives above preserve committed JSON across
ordinary process interruption; this source return does not independently certify
physical storage barriers or iOS
scheduling. Active/native-paused M4A is only best-effort recovery. A recovered readable
container is Interrupted and unsent; a missing, truncated, or unreadable container is
an actionable failure. There is no same-file native resume after process death and
no claim that structural validation proves acoustic quality. Live native URI, captured
time and question state are checkpointed after at least 1,000 additional captured
milliseconds, with at most one checkpoint pending. A recovered active take displays
its last durable captured-time checkpoint, not a claimed exact final acoustic duration.

At most ten nonterminal/recovery-failed takes and 128 MiB of owned assets are admitted.
The store accounts for retained bytes under corrupt manifests and cleanup-pending
tombstones too. New capture reserves 16 MiB audio plus actual image sizes and requires
that much free storage. Each audio file is at most 16 MiB. Unsent work is never evicted
by age or quota pressure. Quota/write failures block capture or advancement visibly.

Landed and discarded states are durable tombstones before owned files are removed.
Cleanup is retried after restart; tombstones are removed only after files are gone.
Corrupt/missing manifests remain quarantined, visible as a generic recovery failure,
and are never uploaded blindly. Deletion is limited to the corresponding owned take
and its validated, recorded cache URI. Discard includes a captured native URI in the
tombstone even when its first checkpoint is still pending. Held question bindings
are released by recording ID immediately after their tombstone commits, before
cleanup; an uncommitted or later failed batch member keeps its binding.

Credential or server changes hold prior scopes. Their transcript and destination
are hidden; only a generic retained count and deliberate local deletion are exposed.
Re-enrollment does not migrate or resend old work as a new identity. Returning to the
original valid scope can resume eligible work. Uninstall, device loss, user deletion,
storage failure, and credential migration are outside the recovery guarantee.

## Acknowledged voice upload

Voice alone opts into protocol 2 on the existing authenticated socket and blob verbs.
Image/generic callers retain their v1 behavior. Init carries the stable upload UUID,
exact raw byte count, whole SHA256, MIME (`audio/mp4` or `audio/wav`), and frozen
`voice_operation` object. The six operation fields are version 1, recording UUID,
origin stream ID, original canonical generation, `voice_chat`/`voice_answer`, and build.

Chunks contain at most 65,536 raw bytes, raw-byte offset, strict base64, chunk SHA256,
and final flag. Only one RPC is in flight. A fresh RPC request ID is not upload
identity. Every phase uses the existing 30-second command bound. Every validated ACK
is committed locally before another chunk or stage; complete requires exact total
and matching whole blob SHA. Reads and hashing are bounded, without whole-file base64.

`upload_blob.init.ok`/`upload_blob.ok` must explicitly return protocol 2, matching
upload ID, `next_offset`, and `complete`. Incomplete ACKs are not legacy completion.
Old servers produce Server update required; audio stays retained, without v1 fallback.
Timeout/disconnect stops that upload attempt. Reconnection uses the existing connection
owner and re-init obtains server truth, including lost intermediate/final ACK recovery.
The client never guesses an offset. A retained file can restart an expired upload.

Server staging is principal-bound and survives connection loss and daemon restart.
Advertised quotas are ten uploads/160 MiB per principal and 1 GiB global; staging and
completed upload receipts expire after seven days. Expiry does not delete canonical
blobs or assert that retained mobile audio was lost. No guarantee crosses credential
rotation or staging expiry.

## Delivery, exact intent, and proof

Only a durable non-null `sendRequestedAt`, written after explicit Send and finalized
question binding, makes a take eligible. `VoiceDelivery` serially drains eligible
oldest work in unlocked foreground. Auth/origin-blocked work is skipped so another
take can proceed. Transient pre-dispatch failures back off at 1, 2, 4, 8, 16, then
30 seconds; timers stop on background/auth loss. Domain failures need action. An
auth-forbidden take waits for renewed authenticated readiness or explicit Retry,
not unrelated incoming messages. There is no background delivery promise.

Successful transcription is stored with matching blob SHA and stable
`transcribe-<recordingId>` request ID. Voice alone uses a 130-second phase timeout,
covering the backend's existing 120-second bound. The existing one transport-only
retry and 15-second reconnect-readiness bound remain. A phase timeout is an actionable
retained failure requiring explicit Retry. Receipt delay never causes another upload
or transcription.

Before the first possible send frame, the transport validates fresh authenticated
origin inventory and prepares an exact immutable intent. The store commits the
optimistic identity, composite `msg_id` if applicable, text/attachments/metadata,
route, and request proof before hydration or dispatch. The original payload has a
local integrity digest. After a crash, that identity is hydrated and reconciled;
text matching cannot create a replacement identity or prove delivery. Generic
reconnect/retry never independently dispatches voice-owned rows.

The original request is exactly:

    {protocol:"voice-v1",logical_id,target,generation,sequence}

The logical ID is the recording UUID; target and generation are original canonical
values. Sequence starts at one, is bounded to 1,000, and advances only on explicit
Retry after authoritative `not_landed`. The request ID is `voice-send-` plus the first
40 lowercase hex digits of SHA256 of UTF-8 compact JSON of
`[logical_id,target,generation,sequence]`, preserving Unicode without ASCII escaping.
A retry atomically replaces only attempt identity; optimistic/composite identity and
logical content remain fixed. Receipt lookup carries the exact proof object.

Only matching typed landed receipts/results or authoritative correlated canonical
USER proof can terminalize the take. Bare true, `send.ok`, accepted/persisted,
proof-unavailable, empty lookup, and timeout are not landed. Explicit generation
mismatches are rejected; a wire generation field is not invented when the existing
receipt omits it. Unknown stays Checking delivery, with Check again or Remove local
copy. When an authenticated lookup on the current connection returns `found:false`
(the daemon holds no receipt for the exact request, for example because the send
frame was lost with the socket), the take also offers Send again. It re-sends the
identical persisted intent: same request ID, sequence and payload, with no new
upload, transcription or request-ID rotation. Replay safety comes from the daemon's
exact-request-ID claim and the assistant composite's immutable input identity, not
from absence alone. Absence is process memory, valid only for the connection that
proved it, and is never automatic: only the explicit action re-sends. Removing after dispatch warns that delivery may already have happened and
never claims to unsend. Image-bearing outcomes may remain unknown where existing
proof cannot establish them. Exactly-once claims are limited to the existing durable
receipt or composite-ID dedup evidence.

## Deployment order and rollback

Deploy the daemon protocol first and verify v1 plus v2 authenticated resume in an
isolated real-daemon journey. A newer client against an older server retains audio.
Before rolling back a mobile binary, protect the complete take directories; an old
client cannot be claimed to read or drain the v1 manifest store. Preserve runtime and
build rollback preimages. Do not remove unknown or held takes to simplify rollback.

This implementation's portable tests are source evidence only. Independent final
QA, relay/handoff checks, actual daemon gates, signed native Release build, simulator
journeys, and operator-present USB/acoustic/lock/interruption/device-storage proof
remain requester-owned release gates. No phone or simulator was built or launched
for this source return.
# Global header and context extension

The mobile-only global header/bar and additive optional observed-page context
reuse these capture, ownership and receipt rules. See
[Voice on every product page](voice_everywhere.md) for the bounded contract,
older-daemon compatibility and separate rendered/native release evidence.
