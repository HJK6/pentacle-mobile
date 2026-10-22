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
