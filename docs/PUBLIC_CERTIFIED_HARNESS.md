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
env -u npm_config_cache PATH="$PWD/node_modules/.bin:$PATH" node scripts/storage-cli.cjs gate:native-root HEAD
env -u npm_config_cache PATH="$PWD/node_modules/.bin:$PATH" node scripts/storage-cli.cjs gate:full RUN_ID LOCK_TOKEN
```

Use the returned opaque run ID and lock token, the shared simulator queue, and
run-owned cleanup. Keep raw receipts and final digests in artifact holding.
Admission or harness failure holds native promotion. Harness source lands
separately before a product candidate is rebased and certified. Phone interaction
and store submission retain their release approval boundaries.
