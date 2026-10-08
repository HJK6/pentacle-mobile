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
disposition, with original failure and cleanup outcomes retained. It verifies the
claimed admission, full result, journal, evidence digest, final window and owned
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
