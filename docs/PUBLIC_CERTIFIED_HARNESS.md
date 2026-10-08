# Public certified simulator harness

The public client vendors its core. The native gate consumes the exact advertised
candidate and separately identifies the gate code that executes. Browser render
evidence and source checks do not certify a native artifact.

The executable dependency inventory covers the public full-gate and report-viewer
entrypoints, their tests, local JavaScript imports, Python imports and package
initializers, and actual subprocess paths. It includes the scenario runner,
recorder, native log capture, three report-viewer scenarios, wire validator and
runner, stage instrumentation fixture and optional shared Jest reporter adapter.
It also covers the executed tracked configuration, implicit pytest setup, and
the source file protecting the pure simulator selector extracted by its test.
Conditional imports used by the existing supplied-record question tests remain
in the closure.
The existing fixed nine-case plan remains unchanged: horizontal scrolling, clean
runtime, six expected failures, and the native comments/keyboard journey.

## Dashboard catalog scenario

`dashboard_catalog` is a separate scenario implemented inside the already-pinned
`test/e2e/run_scenario.py`. It does not extend or replace the fixed nine-case
report-viewer plan. No new executable dependency, daemon implementation, or mock
asset handler is introduced. Native execution of this scenario is **NOT RUN**
for this source-only milestone; the fleet runs it on its macOS simulator host.
Python syntax and pure input/redaction checks are not native certification.

### Fixture and credential preconditions

The fleet must supply a hermetic **real** daemon using the public web repository's
`test/e2e/lib/web_gate_daemon.py`, bound to loopback with a scratch store. Seed
through its production `AssetStore` using
`test/e2e/lib/seed_dashboard_assets.py` and the web gate's synthetic catalog
fixture. Use catalog version `0.2.0+aaaaaaa`, boards `example-report`,
`example-board`, and `example-hosted`, and the F-B report rows plus foreign rows
under `example__dashboard_reports`. The report rows must be owned by
`hostx:example-producer`; the latest body produced by the seeder contains
`Synthetic report example-report-20261007T1300Z.` The web fixture's additional
`example-broken` board is allowed but is not a mobile SRI assertion.

The fleet provisions the app credential separately from the report-owner
session. The mobile socket's hello identifies `pentacle-mobile` and a credential,
but exposes no authenticated session identity. Therefore the native scenario can
prove the actual app request used the listed owner, and that the daemon returned
the unique seeded body; it cannot derive the credential's session provenance
from the app or from an opaque token. Fleet credential-issuance provenance is a
required external precondition, not an app-observed fact. Do not substitute the
report owner's credential to make a refusal pass.

The fleet must supply `daemon_token_owner_stream_id` from the token-issuance
record alongside the credential file. This is non-secret setup evidence. Missing
or malformed provenance, or an owner equal to `hostx:example-producer`, fails
before any native work or credential-file read. Accepted stream IDs have a
`hostx:` or `local:` prefix and a 1–128 character alphanumeric/dot/underscore/hyphen
session name. The runner labels the supplied value as a fixture precondition
with `app_observed: false`; it neither sends it as an app identity override nor
decodes or derives it from the token.

Supply these settings through the ignored scenario env file (alongside the
existing bound simulator, bundle, and simulator-device-set settings):

```dotenv
PENTACLE_DAEMON_WS_URL=ws://127.0.0.1:17880/
dashboard_catalog_spec_id=example__dashboard_catalog
daemon_token_file=/absolute/path/to/fixture-app-token
daemon_token_owner_stream_id=local:example-reader
```

The scenario inspects the native UI with `idb`, which resolves only the default
simulator device set. With any other `PENTACLE_SCENARIO_DEVICE_SET_ROOT` it requires
`IDB_COMPANION` (the companion address the storage gate exports) and refuses before
native work without it.

The URL must use a numeric loopback host and an explicit port, without URL
credentials, query parameters, or a fragment. The token file must already exist,
be an owned regular non-symlink file with mode `0600`, and contain the app's
existing fixture-daemon credential. The runner reads it only during native
execution. It uses the existing nonpersistent `pentacle_token` harness launch
parameter consumed by `usePentacleTokenHarness` and `usePentacleToken`; it does
not use `install_device_token`, enroll a device, alter authorization, or persist
the credential in SecureStore. The value and its encoded forms are masked before
runner traces, raw log chunks, telemetry, or errors are retained. Neither the
file value nor a token hash belongs in the result or this repository.

The runner never starts, seeds, resets, or shuts down the supplied daemon. Its
scratch-store ownership, production seeding, credential provenance, and teardown
are the fleet fixture owner's responsibility. The mobile mock daemon has no
asset handlers and is expressly not a fallback for this scenario.

### Native journey and evidence

Run on the fleet's bound, installed harness build with `EXPO_PUBLIC_HARNESS=1`:

```sh
PYTHONPATH=test:test/e2e python3 test/e2e/run_scenario.py dashboard_catalog \
  --env-file "$HOME/.pentacle-test.env" --runs-dir test/e2e/runs
```

The runner performs two separately identified cold launches under one primary
result, each with its own native PID proof, recording, logs, accessibility trace,
screenshots, runtime observation, and owned teardown:

1. Configured: first require the real connection's connected, non-connecting,
   hydrated store transition from the freshly verified native PID after arming.
   This existing telemetry has no run-id field, so the proof uses that native PID
   and receipt-time boundary. Then tap the actual Dashboards tab, inspect version `0.2.0+aaaaaaa`,
   select `example-report`, and require latest
   `example-report-20261007T1300Z` plus its unique seeded body in the native
   accessibility tree. Require the app's same-run, same-native-PID successful
   `harness:ui_trace` telemetry with `kind: dashboard_report_asset_get`: `listed_stream_id` and
   `request_stream_id` must both be `hostx:example-producer`, and `spec_id` must
   be `example__dashboard_reports`. Select `example-board` and `example-hosted`
   individually, using native horizontal selector gestures when necessary; each
   must show `Unsupported on this client`.
2. Unset: relaunch with an explicit empty `dashboard_catalog_spec_id`, overriding
   any baked Expo extra value. Require `No dashboards yet` and no catalog asset
   request telemetry during the empty-state observation. The configured leg also
   requires a real catalog list event, so an absent telemetry path cannot alone
   produce a passing no-request assertion.

The existing service sends report commands over the app's already-authenticated
connection. The runner never fetches the report itself and never injects an asset
reply. An observed report `asset.get` error stops assertions immediately, records
the exact daemon error code and `stopped_on_denial`, and skips the unset launch.
There is no alternative authorization attempt. The pinned fixture daemon's
`asset.error` sets `error` and `error_code` to the same code, so the existing mobile
transport's `Error.message` preserves it. Missing owner/get/body evidence fails;
failure, unavailable native tools, or incomplete teardown cannot become PASS.

The primary JSON declares `-configured.case.json` and, only when reached,
`-unset.case.json` sidecars. Each declares its native artifacts; the top-level
teardown receipt combines only the two launches' owned resources. The credential
mechanism and supplied token-issuance provenance are labeled in the result. Keep
the final candidate's runner and example-config pin update in its separately
reviewed last commit; hash alignment alone does not certify this native journey.

`scripts/storage-certified-closure.test.cjs` follows those public callers.
`scripts/storage-authority.cjs` pins the executable bytes. The literal oracle in
`scripts/storage-model-oracle.test.cjs` is derived independently from reviewed
files and caller edges. Pin alignment requires inspection and independent review;
an updated hash alone does not establish accepted behavior. Missing and tampered
controls test every component after a complete clean fixture first certifies.

## Explicit source representations

`config/pentacle-chat-core-pin.json` uses schema 2, representation `vendored_tree`,
path `pentacle-chat-core` and the exact tracked subtree ID. Legacy schema 1 uses a
gitlink commit. Missing, mismatched or unknown forms fail. The provisioner and
native builder check the actual tracked representation; vendored trees are never
peeled as commits or substituted through a network fallback. Executed core bytes
must remain clean. Clone tests use a real submodule for legacy assertions.

The native builder admits exactly two entries of one explicit parent bundle
identity, `com.example.pentacle.mobile` or `quest.pentacle.mobile`, plus exactly two
`Pentacle` product-name replacements. The full-gate delta check independently
reads the pinned parent project and restricts the derived change to those four
replacements. Mixed identities, unknown identities, count drift and additional
native changes fail. Native path and provenance checks still apply.

## Runtime evidence and cleanup

The recorder uses `simctl recordVideo` on the bound simulator. Its probe waits at
most five seconds for readiness, samples for half a second, stops its own process
gracefully, then verifies finalized nonempty video and hashes it. Probe video is
removed. Only exit 16 with the exact host-recording-busy reason permits one bounded
shutdown/boot/bootstatus cycle and one retry. Unknown errors, forced termination,
unreaped recorders or missing output hold the gate.

The scenario runner requires an explicit simulator UUID, bound bundle and run ID.
It records native logs and preserves their PID envelope; a payload field cannot
replace native process identity. The launched PID must match same-run arming and
the native process census. Runtime sentinel results retain error, crash or
liveness evidence, with a 2.5-second post-scenario observation period. Fatal
release uses an owned loopback acknowledgement after identity verification.

Horizontal scrolling and commenting use the real accessibility tree, gestures
and keyboard. The fixture report is local. Results contain one primary JSON plus
declared video, log, UI trace, screenshot and teardown sidecars. The runner stops
only its owned app, recorder, log process and loopback server. A running bundle
from another journey is rejected. Failed cleanup cannot become a PASS.

The ignored `.pentacle-test.env` is selected through `--env-file` or the host
default. Explicit/default temporary-input tests exercise the actual CLI dispatch
path, success and cleanup; missing or malformed input fails before native work.
The gate wrapper pins the host input before its scratch environment is applied.
It derives the Python user site from the `idb` launcher actually executed rather
than assuming the host default interpreter is the same. Missing modules or
unsupported launcher forms fail without a fallback.

The optional Jest adapter forwards callbacks, arguments, promises and errors to
the configured shared reporter. Only an unavailable optional reporter becomes a
no-op. The wire runner always requires an explicit full checkout SHA, actual
supplied artifacts and server cleanup proof; it invokes the public validator and
retains protocol mutation rejection.

## Validation and promotion

Run affected harness tests first, with sequential Node file execution where
process timing controls are involved. Run Python tests in an isolated public
test environment with `PYTHONPATH=test:test/e2e`. Complete public content checks,
unit/type checks, iOS JavaScript export and independent source review before
publishing a non-promoting candidate. Required CI binds that exact SHA.

From the clean advertised candidate, use the existing storage path:

```sh
node scripts/storage-cli.cjs gate:certified HEAD /absolute/path/fd-window.json
```

The facade derives PATH and import wiring, validates the allocation and source
inputs, runs the reviewed observer once and carries the native/full opaque state
without caller copying. The command requires a regular bounded allocation file
containing schema 1, FD GO/tell and unique attempt IDs, host/UID, full candidate
and gate-code SHAs, policy revision, not-before/expiry epochs, and SHA256-bound
`source_qa`, `policy_qa` and `ci` references. A distinct gate-code SHA also requires
its own `gate_qa` and `gate_ci`; these may reference the same receipts when the
candidate and gate are identical. QA values come from typed verdict fields,
not prose summaries. Reference paths are absolute owned regular JSON files.
The policy review must target the exact executing gate-code SHA, which contains
the canonical policy revision and values. Prior policy evidence may be reused in
that review; an accepted report targeting unrelated source cannot admit a launch.

The quiet predicate retains 60 timed intervals over at least 60 seconds, excludes
the initial cumulative row, requires median TPS below 2000 and peak at most 10000,
and keeps all process/simulator/completeness and owned-command checks. The proposed
first-claim interval is 120 seconds after observation completion, subject to the
scoped launch review before activation. The same immutable claim carries through
preparation and full; it is not claimed anew after preparation. Raw process, disk
and review files are copied and hashed into retained evidence. A reused attempt,
unbound review, missing PID identity or unknown raw file refuses. Legacy run
records remain readable but cannot admit a new certified run without a claim.

The original 44-member literal pin table remains mandatory with every missing/
altered control. Launch source, including the authority table itself, is also
attested against the exact reviewed gate commit's tracked Git blobs before
observation; snapshot attestation retains its stricter no-untracked rule. This
avoids a self-referential authority hash and preserves exact executed bytes even
when an index flag hides a local edit. Independent census covers both classes
and actual callers.

The supported command returns one REFUSED, FAILED, CLEANUP_INCOMPLETE or CERTIFIED
disposition, with original failure and cleanup outcomes retained.
For a readable allocation with a valid attempt ID, preflight refusals also retain
a restricted terminal record before any child starts. An existing attempt record
is preserved; a reused allocation gets a separate refusal record.
The command verifies the claimed admission, full result, journal, evidence digest, final window and owned
cleanup together. Low-level operations retain the same guard for diagnostics;
a full exit zero alone is insufficient. Keep raw receipts and final digests in
artifact holding; lock tokens stay local and are redacted from persisted summaries.
Admission or harness failure holds native promotion. Harness source lands
separately before a product candidate is rebased and certified. Phone interaction
retains its separate release approval boundary. Pentacle Mobile uses the existing
configured, signed Release/embedded-bundle USB `devicectl` path, with an in-place
handoff and no uninstall, erase, app-data or Keychain clear. The certified source
feeds the existing prebuild rule and ready-artifact packet; operator plug-in/unlock
approval and physical first-screen screenshot remain at that boundary. The certified
command does not perform an install. TestFlight is reserved for the separate phone product.

The coordinator rejects externally supplied `_dashboard_catalog_phase` values. Both cold launches remain mandatory for successful certification. A daemon denial skips further UI/capture steps and the unset phase; owned teardown still runs and any secondary cleanup failure retains the original exact denial code. Credential masking covers native JSON-in-JSON encoding before raw log writes and recursively sanitizes retained event, command and error values.

Catalog discovery gets also emit the existing `harness:ui_trace` event with `kind: dashboard_catalog_asset_get`. A refusal there stops before the report proof and retains the failing kind, asset, spec and listed/requested owner in `failed_asset_get`; it is never labelled a completed report cross-owner check. Both get kinds use the same native PID/run-bound denial watcher.
