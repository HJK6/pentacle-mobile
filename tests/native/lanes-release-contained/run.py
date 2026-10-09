#!/usr/bin/env python3
"""`lanes-release-contained`: contained native proof of the work lanes overlay.

Proof subject: the NORMAL Release simulator build (no harness flags) whose
compiled configuration points only at numeric loopback `ws://127.0.0.1:17896`.
One cold launch drives three runs against REAL chat-stream-v2 daemons on an
owned scratch store:

  A  v1 daemon (no increment-1 fields): graceful list/map, no members, real
     `work_lanes.show` lane log.
  C  stop A, upgrade the SAME store offline with the increment-1 code (the
     daemon's own forward migration), start B on the same port; the running
     app reconnects through the unchanged loopback proxy (same app process
     PID, no reinstall; the daemon is a new process on the same store and
     port) and members appear.
  B  increment-1 daemon: list -> expand -> map (paged orbit) -> focus ->
     `+N` -> all 32 members via a real `work_lanes.show` -> member detail ->
     lane log (Updates / Spec changes / Events) -> back; missing, ambiguous,
     no-spec and index-unavailable cases on real data; large-text recheck.

Assertions read the native accessibility tree (idb) and the loopback proxy's
frame log (request/reply pairing by request_id); loopback probes read the
daemon directly. The optional `supplemental` command screenshots
screenshot-harness scenes from a SEPARATE build identity; it never stands in
for the proof above.

Nothing here contacts a production daemon, endpoint, store or credential.
Exit codes: 0 PASS, 1 FAIL, 4 SETUP_FAIL.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Callable
from urllib.parse import urlsplit
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scratch_daemon as sd  # noqa: E402
import v1_daemon as v1  # noqa: E402

SCENARIO = "lanes-release-contained"
PROOF_BUILD = "normal_release_loopback_counterpart"
SUPPLEMENTAL_BUILD = "screenshot_harness_release"
HERMES_MAGIC = bytes.fromhex("c61fbc03c103191f")
OWNER_MARKER = ".lanes-release-contained-owner"
LARGE_TEXT = "accessibility-extra-extra-extra-large"
MIN_TARGET_PT = 44
URL_RE = re.compile(rb"(?:wss?|https?)://[A-Za-z0-9._~%\-\[\]:]+(?:/[^\s\"'<>\\]*)?")
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "[::1]"}


class SetupFail(RuntimeError):
    """Precondition or owned-resource failure; never a product verdict."""


class AssertFail(AssertionError):
    """Product journey assertion failed."""


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Plan (pure; asserted by test_plan.py)
# ---------------------------------------------------------------------------

STEPS = [
    "admission", "seed_v1", "proxy_start", "daemon_a_start", "probe_a", "simulator_activate", "app_launch",
    "enroll", "open_lanes", "run_a_list", "run_a_map", "run_a_log",
    "daemon_a_stop", "transport_unavailable_probe", "seed_inc1_upgrade", "daemon_b_start", "probe_b",
    "run_c_reconnect", "spec_edit", "run_b_list", "run_b_precedence", "run_b_map_pages", "run_b_focus_overflow",
    "run_b_all_members", "run_b_member_detail", "run_b_log", "run_b_index_unavailable", "run_b_large_text",
    "run_b_final",
]
TEARDOWN = ["content_size_restore", "app_terminate", "app_uninstall", "ui-companion_stop", "daemon_stop",
            "proxy_stop", "simulator_shutdown", "simulator_delete", "evidence_hash", "scratch_remove"]


def plan() -> dict[str, Any]:
    return {"scenario": SCENARIO, "proof_build": PROOF_BUILD, "steps": STEPS, "teardown": TEARDOWN,
            "ports": {"daemon": sd.DAEMON_PORT, "proxy": sd.PROXY_PORT, "companion": sd.COMPANION_PORT,
                      "metro_must_be_closed": sd.METRO_PORT},
            "app_ws_url": sd.APP_WS_URL,
            "pins": {"v1": sd.PIN_V1, "inc1": sd.PIN_INC1},
            "v1_lane_ids": sd.v1_lane_ids(), "all_lane_ids": sd.all_lane_ids(), "big_lane_id": sd.big_lane_id(),
            "fixture_timing_delta": sd.FIXTURE_TIMING, "proxy_deltas": sd.PROXY_DELTAS}


# ---------------------------------------------------------------------------
# Compiled-configuration admission (pure where possible)
# ---------------------------------------------------------------------------

def operational_urls(production_public_config: dict[str, Any]) -> list[str]:
    """Operational endpoints of the production build: every URL under `extra`."""
    found: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and re.match(r"^(?:wss?|https?)://", value):
            found.append(value)

    walk(production_public_config.get("extra", {}))
    return sorted(set(found))


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def scan_compiled(bundle: bytes, app_config: dict[str, Any], production: list[str]) -> dict[str, Any]:
    """Loopback-only compiled config; every production operational URL/host absent."""
    problems: list[str] = []
    extra = app_config.get("extra", {}) if isinstance(app_config, dict) else {}
    if extra.get("wsUrl") != sd.APP_WS_URL:
        problems.append("embedded app.config extra.wsUrl is not the owned loopback endpoint")
    if sd.APP_WS_URL.encode() not in bundle:
        problems.append("JS bundle does not contain the owned loopback endpoint")
    config_urls = operational_urls(app_config)
    for url in config_urls:
        if url.startswith(("ws://", "wss://")) and _host(url) not in LOOPBACK_HOSTS:
            problems.append("embedded config carries a non-loopback socket endpoint")
    socket_urls = sorted({m.group(0).decode(errors="replace") for m in URL_RE.finditer(bundle)
                          if m.group(0).startswith((b"ws://", b"wss://"))})
    for url in socket_urls:
        if _host(url) not in LOOPBACK_HOSTS:
            problems.append("JS bundle carries a non-loopback socket endpoint")
    leaked = 0
    for url in production:
        host = _host(url)
        needles = {url.encode()} | ({host.encode()} if host and host not in LOOPBACK_HOSTS else set())
        config_text = json.dumps(app_config).encode()
        if any(needle in bundle or needle in config_text for needle in needles):
            leaked += 1
    if leaked:
        problems.append(f"{leaked} production operational endpoint(s) present in the compiled app")
    return {"problems": problems, "socket_url_count": len(socket_urls),
            "config_operational_urls": len(config_urls),
            "production_urls_checked": len(production),
            "production_url_sha256": [sha256_bytes(url.encode()) for url in production]}


def app_identity(app: Path) -> dict[str, Any]:
    info = plistlib.loads((app / "Info.plist").read_bytes())
    bundle = app / "main.jsbundle"
    config = app / "EXConstants.bundle" / "app.config"
    if not bundle.is_file() or not config.is_file():
        raise SetupFail("Release app lacks an embedded main.jsbundle or EXConstants app.config")
    executable = app / str(info.get("CFBundleExecutable", ""))
    data = bundle.read_bytes()
    return {"app": str(app), "bundle_id": info.get("CFBundleIdentifier"), "executable": executable.name,
            "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
            "hermes_bytecode": data[:8] == HERMES_MAGIC,
            "hashes": {"main.jsbundle": sha256_bytes(data), "EXConstants.bundle/app.config": sd.sha256_file(config),
                       "Info.plist": sd.sha256_file(app / "Info.plist"),
                       executable.name: sd.sha256_file(executable) if executable.is_file() else None}}


# ---------------------------------------------------------------------------
# Proxy frame log (request/reply pairing)
# ---------------------------------------------------------------------------

def read_wire(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def show_pairs(rows: list[dict[str, Any]], since: float) -> list[dict[str, Any]]:
    """Native `work_lanes.show` requests after `since`, each with its matching reply row."""
    requests = [r for r in rows if r.get("at", 0) >= since and r.get("direction") == "client_to_daemon"
                and r.get("type") == "work_lanes.show" and r.get("request_id")]
    pairs = []
    for request in requests:
        reply = next((r for r in rows if r.get("direction") == "daemon_to_client"
                      and r.get("request_id") == request["request_id"]
                      and r.get("type") in ("work_lanes.show.ok", "work_lanes.show.error")), None)
        pairs.append({"request_id": request["request_id"], "connection": request.get("connection"),
                      "request_bytes": request.get("bytes"), "reply_type": reply and reply.get("type"),
                      "reply_bytes": reply and reply.get("bytes"), "error_code": reply and reply.get("error_code")})
    return pairs


def connections_with_snapshot(rows: list[dict[str, Any]], since: float) -> list[int]:
    return sorted({r["connection"] for r in rows if r.get("at", 0) >= since
                   and r.get("direction") == "daemon_to_client" and r.get("type") == "snapshot"})


# ---------------------------------------------------------------------------
# Native UI (idb accessibility tree, owned companion)
# ---------------------------------------------------------------------------

class Ui:
    def __init__(self, udid: str, idb: str, trace: Callable[[str, Any], None], shots: Path):
        self.udid, self.idb, self.trace, self.shots = udid, idb, trace, shots
        self.env = {**os.environ, "IDB_COMPANION": f"{sd.HOST}:{sd.COMPANION_PORT}"}
        self.screenshots: list[dict[str, str]] = []

    def _idb(self, *args: str) -> subprocess.CompletedProcess:
        result = subprocess.run([self.idb, *args, "--udid", self.udid], capture_output=True, text=True,
                                timeout=30, check=False, env=self.env)
        self.trace("idb " + " ".join(args[:2]), {"rc": result.returncode, "stderr": result.stderr[-400:]})
        return result

    def elements(self) -> list[dict[str, Any]]:
        result = self._idb("ui", "describe-all", "--json")
        if result.returncode:
            raise SetupFail("native accessibility inspection failed")
        try:
            decoded = json.loads(result.stdout)
            items = decoded if isinstance(decoded, list) else decoded.get("elements", [])
        except (ValueError, AttributeError):
            items = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
        return [item for item in items if isinstance(item, dict)]

    @staticmethod
    def ident(element: dict[str, Any]) -> str:
        return str(element.get("AXIdentifier") or element.get("AXUniqueId") or "")

    @staticmethod
    def label(element: dict[str, Any]) -> str:
        return " ".join(str(element.get(key) or "") for key in ("AXLabel", "AXValue", "label", "value")).strip()

    @staticmethod
    def frame(element: dict[str, Any]) -> dict[str, float]:
        frame = element.get("frame") or {}
        if not all(isinstance(frame.get(key), (int, float)) for key in ("x", "y", "width", "height")):
            raise AssertFail("element has no usable frame: " + Ui.ident(element))
        return frame

    def ids(self, prefix: str = "") -> list[dict[str, Any]]:
        return [element for element in self.elements() if self.ident(element).startswith(prefix)]

    def find(self, identifier: str, timeout_s: float = 20, text: str | None = None) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            for element in self.elements():
                if self.ident(element) == identifier and (text is None or text.lower() in self.label(element).lower()):
                    return element
            if time.monotonic() >= deadline:
                raise AssertFail(f"missing {identifier}" + (f" with text {text!r}" if text else ""))
            time.sleep(0.3)

    def absent(self, prefix: str) -> None:
        present = [self.ident(element) for element in self.ids(prefix)]
        if present:
            raise AssertFail(f"unexpected elements {present[:4]} for prefix {prefix}")

    def tap(self, identifier: str, timeout_s: float = 20) -> dict[str, Any]:
        element = self.find(identifier, timeout_s)
        if element.get("AXEnabled") is False:
            raise AssertFail("disabled tap target: " + identifier)
        frame = self.frame(element)
        result = self._idb("ui", "tap", str(int(frame["x"] + frame["width"] / 2)), str(int(frame["y"] + frame["height"] / 2)))
        if result.returncode:
            raise SetupFail("native tap failed: " + identifier)
        time.sleep(0.4)
        return element

    def swipe_up(self, within: dict[str, float]) -> None:
        x = str(int(within["x"] + within["width"] / 2))
        top, bottom = within["y"] + within["height"] * 0.25, within["y"] + within["height"] * 0.8
        result = self._idb("ui", "swipe", x, str(int(bottom)), x, str(int(top)), "--duration", "0.4")
        if result.returncode:
            raise SetupFail("native swipe failed")
        time.sleep(0.5)

    def screen(self) -> dict[str, float]:
        """Screen bounds from the visible elements (container views are not accessibility elements)."""
        frames = [element["frame"] for element in self.elements() if isinstance(element.get("frame"), dict)
                  and all(isinstance(element["frame"].get(k), (int, float)) for k in ("x", "y", "width", "height"))]
        if not frames:
            raise SetupFail("no accessible elements on screen")
        return {"x": 0, "y": 0, "width": max(f["x"] + f["width"] for f in frames),
                "height": max(f["y"] + f["height"] for f in frames)}

    def find_label(self, text: str, timeout_s: float = 20) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            for element in self.elements():
                if text.lower() in self.label(element).lower():
                    return element
            if time.monotonic() >= deadline:
                raise AssertFail(f"no element labelled {text!r}")
            time.sleep(0.3)

    def collect_scrolling(self, prefix: str, limit: int, max_swipes: int = 12) -> list[str]:
        """First-appearance order of `prefix` ids while scrolling the current screen downward."""
        order: list[str] = []
        box = self.screen()
        for _ in range(max_swipes + 1):
            visible = sorted(self.ids(prefix), key=lambda e: self.frame(e)["y"])
            for element in visible:
                identifier = self.ident(element)
                if identifier not in order:
                    order.append(identifier)
            if len(order) >= limit:
                break
            self.swipe_up(box)
        return order

    def screenshot(self, name: str) -> str:
        path = self.shots / f"{len(self.screenshots):02d}-{name}.png"
        result = subprocess.run(["xcrun", "simctl", "io", self.udid, "screenshot", str(path)],
                                capture_output=True, text=True, timeout=30, check=False)
        if result.returncode or not path.is_file():
            raise SetupFail("simulator screenshot failed: " + name)
        digest = sd.sha256_file(path)
        self.screenshots.append({"name": path.name, "sha256": digest})
        return digest


def assert_target(element: dict[str, Any], screen: dict[str, float] | None = None) -> None:
    frame = Ui.frame(element)
    if frame["width"] < MIN_TARGET_PT or frame["height"] < MIN_TARGET_PT:
        raise AssertFail(f"{Ui.ident(element)} target {frame['width']}x{frame['height']} below {MIN_TARGET_PT}pt")
    if screen and (frame["x"] < 0 or frame["y"] < 0 or frame["x"] + frame["width"] > screen["width"] + 1
                   or frame["y"] + frame["height"] > screen["height"] + 1):
        raise AssertFail(f"{Ui.ident(element)} is outside the screen")


def overlapping(elements: list[dict[str, Any]]) -> list[tuple[str, str]]:
    boxes = [(Ui.ident(e), Ui.frame(e)) for e in elements]
    hits = []
    for index, (left_id, a) in enumerate(boxes):
        for right_id, b in boxes[index + 1:]:
            if (a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"]
                    and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]):
                hits.append((left_id, right_id))
    return hits


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

class Run:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.run_id = args.run_id or ("lanes-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                                      + "-" + uuid.uuid4().hex[:6])
        self.run_dir: Path = args.run_dir.resolve() / self.run_id
        self.evidence = self.run_dir / "evidence"
        self.shots = self.evidence / "screenshots"
        self.scratch = self.run_dir / "scratch"
        self.python = str(args.python)
        self.v1_checkout, self.inc1_checkout = args.v1_checkout.resolve(), args.inc1_checkout.resolve()
        self.result: dict[str, Any] = {"scenario": SCENARIO, "run_id": self.run_id, "started_at": now_iso(),
                                       "evidence_class": "simulator_contained_real_daemon",
                                       "proof_build": PROOF_BUILD,
                                       "certifies_not": ["production signed device artifact", "production endpoint",
                                                         "physical installation"],
                                       "steps": [], "checks": {}, "supplemental_real_checks": {}}
        self.processes: dict[str, dict[str, Any]] = {}
        self.udid: str | None = None
        self.app_pid: str | None = None
        self.content_size: str | None = None
        self.ui: Ui | None = None
        self.trace_file = None
        self.journey_started = False

    # -- bookkeeping -------------------------------------------------------
    def trace(self, action: str, data: Any) -> None:
        if self.trace_file:
            self.trace_file.write(json.dumps({"at": time.time(), "action": action, "data": data}) + "\n")
            self.trace_file.flush()

    def step(self, name: str, fn: Callable[[], Any]) -> Any:
        started = time.time()
        record = {"step": name, "started_at": started}
        self.result["steps"].append(record)
        try:
            value = fn()
            record.update(status="ok", seconds=round(time.time() - started, 2))
            return value
        except Exception as exc:
            record.update(status="error", seconds=round(time.time() - started, 2), error=str(exc)[:500])
            if self.ui and self.udid:
                try:
                    self.ui.screenshot("failure-" + name)
                except Exception:
                    pass
            raise

    def sh(self, argv: list[str], *, timeout: float = 60, check: bool = True, env: dict[str, str] | None = None,
           cwd: Path | None = None) -> subprocess.CompletedProcess:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False, env=env, cwd=cwd)
        self.trace("exec " + " ".join(Path(argv[0]).name if i == 0 else a for i, a in enumerate(argv[:4])),
                   {"rc": result.returncode, "stderr": result.stderr[-400:]})
        if check and result.returncode:
            raise SetupFail(f"command failed: {Path(argv[0]).name} {' '.join(argv[1:3])}: {result.stderr[-300:]}")
        return result

    def simctl(self, *args: str, timeout: float = 120, check: bool = True) -> subprocess.CompletedProcess:
        return self.sh(["xcrun", "simctl", *args], timeout=timeout, check=check)

    def write(self, name: str, payload: Any) -> None:
        (self.evidence / name).write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")

    def wire(self) -> list[dict[str, Any]]:
        return read_wire(self.run_dir / "proxy" / "throttle-wire.jsonl")

    # -- admission ---------------------------------------------------------
    def admission(self) -> None:
        receipt: dict[str, Any] = {"at": now_iso()}
        for tool in ("xcrun", "git", self.args.idb, self.args.idb_companion):
            if not shutil.which(tool):
                raise SetupFail(f"required tool unavailable: {tool}")
        for port in (sd.DAEMON_PORT, sd.PROXY_PORT, sd.COMPANION_PORT):
            if not sd.port_free(port):
                raise SetupFail(f"port {port} is not free")
        if sd.port_listening(sd.METRO_PORT):
            raise SetupFail("a Metro server is listening; the Release proof requires Metro unavailable")
        receipt["ports_free"] = [sd.DAEMON_PORT, sd.PROXY_PORT, sd.COMPANION_PORT]
        receipt["metro_listening"] = False
        receipt["v1_checkout"] = sd.verify_checkout(self.v1_checkout, sd.PIN_V1)
        receipt["inc1_checkout"] = sd.verify_checkout(self.inc1_checkout, sd.PIN_INC1)
        if receipt["v1_checkout"]["tree"] != sd.PIN_V1_TREE or receipt["inc1_checkout"]["tree"] != sd.INC1_TREE:
            raise SetupFail("daemon checkout tree differs from the pinned tree")
        if receipt["inc1_checkout"]["fixture_sha256"] != sd.FIXTURE_SHA256:
            raise SetupFail("increment-1 checkout fixture is not the shared fixture")
        receipt["v1_source_facts"] = v1.source_facts(self.v1_checkout)
        receipt["python"] = self.sh([self.python, "-c", "import sys, websockets; print(sys.version.split()[0], websockets.__version__)"]).stdout.strip()
        freeze = self.sh([self.python, "-m", "pip", "freeze", "--all"], check=False).stdout
        (self.evidence / "python-freeze.txt").write_text(freeze, encoding="utf-8")
        receipt["python_freeze_sha256"] = sha256_bytes(freeze.encode())
        import_home = self.run_dir / "import-check-home"
        import_home.mkdir(mode=0o700)
        for name, checkout in (("v1", self.v1_checkout), ("inc1", self.inc1_checkout)):
            paths = os.pathsep.join(str(checkout / p) for p in ("services", "services/chat-stream-v2", "services/chat-stream-v2/tools"))
            self.sh([self.python, "-c", "import store, server, assistant_composite, mobile_enrollment_cli, work_lanes_projection"],
                    env={"PATH": os.environ.get("PATH", ""), "PYTHONPATH": paths, "MIC_API": "",
                         "HOME": str(import_home), "PENTACLE_MEMORY_ROOT": str(import_home / "memory"),
                         "PYTHONDONTWRITEBYTECODE": "1"}, cwd=checkout)
            receipt[f"{name}_imports"] = "ok"
        app = self.args.app.resolve()
        identity = app_identity(app)
        if identity["bundle_id"] != self.args.bundle_id:
            raise SetupFail("proof app bundle identifier differs from --bundle-id")
        if not identity["hermes_bytecode"]:
            raise SetupFail("embedded main.jsbundle is not Hermes bytecode")
        production = operational_urls(json.loads(self.args.production_config.read_text(encoding="utf-8")))
        if not production:
            raise SetupFail("production public config yielded no operational URLs to reject")
        scan = scan_compiled((app / "main.jsbundle").read_bytes(),
                             json.loads((app / "EXConstants.bundle" / "app.config").read_text(encoding="utf-8")),
                             production)
        if scan["problems"]:
            raise SetupFail("compiled configuration admission failed: " + "; ".join(scan["problems"]))
        signature = self.sh(["codesign", "--verify", "--deep", "--strict", str(app)], check=False)
        receipt["codesign_verify_rc"] = signature.returncode
        if signature.returncode:
            raise SetupFail("proof app signature does not verify")
        receipt["proof_app"] = {**identity, "build_identity": PROOF_BUILD, "compiled_scan": scan}
        self.result["proof_app"] = receipt["proof_app"]
        self.write("admission.json", receipt)

    # -- daemon side -------------------------------------------------------
    def seed(self, pin: str, checkout: Path) -> dict[str, Any]:
        env = sd.child_env(self.scratch)
        out = self.sh([self.python, str(Path(__file__).resolve().parent / "scratch_daemon.py"), "seed",
                       "--checkout", str(checkout), "--scratch", str(self.scratch), "--pin", pin],
                      env=env, cwd=checkout, timeout=120)
        seeded = json.loads(out.stdout.strip().splitlines()[-1])
        expected = sd.v1_lane_ids() if pin == "v1" else sd.all_lane_ids()
        if sorted(seeded["open_lane_ids"]) != sorted(expected):
            raise SetupFail(f"{pin} seed produced unexpected open lanes")
        self.write(f"seed-{pin}.json", seeded)
        return seeded

    def seed_v1(self) -> None:
        layout = sd.make_scratch(self.scratch)
        (self.scratch / OWNER_MARKER).write_text(self.run_id, encoding="utf-8")
        self.write("memory-tree.json", sd.write_memory(layout["memory"]))
        self.seed("v1", self.v1_checkout)

    def start_proxy(self) -> None:
        proxy = sd.copy_proxy(self.args.proxy_source.resolve(), self.run_dir)
        self.processes["proxy"] = sd.start_owned("proxy", [self.python, str(proxy)], env=sd.child_env(self.scratch),
                                                 cwd=proxy.parent, log=self.evidence / "proxy.log", port=sd.PROXY_PORT)
        self.result["proxy"] = {"sha256": sd.PROXY_SHA256, "deltas": sd.PROXY_DELTAS}

    def start_daemon(self, label: str, checkout: Path) -> None:
        env = sd.child_env(self.scratch)
        self.result.setdefault("daemon_child_env", {key: ("" if key == "MIC_API" else value)
                                                    for key, value in env.items() if key != "PATH"})
        self.processes["daemon"] = sd.start_owned(label, sd.daemon_argv(self.python, checkout, self.scratch),
                                                  env=env, cwd=checkout, log=self.evidence / f"{label}.log",
                                                  port=sd.DAEMON_PORT, ready_timeout_s=90)
        self.result.setdefault("daemons", []).append(sd.public_receipt(self.processes["daemon"]))

    def stop_daemon(self) -> None:
        receipt = self.processes.pop("daemon")
        self.result.setdefault("stops", []).append(sd.stop_owned(receipt))

    def probe_a(self) -> None:
        got = sd.probe(sd.DAEMON_PORT, sd.big_lane_id())
        problems = v1.check_v1_inventory(got["inventory"], sd.v1_lane_ids()) + v1.check_v1_show(got["show"], sd.big_lane_id())
        self.result["checks"]["probe_a"] = {"inventory": sd.summarize_frame(got["inventory"]),
                                            "show": sd.summarize_frame(got["show"]), "problems": problems}
        if problems:
            raise SetupFail("run A daemon is not serving the v1 wire: " + "; ".join(problems))
        self.inventory_order = [lane["lane_id"] for lane in got["inventory"]["lanes"]]

    def probe_b(self) -> None:
        last: dict[str, Any] = {}

        def ready() -> bool:
            got = sd.probe(sd.DAEMON_PORT, sd.big_lane_id())
            problems = v1.check_inc1_inventory(got["inventory"], sd.all_lane_ids(), sd.big_lane_id())
            problems += v1.check_inc1_show(got["show"], sd.big_lane_id(), sd.BIG)
            lanes = {lane["lane_id"]: lane for lane in got["inventory"].get("lanes", [])} if got["inventory"] else {}
            statuses = {m.get("spec_id"): m.get("status") for lane in lanes.values() for m in lane.get("members") or []}
            if statuses.get(sd.MISSING) != "missing" or statuses.get(sd.AMBIGUOUS) != "ambiguous":
                problems.append("missing/ambiguous members not yet settled")
            last.update(got=got, problems=problems)
            return not problems

        try:
            sd.wait_for(ready, 120, "increment-1 projection settled", interval=3)
        except TimeoutError:
            raise SetupFail("run B daemon did not settle: " + "; ".join(last.get("problems", []))) from None
        got = last["got"]
        self.result["checks"]["probe_b"] = {"inventory": sd.summarize_frame(got["inventory"]),
                                            "show": sd.summarize_frame(got["show"])}
        self.inventory_order = [lane["lane_id"] for lane in got["inventory"]["lanes"]]

    # -- simulator side ----------------------------------------------------
    def activate_simulator(self) -> None:
        name = f"{SCENARIO}-{self.run_id}"
        self.udid = self.simctl("create", name, self.args.device_type, self.args.runtime).stdout.strip()
        if not re.fullmatch(r"[0-9A-Fa-f-]{36}", self.udid or ""):
            raise SetupFail("simulator create returned no UDID")
        self.result["simulator"] = {"udid": self.udid, "name": name, "device_type": self.args.device_type,
                                    "runtime": self.args.runtime, "fresh_state": True}
        self.simctl("boot", self.udid)
        self.simctl("bootstatus", self.udid, "-b", timeout=300)
        self.content_size = self.simctl("ui", self.udid, "content_size", check=False).stdout.strip() or "large"
        self.simctl("install", self.udid, str(self.args.app.resolve()), timeout=300)
        installed = Path(self.simctl("get_app_container", self.udid, self.args.bundle_id, "app").stdout.strip())
        expected = self.result["proof_app"]["hashes"]
        for name, digest in expected.items():
            if digest and sd.sha256_file(installed / name) != digest:
                raise SetupFail("installed app differs from the admitted app: " + name)
        self.result["simulator"]["installed_app"] = str(installed)
        self.processes["ui-companion"] = sd.start_owned(
            "ui-companion", [shutil.which(self.args.idb_companion) or self.args.idb_companion, "--udid", self.udid,
                             "--grpc-port", str(sd.COMPANION_PORT)],
            env={key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ},
            cwd=self.run_dir, log=self.evidence / "ui-companion.log", port=sd.COMPANION_PORT)
        self.ui = Ui(self.udid, self.args.idb, self.trace, self.shots)

    def app_pids(self) -> list[str]:
        listed = self.simctl("spawn", self.udid, "launchctl", "list", check=False)
        found = []
        for line in listed.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0].isdigit() and re.search(
                    r"(?:^|:)" + re.escape(self.args.bundle_id) + r"(?:\[|$)", parts[-1]):
                found.append(parts[0])
        return sorted(set(found))

    def launch(self) -> None:
        if self.app_pids():
            raise SetupFail("app already running on the fresh simulator")
        if sd.port_listening(sd.METRO_PORT):
            raise SetupFail("Metro became available before launch")
        out = self.simctl("launch", self.udid, self.args.bundle_id).stdout.strip()
        match = re.fullmatch(re.escape(self.args.bundle_id) + r":\s*(\d+)", out)
        if not match:
            raise SetupFail("launch did not report a PID")
        self.app_pid = match[1]
        time.sleep(2)
        if self.app_pids() != [self.app_pid]:
            raise SetupFail("launched PID is not the only running app process")
        self.result["app_launch"] = {"pid": self.app_pid, "at": now_iso(), "metro_listening": False,
                                     "bundle": "embedded Hermes main.jsbundle"}

    def enroll(self) -> None:
        since = time.time()
        out = self.sh([self.python, str(Path(__file__).resolve().parent / "scratch_daemon.py"), "enroll-link",
                       "--checkout", str(self.v1_checkout), "--scratch", str(self.scratch)],
                      env=sd.child_env(self.scratch), cwd=self.v1_checkout)
        url = json.loads(out.stdout.strip().splitlines()[-1])["url"]
        opened = subprocess.run(["xcrun", "simctl", "openurl", self.udid, url], capture_output=True, text=True,
                                timeout=60, check=False)
        self.trace("openurl enrollment", {"rc": opened.returncode})  # the link (one-time code) is never retained
        del url
        if opened.returncode:
            raise SetupFail("enrollment deep link did not open")
        try:
            sd.wait_for(lambda: bool(connections_with_snapshot(self.wire(), since)), 60, "enrolled snapshot")
        except TimeoutError:
            raise SetupFail("enrolled app did not receive a daemon snapshot through the loopback proxy") from None
        self.result["enrollment"] = {"mechanism": "normal enrollment deep link, fresh simulator, owned scratch registry",
                                     "endpoint": sd.APP_WS_URL, "code_retained": False}

    def open_lanes(self) -> None:
        opened = subprocess.run(["xcrun", "simctl", "openurl", self.udid, "pentacle://pentacle/lanes"],
                                capture_output=True, text=True, timeout=60, check=False)
        if opened.returncode:
            raise SetupFail("lanes route deep link did not open")
        self.ui.find("lanes-view-list", 30)
        self.ui.find("lanes-view-map")
        self.show_view("list")

    # -- journey -----------------------------------------------------------
    # The overlay's `lanes-view-list` / `lanes-view-map` are the two toggle buttons
    # (selected state); container views carry no accessibility element, so the
    # current view is read from what it renders: list = card progress labels,
    # map orbit = the centre assistant node (`lanes-map-assistant`).
    def show_view(self, view: str) -> None:
        self.ui.tap(f"lanes-view-{view}")
        if view == "map":
            deadline = time.monotonic() + 20
            while not (self.ui.ids("lanes-map-assistant") or self.ui.ids("lanes-map-back")):
                if time.monotonic() > deadline:
                    raise AssertFail("map view did not render")
                time.sleep(0.3)
        else:
            deadline = time.monotonic() + 20
            while not self.ui.ids("lane-card-progress-"):
                if time.monotonic() > deadline:
                    raise AssertFail("list view did not render")
                time.sleep(0.3)

    def focus_lane(self, lane: str) -> None:
        """Tap a lane node on the paged orbit, paging forward in daemon order until it is visible."""
        for _ in range(4):
            if self.ui.ids(f"lanes-map-lane-{lane}"):
                self.ui.tap(f"lanes-map-lane-{lane}")
                self.ui.find("lanes-map-back")
                return
            self.ui.tap("lanes-map-page-next")
        raise AssertFail("lane node not reachable on the paged orbit: " + lane)

    def page_position(self) -> tuple[int, int]:
        """(page, page_count) from the pager label ("Page 1 of 2" accessibility label, "1/2" text)."""
        match = re.search(r"(\d+)\s*(?:/|of)\s*(\d+)", Ui.label(self.ui.find("lanes-map-page-label")))
        if not match:
            raise AssertFail("map pager label is not 'page of count'")
        return int(match[1]), int(match[2])

    def unfocus_to_page_one(self) -> None:
        self.ui.tap("lanes-map-back")
        self.ui.find("lanes-map-assistant")
        for _ in range(4):
            if self.page_position()[0] == 1:
                return
            self.ui.tap("lanes-map-page-prev")
        raise AssertFail("could not return the orbit to page 1")

    def visible_order(self, prefix: str) -> list[str]:
        cards = sorted((e for e in self.ui.ids(prefix) if re.fullmatch(re.escape(prefix) + r"wl-[0-9a-f]{24}", Ui.ident(e))),
                       key=lambda e: Ui.frame(e)["y"])
        return [Ui.ident(e)[len(prefix):] for e in cards]

    def assert_prefix_order(self, visible: list[str], label: str) -> None:
        expected = [lane for lane in self.inventory_order if lane in visible]
        if visible != expected or not visible or visible[0] != self.inventory_order[0]:
            raise AssertFail(f"{label}: rendered order {visible} is not the daemon order")

    def show_after(self, since: float, timeout_s: float = 35) -> dict[str, Any]:
        holder: dict[str, Any] = {}

        def done() -> bool:
            pairs = [p for p in show_pairs(self.wire(), since) if p["reply_type"]]
            if pairs:
                holder["pair"] = pairs[-1]
            return bool(pairs)

        try:
            sd.wait_for(done, timeout_s, "native work_lanes.show reply")
        except TimeoutError:
            raise AssertFail("no native work_lanes.show request/reply pair on the loopback proxy") from None
        return holder["pair"]

    def log_tabs(self, lane_id: str, tag: str, need_spec_change: bool) -> dict[str, Any]:
        rows: dict[str, Any] = {}
        for tab in ("updates", "spec-changes", "events"):
            self.ui.tap(f"lane-log-tab-{tab}")
            deadline = time.monotonic() + 15
            while True:
                count = len([e for e in self.ui.ids("lane-log-row-") if re.fullmatch(r"lane-log-row-\d+", Ui.ident(e))])
                empty = bool(self.ui.ids("lane-log-empty"))
                if count or empty or time.monotonic() > deadline:
                    break
                time.sleep(0.5)
            if not count and not empty:
                raise AssertFail(f"log tab {tab} rendered neither rows nor an empty state")
            if self.ui.ids("lane-log-retry"):
                raise AssertFail(f"log tab {tab} shows an error on a live daemon")
            rows[tab] = count
            self.ui.screenshot(f"{tag}-log-{tab}")
        if rows["events"] < 1:
            raise AssertFail("Events tab has no rows for a seeded lane")
        if need_spec_change and rows["spec-changes"] < 1:
            raise AssertFail("Spec changes tab has no item_change row after the daemon's sweep")
        return rows

    def run_a_list(self) -> None:
        ui = self.ui
        visible = self.visible_order("lane-card-progress-")
        self.assert_prefix_order(visible, "run A list")
        for lane in visible:
            ui.find(f"lane-card-members-pending-{lane}", 5)
        ui.absent(f"lane-card-member-{sd.big_lane_id()}-")
        ui.screenshot("a-list")
        self.result["checks"]["run_a_list"] = {"visible_lanes": visible}

    def run_a_map(self) -> None:
        ui = self.ui
        self.show_view("map")
        visible = self.visible_order("lanes-map-lane-")
        if sorted(visible) != sorted(sd.v1_lane_ids()):
            raise AssertFail("run A map does not show exactly the v1 lanes")
        ui.absent("lanes-map-member-")
        ui.find("lanes-map-members-pending")
        ui.screenshot("a-map")
        self.focus_lane(sd.big_lane_id())
        ui.find(f"lanes-map-members-pending-{sd.big_lane_id()}")
        ui.absent("lanes-map-member-")
        ui.absent("lanes-map-more-")
        ui.screenshot("a-map-focus")
        self.unfocus_to_page_one()
        self.show_view("list")
        self.result["checks"]["run_a_map"] = {"lanes": visible, "member_nodes": 0}

    def run_a_log(self) -> None:
        since = time.time()
        self.ui.tap(f"lane-card-log-{sd.big_lane_id()}")
        self.ui.find("lane-log-tab-updates")
        pair = self.show_after(since)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("run A lane log show did not succeed on the v1 daemon")
        rows = self.log_tabs(sd.big_lane_id(), "a", need_spec_change=False)
        self.ui.tap("lane-log-back")
        self.ui.find(f"lane-card-log-{sd.big_lane_id()}")
        self.result["checks"]["run_a_log"] = {"show": pair, "rows": rows}

    def transport_unavailable_probe(self) -> None:
        """Supplemental real state: lane log requested while no daemon listens (not a daemon error)."""
        since = time.time()
        record: dict[str, Any] = {"label": "transport_unavailable_real", "blocking": False,
                                  "expected": "log waits for the connection and sends no request"}
        try:
            self.ui.tap(f"lane-card-log-{sd.big_lane_id()}", 10)
            self.ui.find_label("Waiting for connection", 10)
            record["observed"] = True
            record["requests_sent"] = len(show_pairs(self.wire(), since))
            self.ui.screenshot("c-transport-unavailable")
            self.ui.tap("lane-log-back", 10)
        except (AssertFail, SetupFail) as exc:
            record.update(observed=False, note=str(exc)[:200])
        self.result["supplemental_real_checks"]["transport_unavailable_real"] = record

    def run_c_reconnect(self) -> None:
        since = self.processes["daemon"]["started_at"]
        try:
            sd.wait_for(lambda: bool(connections_with_snapshot(self.wire(), since)), 90, "reconnect snapshot")
        except TimeoutError:
            raise AssertFail("app did not reconnect to the upgraded daemon through the unchanged proxy") from None
        if self.app_pids() != [self.app_pid]:
            raise AssertFail("app process changed across the upgrade (restart or reinstall)")
        ui = self.ui
        if ui.ids("lane-log-back"):
            ui.tap("lane-log-back")
        self.show_view("list")
        deadline = time.monotonic() + 60
        while ui.ids("lane-card-members-pending-"):
            if time.monotonic() > deadline:
                raise AssertFail("v1 pending notes remain after the increment-1 inventory arrived")
            time.sleep(1)
        ui.screenshot("c-reconnected-list")
        self.result["checks"]["run_c_reconnect"] = {"app_pid_unchanged": self.app_pid,
                                                    "daemon_b_pid": self.processes["daemon"]["pid"],
                                                    "connections": connections_with_snapshot(self.wire(), since)}

    def spec_edit(self) -> None:
        sd.tick_edited_spec(self.scratch / "memory")

        def changed() -> bool:
            got = sd.probe(sd.DAEMON_PORT, sd.big_lane_id())
            return any(e.get("operation") == "item_change" for e in (got["show"] or {}).get("events", []))

        try:
            sd.wait_for(changed, 90, "daemon item_change after spec edit", interval=3)
        except TimeoutError:
            raise SetupFail("daemon sweep did not record an item_change for the edited spec") from None
        self.result["checks"]["spec_edit"] = {"spec_id": sd.EDITED, "item_change": True,
                                              "timing": "fixture timing delta " + json.dumps(sd.FIXTURE_TIMING)}

    def run_b_list(self) -> None:
        ui, big = self.ui, sd.big_lane_id()
        visible = self.visible_order("lane-card-progress-")
        self.assert_prefix_order(visible, "run B list")
        ui.tap(f"lane-card-toggle-{big}")
        for spec in sd.BIG[:8]:
            ui.find(f"lane-card-member-{big}-{spec}", 10)
        ui.find(f"lane-card-show-all-{big}")
        ui.find(f"lane-card-progress-{big}")
        ui.screenshot("b-list-expanded")
        ui.tap(f"lane-card-toggle-{big}")
        self.result["checks"]["run_b_list"] = {"visible_lanes": visible, "expanded_members": 8}

    def run_b_precedence(self) -> None:
        ui, out = self.ui, {}
        cases = {"missing": sd.lane_id_for(sd.LANES[1]["key"]), "ambiguous": sd.lane_id_for(sd.LANES[2]["key"]),
                 "no_spec": sd.lane_id_for(sd.LANES[4]["key"])}
        for name, lane in cases.items():
            element = self.find_card_progress(lane)
            text = Ui.label(element).lower()
            if re.search(r"\bdone\b", text):
                raise AssertFail(f"{name} lane shows terminal done wording")
            if name in ("missing", "ambiguous") and "unresolved" not in text:
                raise AssertFail(f"{name} lane progress does not read unresolved")
            if name == "no_spec" and "planning conversation" not in text:
                raise AssertFail("no-spec lane does not show its reason")
            out[name] = {"lane_id": lane, "label_sha256": sha256_bytes(text.encode())}
        ui.screenshot("b-precedence")
        self.result["checks"]["run_b_precedence"] = out

    def find_card_progress(self, lane: str) -> dict[str, Any]:
        identifier = f"lane-card-progress-{lane}"
        box = self.ui.screen()
        for _ in range(8):
            hits = [e for e in self.ui.ids(identifier) if Ui.ident(e) == identifier]
            if hits:
                return hits[0]
            self.ui.swipe_up(box)
        raise AssertFail("card progress not reachable: " + lane)

    def map_pages(self) -> list[list[str]]:
        ui = self.ui
        self.show_view("map")
        pages = [self.visible_order("lanes-map-lane-")]
        page, count = self.page_position()
        if page != 1 or count < 2:
            raise AssertFail("map pager is not page 1 of N>1 with more than 8 lanes")
        for _ in range(count - 1):
            ui.tap("lanes-map-page-next")
            pages.append(self.visible_order("lanes-map-lane-"))
        ui.screenshot("b-map-last-page")
        for _ in range(count - 1):
            ui.tap("lanes-map-page-prev")
        return pages

    def run_b_map_pages(self) -> None:
        pages = self.map_pages()
        flat = [lane for page in pages for lane in page]
        if flat != self.inventory_order or len(flat) != 9:
            raise AssertFail(f"paged orbit does not reach all 9 lanes in daemon order: {pages}")
        for page in pages:
            if len(page) > 8:
                raise AssertFail("an orbit page renders more than 8 lane nodes")
        overlaps = overlapping(self.ui.ids("lanes-map-lane-"))
        if overlaps:
            raise AssertFail(f"overlapping lane targets {overlaps[:2]}")
        self.ui.screenshot("b-map-page-1")
        self.result["checks"]["run_b_map_pages"] = {"pages": pages}

    def run_b_focus_overflow(self) -> None:
        ui, big = self.ui, sd.big_lane_id()
        self.focus_lane(big)
        nodes = [e for e in ui.ids("lanes-map-member-")]
        ids = [Ui.ident(e)[len("lanes-map-member-"):] for e in nodes]
        if sorted(ids) != sorted(sd.BIG[:8]):
            raise AssertFail(f"focused orbit renders {len(ids)} member nodes, not the first 8 in membership order")
        more = ui.find(f"lanes-map-more-{big}")
        digits = re.findall(r"\d+", Ui.label(more))
        if "Show all" not in Ui.label(more) or "32" not in digits:
            raise AssertFail("+N node lacks its accessible 'Show all N specs' label")
        for element in nodes + [more]:
            assert_target(element)
        overlaps = overlapping(nodes + [more])
        if overlaps:
            raise AssertFail(f"overlapping member targets {overlaps[:2]}")
        ui.screenshot("b-map-focus-overflow")
        self.result["checks"]["run_b_focus_overflow"] = {"member_nodes": len(nodes), "more_label_numbers": digits}

    def run_b_all_members(self) -> None:
        ui, big = self.ui, sd.big_lane_id()
        since = time.time()
        ui.tap(f"lanes-map-more-{big}")
        ui.find("lane-members-back", 30)
        pair = self.show_after(since)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("all-member list show did not succeed")
        order = ui.collect_scrolling("lane-members-row-", 32)
        got = [identifier[len("lane-members-row-"):] for identifier in order]
        if got != sd.BIG:
            raise AssertFail(f"all-member list shows {len(got)} rows, not all 32 in membership order")
        ui.screenshot("b-all-members")
        self.result["checks"]["run_b_all_members"] = {"show": pair, "rows": len(got),
                                                      "spec_ids_sha256": sha256_bytes("\n".join(got).encode())}

    def run_b_member_detail(self) -> None:
        ui, big, spec = self.ui, sd.big_lane_id(), sd.BIG[-1]
        ui.tap(f"lane-members-row-{spec}")
        ui.find("member-detail-back")
        identified = bool(ui.ids(f"member-detail-{spec}"))  # container id; exposed only if made accessible
        ui.screenshot("b-member-detail")
        ui.tap("member-detail-back")
        ui.find(f"lane-members-row-{spec}")
        ui.tap("lane-members-back")
        ui.find(f"lanes-map-more-{big}")
        self.result["checks"]["run_b_member_detail"] = {"spec_id": spec, "detail_id_visible": identified}

    def run_b_log(self) -> None:
        ui, big = self.ui, sd.big_lane_id()
        since = time.time()
        ui.tap(f"lanes-map-log-{big}")
        ui.find("lane-log-tab-updates")
        pair = self.show_after(since)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("lane log show did not succeed on the increment-1 daemon")
        rows = self.log_tabs(big, "b", need_spec_change=True)
        ui.tap("lane-log-back")
        self.unfocus_to_page_one()
        self.show_view("list")
        self.result["checks"]["run_b_log"] = {"show": pair, "rows": rows}

    def run_b_index_unavailable(self) -> None:
        memory = self.scratch / "memory"
        sd.hide_memory_root(memory)
        try:
            sd.wait_for(lambda: (sd.probe(sd.DAEMON_PORT)["inventory"] or {}).get("work_index", {}).get("available") is False,
                        90, "work_index unavailable", interval=3)
            self.ui.find("lanes-index-banner", 60)
            self.ui.screenshot("b-index-unavailable")
        finally:
            sd.restore_memory_root(memory)
        sd.wait_for(lambda: (sd.probe(sd.DAEMON_PORT)["inventory"] or {}).get("work_index", {}).get("available") is True,
                    90, "work_index restored", interval=3)
        deadline = time.monotonic() + 60
        while self.ui.ids("lanes-index-banner"):
            if time.monotonic() > deadline:
                raise AssertFail("index banner persists after the work root returned")
            time.sleep(1)
        self.result["checks"]["run_b_index_unavailable"] = {"banner": True, "restored": True}

    def run_b_large_text(self) -> None:
        ui, big = self.ui, sd.big_lane_id()
        self.simctl("ui", self.udid, "content_size", LARGE_TEXT)
        time.sleep(2)
        try:
            self.show_view("map")
            screen = ui.screen()
            assert_target(ui.find("lanes-map-page-next"), screen)
            self.focus_lane(big)
            more = ui.find(f"lanes-map-more-{big}")
            if Ui.frame(more)["y"] + Ui.frame(more)["height"] > screen["height"]:
                ui.swipe_up(screen)  # the focused map scrolls; the +N action must be reachable, then usable
                more = ui.find(f"lanes-map-more-{big}")
            assert_target(more, screen)
            overlaps = overlapping(ui.ids("lanes-map-member-") + [more])
            if overlaps:
                raise AssertFail(f"overlapping targets at large text {overlaps[:2]}")
            ui.screenshot("b-large-text-focus")
            self.unfocus_to_page_one()
            self.show_view("list")
        finally:
            self.simctl("ui", self.udid, "content_size", self.content_size or "large", check=False)
        self.result["checks"]["run_b_large_text"] = {"content_size": LARGE_TEXT}

    def run_b_final(self) -> None:
        self.ui.find("lane-card-progress-" + sd.big_lane_id())
        self.ui.screenshot("b-final-list")
        if self.app_pids() != [self.app_pid]:
            raise AssertFail("app process did not survive the journey")
        crash_dir = Path.home() / "Library" / "Logs" / "DiagnosticReports"
        started = datetime.datetime.fromisoformat(self.result["started_at"]).timestamp()
        crashes = [p.name for p in crash_dir.glob("*.ips") if p.stat().st_mtime >= started
                   and p.name.startswith(self.result["proof_app"]["executable"] + "-")] if crash_dir.is_dir() else []
        if crashes:
            raise AssertFail(f"crash reports during the run: {crashes}")

    # -- orchestration -----------------------------------------------------
    def execute(self) -> int:
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.evidence.mkdir()
        self.shots.mkdir()
        self.trace_file = (self.evidence / "trace.jsonl").open("w", encoding="utf-8")
        verdict, error = "SETUP_FAIL", None
        try:
            for name, fn in [
                ("admission", self.admission), ("seed_v1", self.seed_v1), ("proxy_start", self.start_proxy),
                ("daemon_a_start", lambda: self.start_daemon("daemon-a-v1", self.v1_checkout)),
                ("probe_a", self.probe_a), ("simulator_activate", self.activate_simulator),
                ("app_launch", self.launch), ("enroll", self.enroll), ("open_lanes", self.open_lanes),
            ]:
                self.step(name, fn)
            self.journey_started = True
            for name, fn in [
                ("run_a_list", self.run_a_list), ("run_a_map", self.run_a_map), ("run_a_log", self.run_a_log),
                ("daemon_a_stop", self.stop_daemon), ("transport_unavailable_probe", self.transport_unavailable_probe),
                ("seed_inc1_upgrade", lambda: self.seed("inc1", self.inc1_checkout)),
                ("daemon_b_start", lambda: self.start_daemon("daemon-b-inc1", self.inc1_checkout)),
                ("probe_b", self.probe_b), ("run_c_reconnect", self.run_c_reconnect), ("spec_edit", self.spec_edit),
                ("run_b_list", self.run_b_list), ("run_b_precedence", self.run_b_precedence),
                ("run_b_map_pages", self.run_b_map_pages), ("run_b_focus_overflow", self.run_b_focus_overflow),
                ("run_b_all_members", self.run_b_all_members), ("run_b_member_detail", self.run_b_member_detail),
                ("run_b_log", self.run_b_log), ("run_b_index_unavailable", self.run_b_index_unavailable),
                ("run_b_large_text", self.run_b_large_text), ("run_b_final", self.run_b_final),
            ]:
                self.step(name, fn)
            verdict = "PASS"
        except AssertFail as exc:
            verdict, error = "FAIL", str(exc)
        except Exception as exc:  # SetupFail, timeouts, tool failures
            verdict, error = "SETUP_FAIL", f"{type(exc).__name__}: {exc}"
        finally:
            teardown = self.teardown()
            if teardown["failures"]:
                if verdict == "PASS":
                    error = "teardown incomplete"
                self.result["primary_verdict"] = verdict
                verdict = "SETUP_FAIL"
        self.result.update(verdict=verdict, error=error, finished_at=now_iso(),
                           screenshots=self.ui.screenshots if self.ui else [])
        self.write("result.json", self.result)
        (self.evidence / "screenshots.sha256").write_text(
            "".join(f"{s['sha256']}  {s['name']}\n" for s in (self.ui.screenshots if self.ui else [])), encoding="utf-8")
        print(json.dumps({"scenario": SCENARIO, "verdict": verdict, "result": str(self.evidence / "result.json")}))
        return {"PASS": 0, "FAIL": 1}.get(verdict, 4)

    def teardown(self) -> dict[str, Any]:
        record: dict[str, Any] = {"at": now_iso(), "actions": [], "failures": []}

        def attempt(name: str, fn: Callable[[], Any]) -> None:
            try:
                value = fn()
                record["actions"].append({"action": name, "ok": True, **({"detail": value} if value else {})})
            except Exception as exc:
                record["actions"].append({"action": name, "ok": False, "error": str(exc)[:300]})
                record["failures"].append(name)

        if self.udid:
            attempt("content_size_restore", lambda: self.simctl("ui", self.udid, "content_size",
                                                                self.content_size or "large", check=False) and None)
            if self.app_pid:
                def terminate():
                    if self.app_pids():
                        self.simctl("terminate", self.udid, self.args.bundle_id, check=False)
                        sd.wait_for(lambda: not self.app_pids(), 10, "app exit")
                    return {"pid": self.app_pid, "absent": not self.app_pids()}
                attempt("app_terminate", terminate)
            attempt("app_uninstall", lambda: self.simctl("uninstall", self.udid, self.args.bundle_id, check=False) and None)
        for label in ("ui-companion", "daemon", "proxy"):
            if label in self.processes:
                receipt = self.processes.pop(label)
                attempt(f"{label}_stop", lambda receipt=receipt: sd.stop_owned(receipt))
        if self.udid:
            attempt("simulator_shutdown", lambda: self.simctl("shutdown", self.udid, check=False) and None)
            def delete():
                state = self.simctl("list", "devices", "-j", check=False).stdout
                owned = any(d.get("udid") == self.udid and d.get("name") == f"{SCENARIO}-{self.run_id}"
                            for devices in json.loads(state or "{}").get("devices", {}).values() for d in devices)
                if not owned:
                    raise RuntimeError("simulator identity not verified; not deleting")
                self.simctl("delete", self.udid)
            attempt("simulator_delete", delete)
        if self.trace_file:
            self.trace_file.close()
            self.trace_file = None
        attempt("evidence_hash", self.hash_evidence)
        attempt("scratch_remove", self.remove_scratch)
        for port in (sd.DAEMON_PORT, sd.PROXY_PORT, sd.COMPANION_PORT):
            if sd.port_listening(port):
                record["failures"].append(f"port {port} still listening")
        self.result["teardown"] = record
        (self.evidence / "teardown.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        return record

    def hash_evidence(self) -> dict[str, Any]:
        proxy_dir = self.run_dir / "proxy"
        for name in ("throttle-wire.jsonl", "throttle-process.json"):
            if (proxy_dir / name).is_file():
                shutil.copyfile(proxy_dir / name, self.evidence / name)
        scratch_hashes = {}
        if self.scratch.is_dir():
            sd.assert_scratch_paths(self.scratch)
            for path in sorted(self.scratch.rglob("*")):
                if path.is_file() and path.name != OWNER_MARKER:
                    scratch_hashes[str(path.relative_to(self.scratch))] = sd.sha256_file(path)
        self.result["scratch_file_sha256"] = scratch_hashes
        return {"scratch_files": len(scratch_hashes)}

    def remove_scratch(self) -> dict[str, Any] | None:
        if not self.scratch.is_dir():
            return None
        marker = self.scratch / OWNER_MARKER
        if not marker.is_file() or marker.read_text(encoding="utf-8") != self.run_id:
            raise RuntimeError("scratch ownership marker missing or foreign; not removing")
        if self.processes:
            raise RuntimeError("owned processes still recorded; not removing scratch")
        shutil.rmtree(self.scratch)
        return {"removed": str(self.scratch)}


# ---------------------------------------------------------------------------
# Supplemental: screenshot-harness scenes (separate build identity)
# ---------------------------------------------------------------------------

SUPPLEMENTAL_SCENES = {
    "lanes:v1_wire": {"expect": ["lanes-view-list"], "prefix_present": "lane-card-members-pending-"},
    "lanes:inc1_cases": {"expect": ["lanes-view-list", "lanes-index-banner"], "prefix_present": "lane-card-progress-"},
    "lanes:overflow": {"expect": ["lanes-view-list"], "prefix_present": "lane-card-progress-"},
}


def supplemental(args: argparse.Namespace) -> int:
    """Install one screenshot-harness build (scene baked by EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT),
    capture its lanes overlay and the offline lane-log state. Labelled harness-rendered."""
    scene = SUPPLEMENTAL_SCENES[args.scene]
    out = args.run_dir.resolve() / ("supplemental-" + args.scene.replace(":", "-") + "-" + uuid.uuid4().hex[:6])
    out.mkdir(parents=True)
    record: dict[str, Any] = {"label": "harness_rendered_state", "build_identity": SUPPLEMENTAL_BUILD,
                              "scene": args.scene, "not_proof_of": "real daemon request/reply"}
    udid = None
    try:
        identity = app_identity(args.app.resolve())
        record["app"] = identity
        udid = subprocess.run(["xcrun", "simctl", "create", f"{SCENARIO}-supplemental-{out.name}", args.device_type,
                               args.runtime], capture_output=True, text=True, check=True, timeout=120).stdout.strip()
        for argv in (["boot", udid], ["bootstatus", udid, "-b"], ["install", udid, str(args.app.resolve())],
                     ["launch", udid, identity["bundle_id"]]):
            subprocess.run(["xcrun", "simctl", *argv], capture_output=True, text=True, check=True, timeout=300)
        companion = sd.start_owned("ui-companion", [args.idb_companion, "--udid", udid, "--grpc-port", str(sd.COMPANION_PORT)],
                                   env={k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG") if k in os.environ},
                                   cwd=out, log=out / "ui-companion.log", port=sd.COMPANION_PORT)
        try:
            ui = Ui(udid, args.idb, lambda *_: None, out)
            subprocess.run(["xcrun", "simctl", "openurl", udid, "pentacle://pentacle/lanes"], check=True, timeout=60)
            for identifier in scene["expect"]:
                ui.find(identifier, 30)
            if not ui.ids(scene["prefix_present"]):
                raise AssertFail("scene lacks " + scene["prefix_present"])
            ui.screenshot("scene")
            first = sorted((e for e in ui.ids("lane-card-log-")), key=lambda e: Ui.frame(e)["y"])
            if first:
                ui.tap(Ui.ident(first[0]))
                ui.find_label("Waiting for connection", 20)
                ui.screenshot("offline-log-waiting")
                record["offline_log_state"] = "waiting for connection (harness offline; no request sent)"
            record.update(verdict="PASS", screenshots=ui.screenshots)
        finally:
            sd.stop_owned(companion)
    except Exception as exc:
        record.update(verdict="FAIL" if isinstance(exc, AssertFail) else "SETUP_FAIL", error=str(exc)[:300])
    finally:
        if udid:
            for argv in (["shutdown", udid], ["delete", udid]):
                subprocess.run(["xcrun", "simctl", *argv], capture_output=True, text=True, check=False, timeout=120)
    (out / "supplemental.json").write_text(json.dumps(record, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"scenario": SCENARIO + ":supplemental", "verdict": record["verdict"], "result": str(out)}))
    return {"PASS": 0, "FAIL": 1}.get(record["verdict"], 4)


def parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="print the run plan as JSON; performs no action")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--run-dir", type=Path, required=True)
    common.add_argument("--device-type", required=True)
    common.add_argument("--runtime", required=True)
    common.add_argument("--idb", default="idb")
    common.add_argument("--idb-companion", default="idb_companion")
    proof = sub.add_parser("run", parents=[common], help="the contained A/C/B proof")
    proof.add_argument("--app", type=Path, required=True, help="normal Release simulator .app (loopback config)")
    proof.add_argument("--bundle-id", required=True)
    proof.add_argument("--production-config", type=Path, required=True,
                       help="`expo config --type public --json` of the production build (URLs to reject)")
    proof.add_argument("--v1-checkout", type=Path, required=True)
    proof.add_argument("--inc1-checkout", type=Path, required=True)
    proof.add_argument("--python", type=Path, required=True, help="owned venv python for both daemon pins")
    proof.add_argument("--proxy-source", type=Path, required=True, help="retained loopback proxy script")
    proof.add_argument("--run-id")
    extra = sub.add_parser("supplemental", parents=[common], help="one screenshot-harness scene (separate build)")
    extra.add_argument("--app", type=Path, required=True)
    extra.add_argument("--scene", choices=sorted(SUPPLEMENTAL_SCENES), required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse(argv)
    if args.command == "plan":
        print(json.dumps(plan(), indent=2))
        return 0
    if args.command == "supplemental":
        return supplemental(args)
    return Run(args).execute()


if __name__ == "__main__":
    raise SystemExit(main())
