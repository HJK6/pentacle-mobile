# `lanes-release-contained` — contained native proof of the work lanes overlay

One cold launch of the **normal Release simulator build** against **real**
chat-stream-v2 daemons on an owned scratch store, behind an owned numeric
loopback proxy. Nothing reaches a production daemon, endpoint, store, memory
tree or credential.

| Run | Daemon | Proves |
|---|---|---|
| A | public `HJK6/pentacle` `3dc10e240a163ca4a36a0886326af0b2da09f595` (last main commit before the increment-1 merge; v1 lanes wire) | graceful list and map without members (pending note), real `work_lanes.show` lane log |
| C | A stopped → same store upgraded offline by the increment-1 code (the daemon's own forward migration) → B on the same port | the running app reconnects through the unchanged `ws://127.0.0.1:17896` proxy, same PID, no reinstall; members appear |
| B | `56ca05bc27fac2faf7cf369974cad785ca4129be` (increment 1) | list → expand → map (paged orbit, 9 lanes) → focus (≤ 8 member nodes + `+N`) → all 32 members via a real `work_lanes.show` → member detail → lane log Updates / Spec changes (real `item_change` after a scratch spec edit) / Events → back; missing, ambiguous, no-spec and index-unavailable on real data; accessibility extra-extra-extra-large text recheck |

Assertions use the native accessibility tree (`idb ui describe-all`, testIDs
from the lanes client contract), the loopback proxy's frame log
(`work_lanes.show` request ↔ reply by `request_id`), and direct loopback probes
of the daemon. The normal Release build has no harness telemetry.

## Two build identities (never mixed)

1. **Proof build** (`normal_release_loopback_counterpart`): the same frozen
   source and native inputs as the production app, Release configuration,
   embedded Hermes bundle, compiled with `EXPO_PUBLIC_PENTACLE_WS_URL=ws://127.0.0.1:17896`
   and every reachable configuration host/backend URL set to that loopback
   endpoint; no `EXPO_PUBLIC_HARNESS`, no `EXPO_PUBLIC_SCREENSHOT_HARNESS`. Built
   with an isolated `TMPDIR`. It never goes onto a phone.
2. **Supplemental build** (`screenshot_harness_release`): Release with
   `EXPO_PUBLIC_SCREENSHOT_HARNESS=1` and
   `EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT=lanes:<scene>` (one build per scene:
   `lanes:v1_wire`, `lanes:inc1_cases`, `lanes:overflow`, all replayed from the
   shared fixture). Its output is labelled `harness_rendered_state`; it covers
   the show error state (offline harness) and fixture-only inputs and is never
   evidence of a real daemon request/reply.

Neither identity certifies the production signed device artifact, the
production endpoint or a physical installation.

## Prerequisites (macOS simulator host)

- Xcode with an iOS simulator runtime; `xcrun simctl`; `idb` client and
  `idb_companion` (the runner starts its own companion on `127.0.0.1:10883`).
- Two owned, clean daemon checkouts at exactly the two commits above (trees
  `4eb144a9…` and `17cea613…`); the increment-1 checkout's
  `pentacle-chat-core/tests/fixtures/work-lanes-inventory.json` must hash to
  `2be3dd8d99046c3c8dc293ae4d90a187ab72cb082ef36153d957037a39ddcce1`.
- One owned Python ≥ 3.11 virtualenv satisfying
  `services/chat-stream-v2/requirements.txt` of the increment-1 checkout (also
  imports the v1 checkout; admission checks both and records `pip freeze`).
- The retained loopback proxy script (SHA256 `813136ac…`); the runner copies
  it byte-identically into the run directory and runs the copy.
- The production build's resolved public config
  (`npx expo config --type public --json` with the production config) — only
  its `extra` URLs are used, as strings that must be absent from the proof app.
- Ports `17893`, `17896`, `10883` free; nothing listening on `8081` (Metro).

## Command

```sh
python3 tests/native/lanes-release-contained/run.py run \
  --run-dir <owned evidence root> \
  --app <proof build .app> --bundle-id <its bundle id> \
  --production-config <production public config .json> \
  --v1-checkout <checkout @3dc10e24> --inc1-checkout <checkout @56ca05bc> \
  --python <owned venv>/bin/python --proxy-source <retained proxy script> \
  --device-type <CoreSimulator device type id> --runtime <CoreSimulator runtime id>
```

Run it with the owned venv's Python (it needs `websockets`). `run.py plan`
prints the step plan without acting. Supplemental scenes:

```sh
python3 tests/native/lanes-release-contained/run.py supplemental \
  --run-dir <root> --app <screenshot-harness .app> --scene lanes:inc1_cases \
  --device-type <id> --runtime <id>
```

Exit codes: `0` PASS, `1` FAIL (product assertion), `4` SETUP_FAIL
(precondition, tool or owned-resource failure, including incomplete teardown).

## Containment

- Scratch root `<run>/scratch` (0700): `home`, `operator-auth`, `runtime`,
  `memory`, `blobs`, `tmp`, file-backed `sessions.db`, `notifications.db`,
  `assets.db`. The daemon runs through the pinned repository's
  `test/e2e/lib/web_gate_daemon.py` (SHA256 `0a50ad71…`, identical at both
  pins), which redirects home into the scratch root and keeps production auth,
  projection and show code unchanged.
- Daemon child environment (asserted before every start): `PATH`, `LANG`,
  `TMPDIR=<scratch>/tmp`, `PENTACLE_HOST_ID=local`,
  `PENTACLE_RUNTIME_DIR=<scratch>/runtime`,
  `PENTACLE_MEMORY_ROOT=<scratch>/memory` (explicit; absent means
  not-configured), `PENTACLE_ASSISTANT_AUTO_RESTORE=0`, **`MIC_API=` (empty,
  backend off; unset would default to a managed loopback audio backend)**, and
  the fixture timing delta below. No `HOME`, no inherited agent, assistant,
  provider, cloud or Expo variables. No audio backend is started.
- Daemon argv: loopback `--host 127.0.0.1 --port 17893`, scratch databases and
  blob root, `/usr/bin/false` for tmux/ssh/claude/codex, and all 14 periodic
  fleet tasks disabled (`test_plan.py` pins the exact list). The work-lanes
  inventory and specs sweep stay real.
- Lanes are seeded through the daemon's own `Store` and assistant-composite
  `work_lane.*` operations (adopt; `set_members` after the upgrade), using the
  wrapper's existing synthetic composite identity whose provider wake-up is
  suppressed (labelled boundary). Synthetic work items only.
- Enrollment: one normal enrollment deep link on a fresh simulator against the
  scratch registry; the one-time code is never written to evidence.

### Recorded deltas

- `WORK_INDEX_SWEEP_S=5`, `WORK_INDEX_SETTLE_S=5` (supported daemon settings,
  default 300 s): bounded run time; not the production cadence.
- Proxy: byte-preserving relay; fixed client→daemon rate 32 KiB/s; its process
  record carries a stale owner label; its transcribe fault path stays inert.

## Evidence (`<run-dir>/<run-id>/evidence/`)

`admission.json` (checkouts, venv, proof-app identity and hashes, compiled
scan), `seed-v1.json`, `seed-inc1.json`, `memory-tree.json`, daemon/proxy/
companion logs, `throttle-wire.jsonl` (frame types, request ids and sizes; no
bodies), `trace.jsonl`, `screenshots/` + `screenshots.sha256`, `result.json`
(verdict, per-step timing, checks, scratch file SHA256s), `teardown.json`.

## Teardown (always runs)

Restore content size → terminate and uninstall the app → stop the companion,
daemon and proxy by their recorded PID after re-verifying process identity
(never a broad kill) and confirm listeners cleared → shut down and delete the
simulator this run created (identity checked) → copy the proxy log and hash
every scratch file into the result → remove only the scratch root carrying
this run's ownership marker. Logs, receipts and screenshots stay outside the
scratch root. Any teardown failure makes the verdict `SETUP_FAIL`.

## Known limits

- The show **timeout** state is not reproduced natively (the client request
  timeout equals its no-frame watchdog, so a stalled daemon races reconnect);
  it is covered by device-free tests. A real **transport-unavailable** log
  error is recorded during run C as a non-blocking supplemental check.
- Narrow-width (320 pt) layout is covered by device-free tests; the simulator
  width is fixed by the chosen device type.
