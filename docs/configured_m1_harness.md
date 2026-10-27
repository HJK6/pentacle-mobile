# Configured M1 roster/history harness

`m1_configured_roster_history` is a separate simulator scenario in
`test/e2e/run_scenario.py`. It observes one explicitly owned Nexus/direct-child
pair and nonempty known synthetic history. The existing
`nexus_agents_history_questions` mock and its answer journey remain separate.
This source entry does not qualify a native run or complete broader M1/phone
coverage. It does not build, install, enroll, create sessions or answer questions.

After the runtime owner admits the endpoint, credential provenance, disposable
pair/data isolation, retained app identity and exclusive native-resource window,
the supported command shape is:

```sh
python3 test/e2e/run_scenario.py m1_configured_roster_history \
  --env-file /absolute/owned/configured.env \
  --runs-dir /absolute/owned/results
```

This shape is rehearsed offline with fake transports/native boundaries. A real
invocation remains unverified until those prerequisites and applicable source
and runtime gates pass. Use the existing `scenarioGateOptions(target)` producer
and `SimulatorResourceGuard`; the Python entry neither allocates a simulator nor
acquires a native-resource lease. Preserve the established boot timeout and
ownership/cleanup rules. Supply the exact bound device-set root, simulator UDID
and bundle through the existing `PENTACLE_SCENARIO_DEVICE_SET_ROOT`,
`PENTACLE_GATE_BOUND_SIMULATOR_UDID` and `PENTACLE_GATE_BOUND_BUNDLE_ID` inputs.

The explicit env file contains these additional inputs (example identities and
text are synthetic; no credential value belongs in this file):

```text
PENTACLE_DAEMON_WS_URL=wss://example.invalid:443/ws
daemon_token_file=/absolute/owned/mobile-credential
m1_host=hostx
m1_parent_stream_id=hostx:owned-parent
m1_child_stream_id=hostx:owned-child
m1_parent_generation=parent-generation
m1_child_generation=child-generation
m1_child_name=Owned worker
m1_expected_rows=[{"row_id":"tell:owned-row","text":"Owned synthetic history."}]
```

Require the real current generations and exact indexed row ID/text pairs from
separately admitted fixture preparation. Expectations are not injected into the
app or daemon. The owned parent must be a Nexus with exactly this direct child;
all returned first-page rows must match, without truncation or an older page.
Empty, extra, ambiguous, stale, denied and unrelated data cannot pass. Endpoint
validation requires explicit port and `wss`, or numeric loopback `ws`, without
userinfo/query/fragment; TLS trust/fingerprint and endpoint approval remain the
runtime owner's responsibility. No proxy or compression is used by the observer.

The existing absolute credential file must be an owned regular `0600` file,
opened without following a final symlink or blocking on a FIFO. It must contain
a canonical `pentacle-auth-v2:` envelope for `pentacle-mobile` (an ending newline
is accepted). The harness never issues/revokes a credential or writes a token to
SecureStore. Its only app action is `open_existing_chat`, with the selected
endpoint and credential in the existing in-memory launch URL, plus explicit
parent/host/status/child/generation routing. It requests no biometric bypass,
notification resolution or mock fallback. Actual lock/consent policy remains in
force; handle any required human-only prerequisite in the admitted runtime plan.

The observer uses the existing auth-v2 challenge/proof and sends only `hello`
and `thread.read`, once before launch and once after matching UI evidence. It
checks current inventory, pairing, generations and actual returned rows. Normal
mobile-authenticated `hello` **upserts consent-capability metadata**; this is not
a side-effect-free connection. Both observer handshakes preserve the app's four
true capability flags (`assistant_composite_v1`, `work_lanes_v1`,
`consent_enrollment_offer_v1`, `consent_open_v1`). Future admission must explicitly
include this metadata write and its preimage/rollback/credential disposition.
Never restore capability state or revoke a credential without the owner's grant.

A PASS requires verified same-run arming and exact launched native PID, fresh
post-arming receipt boundaries, hydrated connected state, the rendered owned
child/name and exact history IDs/text, matching pre/post observer generations,
settled native liveness and owned cleanup. Untagged UI traces are bound through
the arming/PID/time chain, not invented run-ID fields. Matching rendered fields
are projected into the evidence; unrelated fields and raw native/user transcript
are discarded. A failed/uncertain launch with no exact returned PID is reported
as unresolved ownership and an orphan, never adopted/killed from a census or
reported clean. Stop for owner recovery; do not retry or blanket-kill resources.

Launch argv/query, stdout/stderr, encoded/chunked credential forms, errors,
results and cleanup are masked or projected before retention. The configured
raw log is deliberately empty. Native video/screenshots require the separately
admitted isolated synthetic target: textual filtering does not prove visual
data isolation. No raw AX tree, config/environment dump or observer frame is
saved. Source-safe failures keep the failing stage without arbitrary exception
or user-transcript text. Exit status remains 0/PASS, 1/FAIL or 4/SETUP_FAIL.

Use Python and dependency versions admitted for the exact source; existing
`test/e2e/tools/requirements.txt` constrains websockets to `>=15,<16`. Pin the
interpreter, dependencies, harness/helper hashes and retained app manifest at
runtime. Offline focused checks need pytest and fake transports, not a daemon:

```sh
python3 -m pytest test/e2e/tests/test_m1_configured_roster_history.py \
  test/e2e/tests/test_run_scenario.py -q
```

These checks trap subject sockets, subprocess/native and credential-registry
effects; only fake owned credential files are read. They cover the actual CLI
and driver, proof/capabilities/oracle, malformed inputs, wrong identity/content,
chunk/encoding masking, capture failures, uncertain launch and cleanup, with
existing mock/dashboard masking controls. They do not replace applicable public
source gates or an admitted configured native journey.
