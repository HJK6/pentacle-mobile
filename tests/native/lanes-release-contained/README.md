# `lanes-release-contained` — contained native proof of the work lanes overlay

One cold launch of the **normal Release simulator build** against **real**
chat-stream-v2 daemons on an owned scratch store, behind an owned numeric
loopback proxy. Nothing reaches a production daemon, endpoint, store, memory
tree or credential.

| Run | Daemon | Proves |
|---|---|---|
| A | public `HJK6/pentacle` `3dc10e240a163ca4a36a0886326af0b2da09f595` (last main commit before the increment-1 merge; v1 lanes wire) | graceful list and map without members (pending note), real `work_lanes.show` lane log |
| C | A stopped → same store upgraded offline by the increment-1 code (the daemon's own forward migration) → B on the same port | the running app (same app process PID) reconnects through the unchanged `ws://127.0.0.1:17896` proxy, no reinstall; the daemon is a new process on the same owned store and port; members appear |
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
   fixture-only inputs and the offline lane-log state (seeded "connected" with
   no socket, so the real request path rejects at once: "Lane details
   unavailable") and is never evidence of a real daemon request/reply.
3. **Show failure build** (`harness_release_loopback_stub`): Release with
   `EXPO_PUBLIC_HARNESS=1` (harness launch argument accepted only with
   `SIMCTL_CHILD_PENTACLE_ALLOW_HARNESS_LAUNCH_ARG=1`), launched armed with
   `disable_pentacle_auth` and `ws_url=ws://127.0.0.1:17896`. The runner serves
   a loopback stub there (a subclass of `test/e2e/tools/mock_v2_daemon.py`)
   with the shared fixture's v1 inventory. Scenes:
   - `lanes:show_error`: the app's real `work_lanes.show` gets a typed
     `work_lanes.show.error`; asserts "Lane details unavailable" and
     `lane-log-retry`, then that Retry sends a fresh request id for the lane.
   - `lanes:show_timeout`: the request is never answered while pings are
     (so the connection stays live); the client's own 30 s RPC timeout settles
     it; asserts the pending state first (`lane-log-loading`, no Retry), "Request
     timed out" no earlier than the timeout, `lane-log-retry`, and a Retry
     request with a fresh, non-empty request id for the same lane.
   Product settlement is not altered and no component state is injected. Each
   scene writes its own `supplemental.json` (stub receipts: request ids,
   replies, settle time) and screenshots, labelled `harness_rendered_state`.

Every supplemental scene, of either build, takes one shared path: compiled
admission before any simulator exists (the proof build's loopback scan over the
embedded bundle and `app.config`, every `--production-config` operational URL
absent, and the declared build identity; the show failure build must be the
armed "Pentacle Harness" app), then the scene's own check, then its verdict is
frozen as `scene_verdict` before teardown. So both supplemental builds are
compiled with `EXPO_PUBLIC_PENTACLE_WS_URL=ws://127.0.0.1:17896` and every
reachable config host/backend URL set to that endpoint, like the proof build.

None of the identities certifies the production signed device artifact, the
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
  --device-type <id> --runtime <id> --production-config <production public config .json>
# show failure scenes: the harness build, port 17896 free, owned venv Python
python3 tests/native/lanes-release-contained/run.py supplemental \
  --run-dir <root> --app <harness .app> --scene lanes:show_timeout \
  --device-type <id> --runtime <id> --production-config <production public config .json>
```

Reduced modes (the production path only; same admission, daemon, proxy and teardown):

- `run.py smoke ...` (same arguments as `run`): an enroll-only check. It seeds the increment-1 daemon on a
  fresh scratch (no v1 store, no upgrade), launches the app, opens the enrollment link and waits for the
  daemon snapshot through the loopback proxy. It ends on the unlocked, hydrated assistant tab (tab bar, no lock
  text). The scratch daemon's assistant is `local:web-gate-assistant`, not the app's fixed assistant stream id,
  so the assistant header is not rendered; the result records whether it was. About 2–3 minutes.
- `run.py reduced ...`: the smoke, then:
  - open the lanes view: the assistant header status button (`<name> status, N open lanes`) when rendered,
    otherwise the `pentacle://pentacle/lanes` deep link through the exact-match `Open` confirmation. No lanes
    view within 30 s stops the run with SETUP_FAIL and a dump;
  - the list in daemon order (big lane expanded). Cards are found by their `lane-card-log-<lane>` button: on iOS
    only accessible pressables expose a testID, so Text ids such as `lane-card-progress-` are not in the tree;
  - one real `work_lanes.show` round-trip: "show all" opens the 32-member list, paired by `request_id` on
    the proxy;
  - map orbit page 1 in daemon order.

iOS system alerts are pressed only when they match exactly: `Open in “Pentacle”?` → **Open** (the deep-link
confirmation) and `“Pentacle” Would Like to Send You Notifications` → **Don’t Allow**. Each press saves an
accessibility dump under `evidence/ax/`. A known alert without its exact button stops the run with
SETUP_FAIL. Other alerts are never pressed: the step times out with a dump. Every failed step saves a screenshot and an
accessibility dump (`ax/*-failure-<step>.json`).

Taps go to screen points, and the accessibility tree also lists off-screen scroll content. Every tap target whose
centre is outside the screen (less the status bar and home-indicator margins) is first dragged into view and
re-found by its id; a target that does not move, or has no id, stops the run with SETUP_FAIL instead of a blind tap.

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
- Operator registry: before the first daemon start, the pinned wrapper's own
  `web_gate_daemon.py <scratch> --issue` creates the scratch registry and a
  0600 operator envelope in `<scratch>/operator-auth/`. `work_lanes.show`
  needs operator authority at both pins (the loopback allowance does not
  reach it), so loopback probes authenticate with that envelope through the
  pinned checkout's own `_shared/operator_auth` proof. Probe A also checks
  that an anonymous show is refused (`work_lanes_unauthorized`). The envelope
  is never logged and `operator-auth/` is excluded from the scratch hashes.
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
(start time plus the arguments after the interpreter, re-read once the
listener is up because a macOS venv python re-execs into its framework
interpreter; never a broad kill) and confirm listeners cleared → shut down and delete the
simulator this run created (identity checked) → copy the proxy log and hash
every scratch file into the result → remove only the scratch root carrying
this run's ownership marker, and only if every owned stop succeeded (a failed
stop keeps its receipt and the scratch for recovery). Logs, receipts and screenshots stay outside the
scratch root. Any teardown failure makes the verdict `SETUP_FAIL`.

## Known limits

- The show **error** and **timeout** states are not produced by the real
  daemon run (the daemon offers no fault-free show error for a listed lane, and
  a stalled daemon would race the 30 s no-frame watchdog). They are proved by
  the show failure scenes above against a loopback stub, plus device-free
  tests. Run C records the real disconnected log state ("Waiting for
  connection", no request sent) as a non-blocking supplemental check.
- Supplemental teardown is checked: simulator shutdown and delete results are
  recorded, the owned UDID must be absent afterwards, and an incomplete
  teardown (a stub still listening or a failed companion stop included) makes
  the verdict `SETUP_FAIL` with the scene's own frozen result kept as
  `scene_verdict`.
- Assertions use only accessibility elements (buttons, text). Plain container
  views (`lane-card-<id>`, `lane-log-<id>`, `lane-members-<id>`,
  `member-detail-<id>`, `lanes-overlay`, `lanes-map`) are not read.
- Narrow-width (320 pt) layout is covered by device-free tests; the simulator
  width is fixed by the chosen device type.
