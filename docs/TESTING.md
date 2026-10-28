# Testing

The mobile global-voice extension has focused real-owner capture/delivery and
bounded-context coverage in `tests/voiceEverywhere.test.tsx`,
`tests/voiceContext.test.ts`, `tests/voiceControlHosts.test.tsx`,
`tests/voiceComposerJourney.test.tsx` and `tests/voiceStableTarget.test.ts`.
See [voice everywhere](voice_everywhere.md) for portable commands, synthetic
request-frame export and the rendered/native proof that unit tests cannot supply.

From a fresh checkout, run npm ci, copy pentacle.config.example.ts to
pentacle.config.local.ts, then run npm run test:unit and npm run typecheck.
The shared chat core is vendored, so tests need no private repository or daemon.

For iteration, run npx jest --runInBand --runTestsByPath tests/<file>.test.ts.
Keep fixtures synthetic and preserve protocol fields, error messages, author
prefixes and config keys: those values affect behavior even in synthetic data.
The test host configuration uses hosta, hostb, and hostc.

`tests/summaryFallbackFormatting.test.ts` replays the same captured synthetic
provider-ingestion fixture as the web core/browser regression. Before transcript
backfill, summary bubbles preserve Markdown and code whitespace. Once the matching
event is held, later tool activity or working-state changes cannot append a second
summary bubble. Summary matching uses kind and normalized text; `last_event_at`
describes all activity rather than message identity. An identical repeated message
renders when its own transcript event arrives. Run the matching vendored core
suite separately with `npm --prefix pentacle-chat-core test`; the root Jest suite
excludes core tests.

tests/contracts/assistant_preview_thread_parity.test.ts guards that the Chats-list
preview for the assistant composite equals the thread's last rendered row, and
that a turn-final projection row (an assistant status row, not a published
prose reply) renders as an assistant bubble. It runs under
test:unit with synthetic fixtures; it does not replace a native replay.

Run npm run test:prod-build-guardrails to check the public production-build
environment allowlist, endpoint preflight, bundle fingerprint and baked-endpoint
checks, and sanitized evidence. This test uses synthetic inputs and does not
build or sign an app. The separate host-sigil test runs under test:unit.

npm run validate adds an iOS JavaScript export to TypeScript checking.
Jest covers modeled behavior; it does not certify native builds, device signing,
or live spawn/send journeys. Those require the configured daemon and native
runtime described in [Native builds](PENTACLE_MOBILE_BUILD.md).

The explicit installed-client seam entry replays a same-run candidate daemon
capture through the real `pentacleStream` WebSocket callback, history request
handling and shared model. It checks multiline summary/history, ordered live
updates, stable committed identities and reconnect/duplicate delivery. Its
missing/malformed/legacy summary controls are separately labeled synthetic.

```bash
PENTACLE_CLIENT_SEAM_CAPTURE=/path/to/client-seam-wire.json \
PENTACLE_CLIENT_SEAM_CAPTURE_SHA256=CAPTURE_SHA256 \
PENTACLE_CLIENT_SEAM_PRODUCER_SHA=PRODUCER_SHA \
PENTACLE_CLIENT_SEAM_RECEIPT=/path/to/mobile-seam-receipt.json \
npm test -- --runInBand --runTestsByPath test/seams/installedClientSeam.ts --testMatch '**/test/seams/*.ts'
```

The capture comes from Pentacle's existing web gate `installed-client-seam`
scenario. Missing input refuses the run; this explicit entry is outside normal
unit-test discovery. All producer application payloads are retained; only
history RPC request IDs are rebound to the real adapter's receiving request.
Record the capture hash and producer pin with the mobile consumer source,
lockfile and test instrumentation hashes. Use the actual installed build/source
receipt to select an isolated pinned checkout with its locked dependencies;
copy this test instrumentation there without changing its transport/model.
Run candidate and installed versions separately unless their sources are
identical. Replayed model assertions do not prove native rendering, mobile
authentication or native reconnect timing; those retain their runtime gates.

The web harness can connect the real client to an isolated test daemon using the
EXPO_PUBLIC_HARNESS, EXPO_PUBLIC_HARNESS_TOKEN and EXPO_PUBLIC_PENTACLE_WS_URL
environment variables. Its credential must be synthetic and temporary; never
commit it. Native rejection-tracking options are loaded only on native platforms.
Verify a unique assistant response in the rendered chat, and verify actions stay
disabled when the daemon cannot be reached. This browser check does not replace
a signed native build or an iPhone runtime check.

The Summon picker uses configured and discovered host identities. Host labels
need not match the example palette; offline hosts remain visible but disabled.

Public main is the normal development and build source. See [repository workflow](repo_workflow.md) for the mandatory pre-push content/history guard and required CI. Private-data exceptions use immediate reviewed public projection; keep local config out of Git.

The portable synthetic harness gate and retained private inputs are documented in [Public source boundary](public_boundary.md). CI runs only the four named Python mock/helper test files; JavaScript export validation uses the disposable ignored example config.

## Certified native gate and storage

Select the scoped or full route using the [release validation matrix](PENTACLE_MOBILE_BUILD.md#release-validation). The certification commands below apply when full qualification is required; the USB installation controls apply to both routes.

Use the clean, origin-advertised candidate with the installed storage authority:

```sh
node scripts/storage-cli.cjs gate:certified HEAD /absolute/path/fd-window.json
```

The supported entry builds the child environment, probes dependencies, runs one
fresh 60-sample quiet observation, and carries the opaque native/full handoff
internally. The allocation packet binds the host, candidate, executing gate code,
policy, accepted typed QA receipts, exact green CI and an FD window large enough
for the unchanged combined bound and cleanup. Missing, stale, reused or mismatched
inputs refuse before native preparation. The host singleton and shared `sim-queue`
serialize native work. Candidate and gate
code provenance, native process identity, all fixed simulator cases, finalized
video and owned cleanup must pass. See [public harness contracts](PUBLIC_CERTIFIED_HARNESS.md).

The low-level `gate:native-root` and `gate:full` operations remain for diagnosis
and owned recovery. They enforce the same receipt and journal claim and cannot
produce a new certified result by omitting the supported launch contract. Do not
copy their opaque lock token into shared logs or assemble a separate shell runner.

Pentacle Mobile delivery uses an Apple Development signed Release with an
embedded bundle and an in-place USB `devicectl` install. TestFlight is reserved
for the separate phone product. Full certification, when required, supplies source and retained proof
to the existing release-build handoff; it never queries or installs on a physical
phone. The release packet binds the app hash, source, version/build, operator-device
profile check and first-screen proof before the operator is asked to plug in.
The actual install waits for the FD's named operator Done relay, preserves app
data and Keychain, and stops without retry on lock, authentication or readback
failure. Physical acceptance requires a screenshot of the app UI.

Storage uses the installed fixed layout and rejects caller-selected paths. The
installed authority binds host, UID and generation; journal schema and reference
checks bind each run, container, worktree ticket and scheduler transaction to
that authority. Capacity requires 60 GiB free at start and 40 GiB while running.
The limits are 1 MiB for copied configuration, 64 MiB for state, 12 GiB for scratch
and 2 GiB for evidence. Build cache admission also preserves its measured free
space reserve. Evidence classification and digest checks precede publication.
Dead-owner scratch uses a 24-hour wait; published passing evidence is retained
for 7 days and failed evidence for 30 days. Recovery requires the journal's
exact owned identity and does not confer authority over unrelated resources.

Lifecycle commands use the same CLI: `storage:install`, `storage:update`,
`storage:reseal-authority PROOF_FILE`, `storage:inspect-authority-reseal`,
`storage:restore`, `storage:uninstall`, `storage:register-worktree MAIN_REPO_ID
SPEC_ID LANE_ID` and `storage:retire-worktree TICKET_ID`. The installed LaunchAgent
runs `storage:janitor dry-run` every six hours through `scripts/storage-janitor-scheduled.cjs`;
`storage:janitor apply` is an explicit action. Its nonzero last-exit status in
`launchctl list` means failure. The wrapper keeps the last two runs of stdout and
stderr in `State/logs` (1 MiB per file, 4 MiB total, inside the state budget); a
truncated file carries a marker and stderr ends with an exit marker. `storage:install`
and `storage:update` run only from the dedicated `~/repos/pentacle-mobile-public` checkout
(a fixed path, never caller-selected; `~/repos/pentacle-mobile` is the sealed lane
repository and is not a scheduler root). It must be a plain, non-symlinked clone of the
public `HJK6/pentacle-mobile` origin, clean, and contained in a fetched `origin/main`;
other roots are refused before any change. Prepare it with `git clone`, `npm ci --ignore-scripts`
and `git fetch` before updating. Admission is checked at install/update only; scheduled runs
execute whatever that checkout contains, so keep it clean and on public `main`. The update
is transactional and rolls back to the prior plist.

Explicit device-drift recovery and its separate execution approval are documented in
[Storage authority recovery](STORAGE_AUTHORITY_RESEAL.md). Retained migration history requires a
compatible reviewed updater and executing gate; older closed-layout readers refuse it.

The update's real scheduled dry-run runs while authority is `updating`. Only its
single `candidate_installed` update transaction may use that exception: the
scheduler lock records the original live process start epoch and binds the
transaction before entering `updating`; generation, roots and actual candidate
plist digest must match. The janitor rechecks those bindings at an observe-dead
journal write, and the updater rechecks them when accepting the immutable report
and committing. Ordinary validation and `apply` remain installed-only.

An occupied legacy scheduler lock cannot grant this exception. New acquisition
refuses an unavailable process epoch. Recovery of an interrupted version-2 lock
refuses with `SCHEDULER_LOCK_RECOVERY_UNSUPPORTED`; stop and retain the transaction
and preimages for the deployment owner, without takeover or a retry.

The source regression suite is `node scripts/storage-scheduled-janitor.test.cjs`.
Use `node --test --test-name-pattern='actual update CLI'
scripts/storage-scheduled-janitor.test.cjs` for the focused combined path. Its
owned fixture executes the actual update CLI, rendered wrapper and real janitor;
only launchctl and capacity are modelled. It covers genuine report success,
real janitor error/no-report rollback, binding refusals and durable observation/
report-acceptance races. These fixtures prove source behavior, not installed
launchd acceptance.
Admission catches ordinary accidents: a wrong or private root, a plainly dirty tree, an
unmerged commit, a redirected worktree or a remapped origin refspec. It does not detect every
dirty state and does not authenticate the source against an actor running as the same user.
Accepted residuals: edited files hidden by index flags (`assume-unchanged`, `skip-worktree`,
`core.ignoreStat`), untracked files hidden by `.git/info/exclude` or `core.excludesFile`, a
second remote whose fetch refspec rewrites `refs/remotes/origin/main`, and direct edits of
`refs/remotes/origin/main` (only an online `ls-remote` would catch these).
An authorized `launchctl kickstart` can exercise the installed job; inspect its
bound report afterward. The regular `disabled` file in the installed state is
the kill-switch for apply mode. Do not replace lifecycle commands with manual
deletion. Failed-run recovery uses `storage:recover-run RUN_ID` and retains the
same identity and ownership checks.

## Detached storage retirement source tests

Run the hermetic preservation journey and manual-driver guard tests with Node22:

```sh
node --test --test-concurrency=1 scripts/storage-retire-generation.test.cjs scripts/storage-retire-generation-rehearsal.test.cjs
```

The tests copy current scripts into an owned filesystem and use a closed native
boundary preload. They execute the actual utility, ordinary installer, scheduled
wrapper and janitor; the janitor produces the real transaction-bound reports.
Negative and interruption cases require retained bytes and no unintended native
actions. Existing epoch tests still need working real process probes; an emulated
epoch is not equivalent evidence for those tests.

The manual `storage-retire-generation-rehearsal.cjs` driver is deliberately outside
the `.test.cjs` glob. Never run it as part of source validation. Its separately
allocated real-account prerequisites and the unpassed real host/native gates are
in [storage generation recovery](storage-generation-recovery.md).

## Native message text selection

iOS message text uses UIKit selection within each existing contiguous text block.
A word can expand across wrapped lines within that block. Selection does not span
separate paragraphs, table cells, controls or attachments. Android/web keep the
existing text renderer. Peer-agent and independent code-copy actions keep their
existing behavior.

Start with the rendered-row and component regressions:

```sh
npm test -- --runTestsByPath tests/app/pentacle/session.test.tsx --runInBand -t 'message text long press'
npm test -- --runTestsByPath tests/messageSelectableText.test.tsx tests/assistantMarkdown.test.tsx tests/sessionScreenCopy.test.ts tests/composerLayout.test.tsx tests/composerNonBlocking.test.tsx --runInBand
```

The shared Jest mock replaces only the UIKit boundary. It cannot prove native
word recognition, handles, Copy, links, wrapping or scrolling. Added native code
requires the full certified nine-case gate above plus the focused Release journey.

Only a granted allocation owner may prepare/build/install the synthetic simulator
artifact. Use the same `session:text_selection` fixture and runner bytes for the
unchanged-product baseline and candidate. Build with
`EXPO_PUBLIC_SCREENSHOT_HARNESS=1`,
`EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT=session:text_selection`,
`EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK=1` and `EXPO_PUBLIC_HARNESS=1`; the last flag
installs the existing native telemetry sink for range evidence. These flags belong
only to the isolated fixture build. No live token, Send or provider call is used.
The fixture link uses one owned loopback receiver at `127.0.0.1:17889`; an occupied
port refuses instead of reusing another service.

The runner borrows the existing storage-owner companion. In addition to the
explicit `IDB_COMPANION`, inherit the owner's
`PENTACLE_REPORT_VIEWER_INPUT_CONTEXT` and `SIM_QUEUE_OWNER_VERIFIED_PID`.
The existing context binds device set, UDID, owner PID, companion PID/kernel birth
and socket; every idb invocation receives that exact socket. It must already be
Booted and return a real AX tree. No discovery, boot, reset, companion launch or
foreign cleanup occurs in this runner. The owner supplies `F2_ARTIFACT_MANIFEST`,
a JSON file binding `source_sha`, `fixture_sha256`, `config_sha256`,
`app_binary_sha256` and `embedded_bundle_sha256` from the exact built/installed app.

```sh
IDB_COMPANION="$F2_IDB_COMPANION" python3 test/e2e/message_text_selection.py   --device-set "$SIM_DEVICE_SET" --udid "$SIM_UDID"   --bundle-id "$F2_BUNDLE_ID" --source-sha "$CANDIDATE_SHA"   --output "$F2_EVIDENCE_DIR"
```

Use `--baseline` for unchanged product plus the identical fixture/harness delta:
expected exit 1, `PRODUCT_FAIL`, with both roles' whole-message copy or missing
word range. Candidate exit 0 requires exact `silver`, then `silver amber`, Unicode
UTF-16 and multiline subranges, two native handles, link routing/linked selection,
scrolling, attachment viewing and a retained unsent draft. Apple Vision locates
words in real screenshots; coordinates use the actual AX/screenshot scale, and
idb performs every press/handle drag. No selection or copy is set programmatically.
Python, Node, Swift/Vision, idb, simctl and ffprobe must be installed before entry.

`--preflight-only` performs no fixture/clipboard/gesture mutation. With
`IDB_COMPANION` omitted it must exit 2 as `HARNESS_ERROR` before any native command;
verify `commands=[]` in result.json. Missing/stale/mismatched context or a degenerate
AX tree also refuses. Those failures are harness errors and cannot be baseline RED.
Each invocation needs a new output directory. Retain result.json, command exits,
AX, PNG/Vision frames, PID-bound range telemetry, finalized video and file hashes.
The runner reports its owned app/recorder/log cleanup counts; the allocation owner
then stops its own companion and shuts down only its allocated simulator.


Source-only oracle controls (no simulator commands):

```sh
python3 test/e2e/message_text_selection.py --check-oracles /absolute/new/output
```

These reject an unchanged transcript even if unrelated pixels change, accept a
moved-row control and retain partial diagnostics from a real owned command timeout.
`SOURCE_CONTROLS_PASS` is never native acceptance. Native vertical scrolling requires
real AX row movement/visible-row changes. Draft readbacks follow all scrolling and
an observed same-row rerender. That rerender uses the allocated simulator's existing
`simctl ui content_size` setting to exercise RN fontScale and native measurement;
the runner retains/restores the exact per-device preimage in finally. It changes no
host or physical-device preference and still requires the explicit native window.

## Normal Send and provider queue release

Agent chats always use ordinary Send. A busy provider owns queueing; the app
sends the original input once and never holds it until idle. Sending remains
until a matching receipt or USER processing proof arrives. A positive provider
queue receipt shows Queued and offers Send now on that row. Send now issues
one generation-fenced interrupt, without resending text or attachments. Stop
shares that budget while provider-owned queued rows remain pending. An
unconfirmed interrupt preserves Queued; only an explicit failure permits a
user-requested retry. Composite and question sends retain their own routes.

Focused coverage is in `sessionScreenSteerQueueStop.test.tsx`,
`sessionScreenQueuedSendRender.test.tsx`, `sessionScreenEscInterrupt.test.tsx`,
`sendWhileWorkingQueue.test.ts` and `sendTurnAction.test.ts`. Run the vendored
core tests separately with `npm --prefix pentacle-chat-core test`; root Jest
excludes that directory. `composerRenderedManifest.test.tsx` captures identical
baseline/candidate states with `PENTACLE_RENDER_MANIFEST=/absolute/output.json`.
The actual rendered tree covers idle/working drafts, unconfirmed/provider-queued/
processing rows, composite/question routes, and Copy message presentation.

A scoped device release also requires a reviewed full diff and rendered-state
manifest against the exact installed artifact, including upstream changes.
The owned release recipe checks reviewed source/config/render pins before build
and before install. An unexplained visible change, changed pin, or missing
expected UI effect refuses release. Preserve the configured assistant identity,
signing, endpoint and bundle guards, the installed app preimage, and physical
journey evidence. Source/render green does not establish native gestures or
provider processing. Phone actions remain inside the release owner's named
operator window; no TestFlight or OTA is implied.

## Advertised provider visibility and committed pending sends

Run `npx jest --runInBand --runTestsByPath tests/summonProviderVisibility.test.tsx tests/summonModelPickerFilter.test.tsx tests/spawnCatalogAvailableModels.test.ts tests/committedPendingSend.test.tsx` for the affected picker and actual transport/reducer/transcript paths.

A present `available_models` map is exhaustive: omitted providers stay hidden,
unsupported additions are ignored, and an empty supported set disables Start.
An absent map retains the legacy full supported catalog. Open-sheet refreshes
revalidate provider/model/effort choices; explicit and handoff resolution keeps
the unchanged full catalog.

`committed_pending_proof` is accepted with proof pending, even without a
compatibility `state` field. Verify Sending without Failed or Retry, original
identities, no resend after timers/reconnect, matching late receipt/USER
convergence, and terminal/identity controls. Voice retains its existing route.

## Direct-child history harness navigation

The `nexus_agents_history_questions` scenario is registered with
`test/e2e/run_scenario.py`. Its synthetic parent has role `nexus`, and it
requires the product's `nexus_agents_roster_rendered` and
`nexus_agents_history_rendered` telemetry plus the durable free-text answer.
Prepare the existing scripted mock daemon and fixture injector before running
it, and bind the runner to the owned simulator and installed harness bundle.
The existing-chat harness forwards only `openStatus`, `agentHistory` and
`agentHistoryGeneration` to the session route. Ordinary opens keep their bare
route and shared paint/navigation coordination.

Run the navigation regressions with `npx jest --runInBand --runTestsByPath
tests/services/harnessOpenExistingChat.test.ts tests/services/chatOpenNavigation.test.ts`.
Run the oracle replay and missing-evidence controls with
`python3 -m pytest -q test/e2e/tests/test_nexus_history_contract.py`.
These offline checks do not replace the recorded native scenario.

The history oracle waits for the fixture's content-bearing page, since the
modal first reports empty rows while fetching. Free-text answer dispatch and
roster rendering are independent harness actions; the answer may dispatch
before the roster opens. Both must be observed in the same bound native run.

### Broad synthetic M1 driver

The existing `nexus_agents_history_questions` native entry has an opt-in broad
mock journey. Prepare an owned scripted mock and injector with
`test/e2e/fixtures/scripted_daemon/m1_broad_questions.json`, then run the
canonical script-path entry with `M1_BROAD=1` and `M1_MOCK_WS_URL` set to that
owned numeric-loopback `ws://` endpoint in the scenario env file. Bind the
simulator and harness bundle using the existing gate producer and resource
guard; the IDB companion must resolve that same device set. Grant the simulator
microphone permission before the journey, which starts and discards an owned
synthetic recording. The mock endpoint, injector and native resources remain
the caller's responsibility and must be cleaned up by the owner.

The driver uses actual accessibility frames and gestures for the ninth roster
row, history paging, both exits and question surfaces; the mock observer checks
exact question dispatches. It checks no-card and non-Nexus controls and two
turns around a mock-initiated reconnect. It does not prove real delivery,
configured targets, a physical phone or release readiness. Run its offline
controls with `python3 -m pytest -q test/e2e/tests/test_m1_*` alongside the
existing M1, scripted and mock suites. Native acceptance requires a separately
admitted execution window and a complete result and cleanup receipt.

## Answer fallback reconciliation

`mock_answer_fallback_reconcile` holds the summary-only, resolved-notification
and durable-echo states behind native rendering acknowledgements. Its fixture
uses only synthetic records. Start the existing loopback mock daemon, seed the
scenario's summary with `seed_summary(config)`, then invoke
`python3 test/e2e/run_scenario.py mock_answer_fallback_reconcile --env-file
<owned-env> --runs-dir <fresh-output>` with an installed harness app and the
exact owned simulator/device-set binding. The environment file must include
`ws_url=ws://127.0.0.1:<mock-port>`. The scenario releases the resolved record
only after the fallback mounts, and releases the echo only after the durable
row mounts. It requires all three stages, one assembled row throughout, no
pending/queued state, retained answer text, three screenshots and continuous
runner video. Missing middle-state evidence fails with the echo withheld.

Run the selector-to-screen transitions and identity controls with
`npx jest --runInBand --runTestsByPath tests/sessionScreenAnswerAssembly.test.ts`.
Run the native-oracle controls with
`python3 -m pytest -q test/e2e/tests/test_answer_fallback_native_oracle.py`.
The fallback keeps the interpreter's notification identity; cached rows compare
that identity so equal text from a later notification remains a separate answer.

The separate [configured M1 roster/history harness](configured_m1_harness.md)
uses explicit owned identities, an in-memory mobile credential and a bounded
authenticated observer. Its offline controls do not grant runtime access or
qualify a real configured native journey.
