# Managed file simulator gate

This gate is source only until its runtime verdict is retained. It does not
install an app, create credentials, enroll an account or start a daemon.
The fleet owns a disposable, already booted iOS simulator, a harness build
(bundle ID ending in `.harness`) and an authenticated loopback fixture daemon.
The physical-device Save to Files check remains a separate human acceptance step.

## Fixture contract

Prepare `fixture:file-chat` with two attachment-only assistant publications:

- `fixture-present.pdf`: exact bytes `%PDF synthetic mobile file gate`
  (31 bytes; SHA256 `c5d7a5959b7e87e6ed84711e0c28853178058599c7307f1abdcbfe7976fd6a6d`)
- `fixture-expired.pdf`: a previously published synthetic PDF whose bytes are
  absent, so authenticated fetch returns the exact `blob_unknown` code

Use the real packet daemon's managed upload/publication path; a raw blob hash is
not a publication receipt. Seed only a new isolated fixture DB/blob directory.
Do not alter a live store. Fixture preparation belongs to the final packet's
cross-repository runtime setup; this runner consumes that prepared fixture.
The app must use that fixture's synthetic credential and loopback endpoint.
No credential or endpoint is put into a source file or this receipt.

The fleet's private JSON receipt has exactly these fields: schema (1),
source_commit (full mobile SHA), daemon_commit (full accepted daemon SHA),
artifact_sha256 (installed `.app` tree fingerprint), app_id, simulator_udid,
prepared_at (timezone-aware, within one hour), synthetic_only (true), disposable
(true), loopback_daemon (true), present_sha256 and present_bytes (the values above).
Use `tree_hash` from run.py to compute the artifact fingerprint: sorted relative
paths and file SHA256 values, plus bounded internal symlink targets. The receipt's
source-to-built-artifact mapping is supplied by fleet build qualification; the
runner independently checks its installed bytes and current checkout identity.

## Commands

- `python3 test/e2e/file_delivery/run.py --check`
- `python3 -m unittest discover -s test/e2e/file_delivery -p 'test_*.py'`
- `python3 test/e2e/file_delivery/run.py --run --receipt PRIVATE_RECEIPT.json --device EXACT_SIMULATOR_UDID`

The native run uses local Maestro only, opens the fixture chat, proves the
unavailable file has a disabled action, opens the present file's native share
sheet, and compares fresh app-cache bytes with the exact fixture. It requires
non-skipped JUnit cases and both screenshots, then terminates only the named
harness app. Its private output contains a verdict and test evidence. It never
reports a native run as passed from a source check or from unit mocks.

Maestro reference: https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options
and https://docs.maestro.dev/reference/commands-available/assertvisible

The flow conditionally accepts the iOS first-deep-link “Open in Pentacle”
confirmation (including the Pentacle Harness display name) before the mandatory
file assertions. Subsequent runs may have no dialog. The source contract checks
its position and presence; fleet must re-prove both fresh and remembered-dialog
journeys on the actual simulator. This follows the [Maestro openLink guidance](https://docs.maestro.dev/reference/commands-available/openlink).

Inline images expose their own `assistant-message-image-N-img` native
accessibility identifier. The touchable wrapper is not an accessibility group;
on iOS, the image has a button role, a descriptive label and a VoiceOver activation
handler while retaining the original tap target. Android retains the original
accessible touchable wrapper and its activation path. Fleet's inline-PNG cell should
assert that identifier and the viewer journey on the rebuilt simulator app.
Source regressions also verify one PNG produces one media item, not a duplicate
file bubble; unrelated PDF publications may legitimately have file selectors.
