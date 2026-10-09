#!/usr/bin/env python3
"""Owned scratch chat-stream-v2 daemon for the `lanes-release-contained` native scenario.

Everything here is fixture ownership: one scratch root, a synthetic work tree, a
store seeded through the daemon's own Store/AssistantComposite operations, the
pinned daemon repository's isolation wrapper, a byte-identical copy of the
retained loopback proxy, and owned process start/identity/stop receipts.

Two halves:
* Host-side helpers (imported by run.py and test_plan.py): constants, the
  restricted child environment and its containment assertion, daemon argv,
  checkout/file identity, the synthetic memory tree, process lifecycle and
  loopback probes. They import no daemon code.
* Subcommands executed with the pinned daemon checkout on `sys.path`
  (`python scratch_daemon.py seed|enroll-link ...`). They redirect `Path.home`
  into the scratch root before any daemon import, exactly like the wrapper.

No production daemon, store, credential or memory tree is read or written.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Identities and ports
# ---------------------------------------------------------------------------

# Run A: last public main commit before the increment-1 merge (its services tree
# equals the earlier proven isolated-release daemon); serves v1 lanes only.
PIN_V1 = "3dc10e240a163ca4a36a0886326af0b2da09f595"
PIN_V1_TREE = "4eb144a9c9f1ae692346f978c89dfeb6ecd8b96f"
PIN_INC1 = "56ca05bc27fac2faf7cf369974cad785ca4129be"
INC1_TREE = "17cea613aaf9a08c6815fe076c26fb14a2627159"
FIXTURE_PATH = "pentacle-chat-core/tests/fixtures/work-lanes-inventory.json"
FIXTURE_SHA256 = "2be3dd8d99046c3c8dc293ae4d90a187ab72cb082ef36153d957037a39ddcce1"
WRAPPER_PATH = "test/e2e/lib/web_gate_daemon.py"
WRAPPER_SHA256 = "0a50ad7134bf9b07d64c4a5aff2d3b979696fa1acda57f969cc26c5ca5ab36aa"
PROXY_SHA256 = "813136ac6da883a20e83bdfa5b2cbc29fee076574ff25526167d5bef421937e9"

HOST = "127.0.0.1"
DAEMON_PORT = 17893
PROXY_PORT = 17896
COMPANION_PORT = 10883
METRO_PORT = 8081
APP_WS_URL = f"ws://{HOST}:{PROXY_PORT}"

# The wrapper's existing synthetic assistant-composite fixture: with this
# manifest present it binds exactly these identities and suppresses the
# composite's provider wake-up (no outbound provider work).
COMPOSITE_STREAM = "local:web-gate-assistant"
PRODUCER_SESSION = "web-gate-voice-producer"
PRODUCER_STREAM = "local:" + PRODUCER_SESSION
PRODUCER_GENERATION = "lanes-contained-producer-gen"

DISABLED_TASKS = (
    "mirror", "ingest", "hosts", "reconciler", "retention", "nudges", "notification-expiry",
    "remote-presence", "event-push-ingest", "routing-integrity", "outbound-notices",
    "awaiter-resolution", "window-schedule", "usage-state-publisher",
)

# Supported daemon knobs (work_lanes_projection.py WORK_INDEX_SWEEP_S /
# WORK_INDEX_SETTLE_S, default 300 s each). Shortened for a bounded run and
# recorded as a fixture timing delta, never presented as production cadence.
FIXTURE_TIMING = {"WORK_INDEX_SWEEP_S": "5", "WORK_INDEX_SETTLE_S": "5"}

# Inherited keys that must never reach the daemon child.
FORBIDDEN_ENV_PREFIXES = (
    "AGENT_ORCH_", "PENTACLE_ASSISTANT_", "PENTACLE_COSMO", "COSMO_", "AWS_", "ANTHROPIC_", "OPENAI_",
    "CLAUDE", "CODEX", "GEMINI", "PENTACLE_WEB_GATE_", "PENTACLE_REMOTE", "SSH_", "EXPO_",
)
PASSTHROUGH_ENV = ("PATH", "LANG")

# ---------------------------------------------------------------------------
# Lane and member plan (stable: lane_id = "wl-" + sha256(composite + NUL + key)[:24])
# ---------------------------------------------------------------------------

BIG = [f"spec_example__span_{index:02d}" for index in range(1, 33)]
MISSING = "spec_example__absent_item"
AMBIGUOUS = "spec_example__twin_item"
EDITED = BIG[0]  # one AC is ticked after B starts -> one real item_change

# (key, title, state, lead, blocker, v1 seeded?, inc1 members or None, inc1 no_spec_reason)
LANES: list[dict[str, Any]] = [
    {"key": "request:lanes-contained-span", "title": "Paper bridge spans", "state": "active", "lead": "lead-span",
     "v1": True, "members": BIG},
    {"key": "request:lanes-contained-leadless", "title": "Kite frame study", "state": "paused", "lead": None,
     "v1": True, "members": ["spec_example__kite_frame", MISSING]},
    {"key": "request:lanes-contained-blocked", "title": "Clay tile batch", "state": "blocked", "lead": "lead-tile",
     "blocker": "Waiting for a kiln window", "v1": True, "members": ["spec_example__tile_glaze", AMBIGUOUS]},
    {"key": "request:lanes-contained-paused", "title": "Rope ladder rung", "state": "paused", "lead": "lead-rope",
     "v1": True, "members": ["spec_example__rung_knots"]},
    {"key": "request:lanes-contained-nospec", "title": "Planning conversation", "state": "paused", "lead": None,
     "v1": True, "members": [], "no_spec_reason": "A planning conversation without specs."},
    {"key": "request:lanes-contained-sixth", "title": "Sail stitching", "state": "paused", "lead": None,
     "v1": False, "members": ["spec_example__sail_seam"]},
    {"key": "request:lanes-contained-seventh", "title": "Lantern frames", "state": "paused", "lead": None,
     "v1": False, "members": ["spec_example__lantern_frame"]},
    {"key": "request:lanes-contained-eighth", "title": "Drum skins", "state": "paused", "lead": None,
     "v1": False, "members": ["spec_example__drum_skin"]},
    {"key": "request:lanes-contained-ninth", "title": "Bell tuning", "state": "paused", "lead": None,
     "v1": False, "members": ["spec_example__bell_tuning"]},
]


def lane_id_for(key: str, composite: str = COMPOSITE_STREAM) -> str:
    return "wl-" + hashlib.sha256((composite + "\x00" + key).encode()).hexdigest()[:24]


def v1_lane_ids() -> list[str]:
    return [lane_id_for(lane["key"]) for lane in LANES if lane["v1"]]


def all_lane_ids() -> list[str]:
    return [lane_id_for(lane["key"]) for lane in LANES]


def big_lane_id() -> str:
    return lane_id_for(LANES[0]["key"])


# ---------------------------------------------------------------------------
# Containment: environment, argv, scratch layout
# ---------------------------------------------------------------------------

def scratch_layout(scratch: Path) -> dict[str, Path]:
    return {name: scratch / name for name in ("home", "operator-auth", "runtime", "memory", "blobs", "tmp")} | {
        "sessions_db": scratch / "sessions.db", "notifications_db": scratch / "notifications.db",
        "assets_db": scratch / "assets.db", "manifest": scratch / "voice-answers-fixture.json",
        "codes": scratch / "home" / ".config" / "pentacle-mobile" / "enrollment-codes.json",
    }


def make_scratch(scratch: Path) -> dict[str, Path]:
    scratch.mkdir(mode=0o700)
    layout = scratch_layout(scratch)
    for name in ("home", "operator-auth", "runtime", "memory", "blobs", "tmp"):
        layout[name].mkdir(mode=0o700)
    return layout


def child_env(scratch: Path, inherited: dict[str, str] | None = None) -> dict[str, str]:
    """Restricted daemon/seed child environment (lane-only; backend-off audio)."""
    source = os.environ if inherited is None else inherited
    layout = scratch_layout(scratch)
    env = {key: source[key] for key in PASSTHROUGH_ENV if key in source}
    env.setdefault("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
    env.setdefault("LANG", "C.UTF-8")
    env.update({
        "TMPDIR": str(layout["tmp"]),
        "PENTACLE_HOST_ID": "local",
        "PENTACLE_RUNTIME_DIR": str(layout["runtime"]),
        "PENTACLE_MEMORY_ROOT": str(layout["memory"]),
        "PENTACLE_ASSISTANT_AUTO_RESTORE": "0",
        # Mandatory: empty string is the supported backend-off state. Unset
        # would default to a managed loopback audio backend.
        "MIC_API": "",
        "PYTHONDONTWRITEBYTECODE": "1",
        **FIXTURE_TIMING,
    })
    assert_containment(env, scratch)
    return env


def assert_containment(env: dict[str, str], scratch: Path) -> None:
    """Fail before any daemon start if the child env could leave the scratch boundary."""
    if "MIC_API" not in env or env["MIC_API"] != "":
        raise ValueError("containment: MIC_API must be present and set to the empty string")
    root = env.get("PENTACLE_MEMORY_ROOT", "")
    if not root or not _under(Path(root), scratch):
        raise ValueError("containment: PENTACLE_MEMORY_ROOT must be an explicit path under the scratch root")
    for key in ("PENTACLE_RUNTIME_DIR", "TMPDIR"):
        if not env.get(key) or not _under(Path(env[key]), scratch):
            raise ValueError(f"containment: {key} must be under the scratch root")
    if "HOME" in env:
        raise ValueError("containment: HOME is not passed; the wrapper redirects home into the scratch root")
    for key in env:
        if key == "PENTACLE_ASSISTANT_AUTO_RESTORE":
            continue
        if key.startswith(FORBIDDEN_ENV_PREFIXES):
            raise ValueError(f"containment: inherited key {key} is not allowed")


def _under(path: Path, root: Path) -> bool:
    try:
        return os.path.realpath(path) == os.path.realpath(root) or Path(os.path.realpath(path)).is_relative_to(os.path.realpath(root))
    except (OSError, ValueError):
        return False


def daemon_argv(python: str, checkout: Path, scratch: Path, port: int = DAEMON_PORT) -> list[str]:
    layout = scratch_layout(scratch)
    return [python, str(checkout / WRAPPER_PATH), str(scratch),
            "--host", HOST, "--port", str(port), "--local-host", "local",
            "--db", str(layout["sessions_db"]), "--notifications-db", str(layout["notifications_db"]),
            "--assets-db", str(layout["assets_db"]), "--blob-root", str(layout["blobs"]),
            "--tmux-bin", "/usr/bin/false", "--ssh-bin", "/usr/bin/false",
            "--claude-bin", "/usr/bin/false", "--codex-bin", "/usr/bin/false",
            *[f"--disable-{task}" for task in DISABLED_TASKS]]


def assert_scratch_paths(scratch: Path) -> dict[str, Any]:
    """Every store/registry/memory file (incl. SQLite sidecars) lives under scratch."""
    found = []
    for path in sorted(scratch.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"containment: symlink inside scratch: {path.name}")
        if path.is_file():
            found.append(str(path.relative_to(scratch)))
    return {"scratch_files": found}


# ---------------------------------------------------------------------------
# Identity helpers
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(checkout: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(checkout), *args], capture_output=True, text=True,
                          check=True, timeout=30).stdout.strip()


def verify_checkout(checkout: Path, pin: str) -> dict[str, Any]:
    """Owned daemon checkout: exact commit, clean tree, expected wrapper and fixture bytes."""
    head = git(checkout, "rev-parse", "HEAD")
    if not head.startswith(pin):
        raise ValueError(f"daemon checkout HEAD {head[:12]} is not the pinned commit {pin[:12]}")
    dirty = git(checkout, "status", "--porcelain", "--untracked-files=no")
    if dirty:
        raise ValueError("daemon checkout has tracked modifications")
    wrapper = sha256_file(checkout / WRAPPER_PATH)
    if wrapper != WRAPPER_SHA256:
        raise ValueError("daemon isolation wrapper bytes differ from the reviewed wrapper")
    receipt = {"checkout": str(checkout), "head": head, "tree": git(checkout, "rev-parse", "HEAD^{tree}"),
               "wrapper_sha256": wrapper}
    fixture = checkout / FIXTURE_PATH
    receipt["fixture_sha256"] = sha256_file(fixture) if fixture.is_file() else None
    return receipt


def copy_proxy(source: Path, run_dir: Path) -> Path:
    """Byte-identical copy of the retained loopback proxy into the owned run directory.

    The script writes its wire log and process record beside itself, so it must
    never execute from the directory that holds earlier evidence.
    """
    if sha256_file(source) != PROXY_SHA256:
        raise ValueError("retained proxy bytes differ from the reviewed proxy")
    target_dir = run_dir / "proxy"
    target_dir.mkdir(mode=0o700)
    target = target_dir / "throttle-proxy.py"
    shutil.copyfile(source, target)
    if sha256_file(target) != PROXY_SHA256:
        raise ValueError("proxy copy is not byte-identical")
    return target


PROXY_DELTAS = {
    "relay": "byte-preserving TCP relay; parsing is log-only",
    "upstream": f"{HOST}:{DAEMON_PORT}, dialled per client connection",
    "client_to_daemon_rate_bytes_per_s": 32768,
    "owner_label_in_process_record": "stale label from the retained script; not this run's owner",
    "transcribe_fault_path": "inert: no transcribe frames, no proxy-control.json created",
}

# ---------------------------------------------------------------------------
# Synthetic work tree (PENTACLE_MEMORY_ROOT)
# ---------------------------------------------------------------------------

def _spec_text(spec_id: str, title: str, checked: int, total: int) -> str:
    boxes = "".join(f"- [{'x' if index < checked else ' '}] Step {index + 1}.\n" for index in range(total))
    return (f"---\nid: {spec_id}\ntitle: {title}\n---\n"
            "## Estimate\n- elapsed_delivery_h: 2–4 (median 3)\n- basis: none (provisional)\n"
            f"## Acceptance Criteria\n{boxes}")


def _item(root: Path, bucket: str, folder: str, spec_id: str, title: str, checked: int, total: int) -> Path:
    path = root / "work" / bucket / folder
    path.mkdir(parents=True)
    (path / "spec.md").write_text(_spec_text(spec_id, title, checked, total), encoding="utf-8")
    (path / "summary.md").write_text(f"**Next action** — Continue {title.lower()}.\n", encoding="utf-8")
    return path


def write_memory(root: Path) -> dict[str, Any]:
    """Synthetic specs only. MISSING has no file; AMBIGUOUS is declared twice."""
    buckets = ["in_progress"] * 24 + ["completed"] * 6 + ["deprecated"] * 2
    written = []
    for index, spec_id in enumerate(BIG):
        bucket = buckets[index]
        done = bucket != "in_progress"
        _item(root, bucket, spec_id.removeprefix("spec_"), spec_id, f"Span {index + 1:02d}", 2 if done else 0, 2)
        written.append(spec_id)
    for spec_id in ("spec_example__kite_frame", "spec_example__tile_glaze", "spec_example__rung_knots",
                    "spec_example__sail_seam", "spec_example__lantern_frame", "spec_example__drum_skin",
                    "spec_example__bell_tuning"):
        _item(root, "in_progress", spec_id.removeprefix("spec_"), spec_id, spec_id.split("__")[1].replace("_", " ").title(), 1, 3)
        written.append(spec_id)
    _item(root, "in_progress", "example__twin_item", AMBIGUOUS, "Twin item", 0, 1)
    _item(root, "in_progress", "example__twin_item_copy", AMBIGUOUS, "Twin item copy", 0, 1)
    return {"specs": written, "missing": MISSING, "ambiguous": AMBIGUOUS, "edited": EDITED}


def tick_edited_spec(root: Path) -> str:
    """After B is serving: tick one AC of EDITED so the daemon's own sweep records an item_change."""
    path = root / "work" / "in_progress" / EDITED.removeprefix("spec_") / "spec.md"
    text = path.read_text(encoding="utf-8")
    if "- [ ] Step 1." not in text:
        raise ValueError("edited spec is not in its seeded state")
    path.write_text(text.replace("- [ ] Step 1.", "- [x] Step 1.", 1), encoding="utf-8")
    return EDITED


def hide_memory_root(root: Path) -> Path:
    """Make the owned scratch work root unavailable (index-unavailable case); returns the parked path."""
    parked = root.with_name(root.name + ".parked")
    root.rename(parked)
    return parked


def restore_memory_root(root: Path) -> None:
    root.with_name(root.name + ".parked").rename(root)


# ---------------------------------------------------------------------------
# Owned processes
# ---------------------------------------------------------------------------

def port_free(port: int) -> bool:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((HOST, port))
        except OSError:
            return False
    return True


def port_listening(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def wait_for(predicate: Callable[[], bool], timeout_s: float, label: str, interval: float = 0.2) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise TimeoutError(label)


def process_identity(pid: int) -> dict[str, str] | None:
    result = subprocess.run(["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)],
                            capture_output=True, text=True, check=False, timeout=10)
    line = result.stdout.strip()
    if result.returncode or not line:
        return None
    # lstart is a fixed five-field date ("Fri Oct  9 10:00:00 2026").
    parts = line.split()
    return {"start": " ".join(parts[:5]), "command": " ".join(parts[5:])}


def start_owned(label: str, argv: list[str], *, env: dict[str, str], cwd: Path, log: Path,
                port: int | None, ready_timeout_s: float = 60) -> dict[str, Any]:
    if port is not None and not port_free(port):
        raise RuntimeError(f"{label}: port {port} is not free before start")
    with log.open("ab") as output:
        proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=output,
                                stderr=subprocess.STDOUT, start_new_session=True)
    receipt = {"label": label, "pid": proc.pid, "pgid": os.getpgid(proc.pid), "argv": argv, "cwd": str(cwd),
               "port": port, "log": log.name, "started_at": time.time()}
    receipt["identity"] = process_identity(proc.pid)
    if port is not None:
        try:
            wait_for(lambda: proc.poll() is None and port_listening(port), ready_timeout_s, f"{label} listener")
        except TimeoutError:
            receipt["exit"] = proc.poll()
            stop_owned(receipt)
            raise RuntimeError(f"{label} did not listen on {port} (exit={receipt['exit']})") from None
    receipt["_proc"] = proc
    return receipt


def stop_owned(receipt: dict[str, Any], grace_s: float = 10) -> dict[str, Any]:
    """Stop only the recorded process, after re-verifying its identity. Never broad kill."""
    pid = int(receipt["pid"])
    outcome: dict[str, Any] = {"label": receipt["label"], "pid": pid}
    current = process_identity(pid)
    proc = receipt.get("_proc")
    if current is None:
        outcome["already_absent"] = True
    elif receipt.get("identity") and current != receipt["identity"]:
        outcome["identity_changed"] = True
        raise RuntimeError(f"{receipt['label']}: pid {pid} identity changed; not signalling")
    else:
        os.killpg(int(receipt["pgid"]), signal.SIGTERM)
        deadline = time.monotonic() + grace_s
        while time.monotonic() < deadline and process_identity(pid) is not None:
            if proc is not None:
                proc.poll()
            time.sleep(0.1)
        if process_identity(pid) is not None:
            os.killpg(int(receipt["pgid"]), signal.SIGKILL)
            outcome["sigkill"] = True
            time.sleep(0.5)
        if proc is not None:
            proc.poll()
    outcome["absent"] = process_identity(pid) is None
    if receipt.get("port") is not None:
        try:
            wait_for(lambda: not port_listening(int(receipt["port"])), 10, "listener clear")
            outcome["listener_clear"] = True
        except TimeoutError:
            outcome["listener_clear"] = False
    if not outcome["absent"] or outcome.get("listener_clear") is False:
        raise RuntimeError(f"{receipt['label']}: owned stop incomplete {outcome}")
    return outcome


def public_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in receipt.items() if not key.startswith("_")}


# ---------------------------------------------------------------------------
# Loopback probes (direct to the daemon port; loopback reads need no credential)
# ---------------------------------------------------------------------------

async def _probe(port: int, lane_id: str | None, timeout_s: float) -> dict[str, Any]:
    import websockets  # daemon venv dependency

    out: dict[str, Any] = {"inventory": None, "show": None}
    async with websockets.connect(f"ws://{HOST}:{port}", open_timeout=timeout_s, max_size=None) as ws:
        hello = {"type": "hello", "client": "lanes-release-contained-probe",
                 "capabilities": {"work_lanes_v1": True},
                 "subscribe": {"snapshot": True, "events_mode": "summary"}}
        await ws.send(json.dumps(hello))
        request_id = "lanes-contained-probe-" + hashlib.sha256(str(time.time()).encode()).hexdigest()[:12]
        sent_show = False
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
            frame = json.loads(raw)
            kind = frame.get("type")
            if kind == "hello.error":
                raise RuntimeError("probe hello refused: " + str(frame.get("error_code") or frame.get("error")))
            if kind == "snapshot" and isinstance(frame.get("work_lanes"), dict):
                out["inventory"] = frame["work_lanes"]
            elif kind == "work_lanes.inventory":
                out["inventory"] = frame
            if out["inventory"] is not None and lane_id and not sent_show:
                await ws.send(json.dumps({"type": "work_lanes.show", "lane_id": lane_id, "request_id": request_id}))
                sent_show = True
            if kind in ("work_lanes.show.ok", "work_lanes.show.error") and frame.get("request_id") == request_id:
                out["show"] = frame
            if out["inventory"] is not None and (not lane_id or out["show"] is not None):
                return out
    raise TimeoutError("loopback probe did not receive inventory/show")


def probe(port: int, lane_id: str | None = None, timeout_s: float = 20) -> dict[str, Any]:
    return asyncio.run(_probe(port, lane_id, timeout_s))


def summarize_frame(frame: dict[str, Any] | None) -> dict[str, Any]:
    """Ids/counts/hash only for retained evidence; no titles or text."""
    if not isinstance(frame, dict):
        return {"present": False}
    body = json.dumps(frame, sort_keys=True).encode()
    lanes = frame.get("lanes") if isinstance(frame.get("lanes"), list) else []
    summary = {"present": True, "type": frame.get("type"), "sha256": hashlib.sha256(body).hexdigest(),
               "lane_ids": [lane.get("lane_id") for lane in lanes if isinstance(lane, dict)],
               "counts": frame.get("counts")}
    if "members" in frame and isinstance(frame["members"], list):
        summary["members"] = len(frame["members"])
        summary["member_ids_sha256"] = hashlib.sha256(
            "\n".join(str(m.get("spec_id")) for m in frame["members"]).encode()).hexdigest()
    for key in ("events", "updates"):
        if isinstance(frame.get(key), list):
            summary[key] = len(frame[key])
    if isinstance(frame.get("work_index"), dict):
        summary["work_index_available"] = frame["work_index"].get("available")
    return summary


# ---------------------------------------------------------------------------
# Subcommands executed inside the pinned daemon checkout
# ---------------------------------------------------------------------------

def _enter_checkout(checkout: Path, scratch: Path) -> None:
    owned_home = scratch / "home"

    def expand(value):
        raw = os.fspath(value)
        if raw == "~":
            return str(owned_home)
        if raw.startswith("~/"):
            return str(owned_home / raw[2:])
        if raw.startswith("~"):
            raise ValueError("named-user home expansion refused")
        return raw

    # Same redirect as the daemon wrapper, before any daemon import.
    Path.home = classmethod(lambda cls: owned_home)
    os.path.expanduser = expand
    sys.path[:0] = [str(checkout / "services"), str(checkout / "services/chat-stream-v2"),
                    str(checkout / "services/chat-stream-v2/tools")]


async def _seed(pin: str, scratch: Path) -> dict[str, Any]:
    from store import Store
    import assistant_composite
    from assistant_composite import AssistantComposite, AssistantCompositeConfig

    layout = scratch_layout(scratch)
    # Boundary (labelled): the composite's provider wake-up is suppressed for the
    # synthetic composite, exactly as the wrapper does at daemon runtime.
    assistant_composite.AssistantComposite._wake_worker = lambda self: None
    store = Store(str(layout["sessions_db"]))
    store.start()
    applied: list[dict[str, Any]] = []
    try:
        producer = await store.open_session("local", PRODUCER_SESSION, visibility="hidden", role="assistant",
                                            provider="claude", pane_status="pane_alive",
                                            session_generation=PRODUCER_GENERATION,
                                            objective="Synthetic lane fixture producer")
        generation = producer["session_generation"]
        config = AssistantCompositeConfig.from_env({
            "PENTACLE_ASSISTANT_COMPOSITE_ENABLED": "1",
            "PENTACLE_ASSISTANT_COMPOSITE_STREAM_ID": COMPOSITE_STREAM,
            "PENTACLE_ASSISTANT_COMPOSITE_TITLE": "Assistant Fixture",
            "PENTACLE_ASSISTANT_DIRECT_PRIMARY_STREAM_ID": PRODUCER_STREAM,
            "PENTACLE_ASSISTANT_DIRECT_PRIMARY_GENERATION": generation,
            "PENTACLE_ASSISTANT_MIRROR_ENABLED": "0",
        })
        composite = AssistantComposite(store, config=config)
        await composite.ensure_projection()
        seq = 0

        async def op(operation, payload, *, lane=None, version=None, request_id):
            nonlocal seq
            seq += 1
            msg = {"type": "assistant.operation", "request_id": request_id, "composite_stream_id": COMPOSITE_STREAM,
                   "dispatch_id": "none", "operation": "work_lane." + operation, "payload": payload,
                   "_auth_context": {"token_verified": True, "stream_id": PRODUCER_STREAM,
                                     "session_generation": generation}}
            if lane is not None:
                msg["lane_id"], msg["expected_lane_version"] = lane, version
            result = await composite.operation(msg, actor_stream_id=PRODUCER_STREAM)
            applied.append({"operation": operation, "request_id": request_id,
                            "lane_id": (result.get("lane") or {}).get("lane_id"),
                            "duplicate": bool(result.get("duplicate"))})
            return result

        async def lead_seat(name):
            row = await store.open_session("local", name, provider="claude", role="lead",
                                           parent_stream_id=PRODUCER_STREAM, visibility="default",
                                           session_generation="gen-" + name)
            return {"stream_id": "local:" + name, "generation": row["session_generation"]}

        for lane in LANES:
            lane_id = lane_id_for(lane["key"])
            existing = await store.get_work_lane(lane_id)
            if pin == "v1" and not lane["v1"]:
                continue
            if existing is None:
                payload = {"adoption_key": lane["key"], "title": lane["title"], "summary": "Synthetic fixture lane",
                           # FD ownership needs lineage through the lead seat; leadless lanes are operator-owned.
                           "owner_kind": "fd" if lane["lead"] else "operator", "work_state": lane["state"],
                           "visible_chat": {"stream_id": COMPOSITE_STREAM}}
                if lane.get("blocker"):
                    payload["blocker"] = lane["blocker"]
                if lane["lead"]:
                    payload["lead"] = await lead_seat(lane["lead"])
                if pin == "inc1":
                    if lane["members"]:
                        payload["members"] = lane["members"]
                    else:
                        payload["no_spec_reason"] = lane["no_spec_reason"]
                await op("adopt", payload, request_id="adopt:" + lane["key"])
            elif pin == "inc1":
                payload = {"members": lane["members"]}
                if not lane["members"]:
                    payload["no_spec_reason"] = lane["no_spec_reason"]
                await op("set_members", payload, lane=lane_id, version=int(existing["lane"]["version"]),
                         request_id="members:" + lane["key"])
        rows = await store.work_lane_rows()
        await composite.stop()
    finally:
        store.stop()
    if pin == "v1" or not layout["manifest"].exists():
        layout["manifest"].write_text(json.dumps({"stream_id": COMPOSITE_STREAM, "producer_stream_id": PRODUCER_STREAM,
                                                   "producer_generation": PRODUCER_GENERATION}))
    return {"pin": pin, "applied": applied, "open_lane_ids": [row["lane_id"] for row in rows]}


def _enroll_link(scratch: Path, label: str) -> dict[str, Any]:
    from mobile_enrollment_cli import issue_link

    result = issue_link(APP_WS_URL, label=label, codes_path=scratch_layout(scratch)["codes"])
    return {"url": result["url"], "expires_at": result["expires_at"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    seed = sub.add_parser("seed")
    seed.add_argument("--checkout", type=Path, required=True)
    seed.add_argument("--scratch", type=Path, required=True)
    seed.add_argument("--pin", choices=("v1", "inc1"), required=True)
    link = sub.add_parser("enroll-link")
    link.add_argument("--checkout", type=Path, required=True)
    link.add_argument("--scratch", type=Path, required=True)
    link.add_argument("--label", default="lanes contained simulator")
    args = parser.parse_args(argv)
    assert_containment(dict(os.environ), args.scratch)
    _enter_checkout(args.checkout.resolve(), args.scratch.resolve())
    if args.command == "seed":
        print(json.dumps(asyncio.run(_seed(args.pin, args.scratch.resolve()))))
    else:
        # The link carries a one-time code; the caller passes it straight to
        # the simulator and never retains it.
        print(json.dumps(_enroll_link(args.scratch.resolve(), args.label)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
