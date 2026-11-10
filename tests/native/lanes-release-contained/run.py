#!/usr/bin/env python3
"""`lanes-release-contained`: contained native proof of the work lanes overlay.

Proof subject: the NORMAL Release simulator build (no harness flags) whose
compiled configuration points only at numeric loopback `ws://127.0.0.1:17896`.
One cold launch drives three runs against REAL chat-stream-v2 daemons on an
owned scratch store:

  A  v1 daemon (no increment-1 fields): home map and grouped list, real
     `work_lanes.show` lane detail.
  C  stop A, upgrade the SAME store offline with the increment-1 code (the
     daemon's own forward migration), start B on the same port; the running
     app reconnects through the unchanged loopback proxy (same app process
     PID, no reinstall; the daemon is a new process on the same store and
     port) and members appear.
  B  increment-1 daemon: lane -> default goal -> 30 non-deprecated members
     via a real `work_lanes.show` -> spec -> back, map, index-unavailable,
     large-text and grouped overflow checks. The pin predates pagination;
     the separate loopback scene checks a 65-member paged response and an
     owned synthetic question.

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
from urllib.parse import urlencode, urlsplit
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
COMPANION_PATH = "/opt/homebrew/Cellar/idb-companion-modern/2026.07.23.4917dcf/libexec/idb_companion"
COMPANION_SHA256 = "6b3d0189d4f4bfc40934e655454a36fe5b57d2de4480178a4686f5c1884b60c8"
CFU_DOMAIN = "com.apple.generativeexperiences.corefollowup"
CFU_KEY = "DateOfLastAppleIntelligenceReadinessCFU"


class _FlowDone(Exception):
    """A smoke/reduced flow completed every one of its steps."""


class SetupFail(RuntimeError):
    """Precondition or owned-resource failure; never a product verdict."""


class AccessibilityInspectionFail(SetupFail):
    def __init__(self, stderr: str):
        self.transient_translation = "No translation object returned for simulator" in stderr
        super().__init__("native accessibility inspection failed")


class SystemUIInterception(SetupFail):
    """A foreground mismatch is a harness failure, never a product verdict."""
    def __init__(self, foreground: str | None):
        self.classification = "HARNESS_ERROR"
        self.foreground = foreground or "unavailable"
        self.timestamp_utc = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        self.video_timestamp = "unavailable"
        super().__init__("system UI interception: " + self.foreground)


# Ported from test/e2e/scenarios/_m1_native_ui.py at public merge 05c194d0.
def foreground_bundle(elements: list[dict[str, Any]], launchctl: str) -> str | None:
    roots = [e for e in elements if e.get("role") == "AXApplication"]
    if len(roots) != 1 or not isinstance(roots[0].get("pid"), int):
        return None
    pid = str(roots[0]["pid"])
    matches = []
    for line in launchctl.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[0] != pid:
            continue
        match = re.fullmatch(r"UIKitApplication:([^\[]+)\[.+", fields[-1])
        if match:
            matches.append(match.group(1))
    return matches[0] if len(matches) == 1 else None


class AssertFail(AssertionError):
    """Product journey assertion failed."""


def verified_companion(path: str) -> str:
    if path != COMPANION_PATH:
        raise SetupFail("companion path differs from the verified libexec pin")
    try:
        digest = sd.sha256_file(Path(path))
    except OSError as exc:
        raise SetupFail("companion executable unavailable") from exc
    if digest != COMPANION_SHA256:
        raise SetupFail("companion executable hash differs from the pin")
    return path


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
    "run_c_reconnect", "run_b_list", "run_b_all_members", "run_b_member_detail",
    "run_b_map_pages", "run_b_focus_overflow", "run_b_index_unavailable", "run_b_large_text", "run_b_final",
    "overflow_phase_boundary", "overflow_add_lanes", "overflow_assert",
]
# Reduced proof (production path only): the release app enrolls to an increment-1 daemon on a fresh scratch.
SMOKE_STEPS = ["admission", "seed_inc1", "proxy_start", "daemon_b_start", "probe_b",
               "simulator_activate", "app_launch", "enroll", "home_enrolled"]
REDUCED_STEPS = SMOKE_STEPS + ["open_lanes", "reduced_list", "reduced_members", "reduced_map"]
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



def validate_overflow_list(observed: list[str], expected: list[str]) -> list[str]:
    if len(observed) != len(set(observed)) or set(observed) != set(expected):
        raise AssertFail("overflow destination does not expose every seeded lane exactly once")
    return observed

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
    """Loopback-only compiled config (every operational URL under extra); every production operational URL/host absent."""
    problems: list[str] = []
    extra = app_config.get("extra", {}) if isinstance(app_config, dict) else {}
    if extra.get("wsUrl") != sd.APP_WS_URL:
        problems.append("embedded app.config extra.wsUrl is not the owned loopback endpoint")
    if sd.APP_WS_URL.encode() not in bundle:
        problems.append("JS bundle does not contain the owned loopback endpoint")
    config_urls = operational_urls(app_config)
    for url in config_urls:
        if _host(url) not in LOOPBACK_HOSTS:
            problems.append("embedded config carries a non-loopback operational endpoint")
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


def scrub_wire_codes(path: Path) -> dict[str, int]:
    """Enrollment codes are credentials: replace any logged `code` value in the wire log, in place."""
    if not path.is_file():
        return {"rows_redacted": 0, "remaining": 0}
    lines, redacted = [], 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            row = None
        if isinstance(row, dict) and row.get("code") not in (None, "<redacted>"):
            row["code"] = "<redacted>"
            line, redacted = json.dumps(row), redacted + 1
        lines.append(line)
    if redacted:
        path.write_text("".join(item + "\n" for item in lines), encoding="utf-8")
    remaining = sum(1 for row in read_wire(path) if row.get("code") not in (None, "<redacted>"))
    return {"rows_redacted": redacted, "remaining": remaining}


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

# iOS system alerts the run may meet, matched exactly: title -> the one button to press. Anything else stops the run.
SYSTEM_ALERTS = {
    "Open in “Pentacle”?": "Open",
    "“Pentacle” Would Like to Send You Notifications": "Don’t Allow",
}


def _norm(text: Any) -> str:
    return " ".join(str(text or "").replace("“", '"').replace("”", '"').replace("’", "'").split())


def known_system_alert(elements: list[dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
    """(title, button to press) for an allow-listed alert on screen; a known title without its exact button fails."""
    labels = {_norm(element.get("AXLabel")) for element in elements}
    for title, button in SYSTEM_ALERTS.items():
        if _norm(title) not in labels:
            continue
        matches = [element for element in elements if _norm(element.get("AXLabel")) == _norm(button)
                   and str(element.get("type") or element.get("role") or "") == "Button"]
        if len(matches) != 1:
            raise SetupFail(f"system alert {title!r} without exactly one {button!r} button")
        return title, matches[0]
    return None


# A tap target's centre must lie this far inside the screen (status bar / home indicator), else it is scrolled to.
REVEAL_TOP, REVEAL_BOTTOM = 8, 60

# The assistant tab's session screen before it is usable (`app/pentacle/session/[streamId].tsx`).
LOCK_TEXTS = ("Unlocking Pentacle…", "Pentacle access is unavailable on this device.")
# Hydrated with a credential but no session under the app's fixed assistant stream id: the scratch daemon's
# assistant composite is `local:web-gate-assistant` (pinned wrapper), so the header and its lanes button are
# not rendered.
NO_ASSISTANT_TEXT = "Returning to chats..."


def home_state(elements: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Enrolled and unlocked home: the assistant tab bar, no lock text, and the hydrated session screen."""
    labels = {_norm(element.get("AXLabel")) for element in elements}
    if not any(str(element.get("type") or "") == "Button" and str(element.get("AXLabel") or "").startswith("ASSISTANT, tab, ")
               for element in elements):
        return None
    if any(_norm(text) in labels for text in LOCK_TEXTS):
        return None
    button = lanes_status_button(elements)
    if button is not None:
        return {"header": "present", "lanes_button": button.get("AXLabel")}
    if _norm(NO_ASSISTANT_TEXT) in labels:
        return {"header": "absent: no assistant session under the app's stream id (fixture composite local:web-gate-assistant)"}
    return None


# The grouped list exposes each lane as an accessible row button.
LIST_CARD = "lane-row-"
# Daemon order can move between reads (state, then updated_at desc, then id), so each order check reads the
# inventory immediately before and after the screen; a disagreement or a lagging screen uses one attempt.
ORDER_ATTEMPTS = 3


def lane_group(lane: dict[str, Any]) -> str:
    if lane.get("state") == "paused":
        return "paused"
    counts = lane.get("goal_counts")
    if lane.get("goal_classes") and isinstance(counts, list) and len(counts) == 4:
        return "moving" if counts[0] else "stalled" if counts[1] else "idle"
    goals = list(lane.get("goals") or [])
    if lane.get("default_goal"):
        goals.append(lane["default_goal"])
    return "moving" if any(g.get("total", 0) > 0 and g.get("state") == "in_progress" for g in goals) else "idle"


def grouped_lane_ids(lanes: list[dict[str, Any]]) -> list[str]:
    return [lane["lane_id"] for group in ("moving", "stalled", "idle", "paused")
            for lane in lanes if lane_group(lane) == group]


def expected_map_lanes(lanes: list[dict[str, Any]]) -> tuple[set[str], int]:
    paused = sorted((lane for lane in lanes if lane.get("state") == "paused"),
                    key=lambda lane: lane.get("state_at") or "", reverse=True)
    visible = [lane["lane_id"] for lane in lanes if lane.get("state") != "paused"]
    visible.extend(lane["lane_id"] for lane in paused[:6])
    return set(visible), max(0, len(paused) - 6)


def assert_map_labels(ui: "Ui", expected: set[str], folded: int, titles: dict[str, str] | None = None) -> None:
    labels = ui.ids("lanes-map-label-")
    actual = {Ui.ident(e).removeprefix("lanes-map-label-") for e in labels}
    wanted = expected | ({"paused-more"} if folded else set())
    if len(labels) != len(actual) or actual != wanted:
        raise AssertFail("map labels do not match visible lanes and paused fold")
    if titles is not None:
        for element in labels:
            ident = Ui.ident(element).removeprefix("lanes-map-label-")
            expected_title = f"+{folded}" if ident == "paused-more" else titles.get(ident, "")
            if not expected_title or not Ui.label(element).startswith(expected_title):
                raise AssertFail("map label lacks its expected visible lane title: " + ident)
    overlaps = overlapping(labels)
    if overlaps:
        raise AssertFail(f"overlapping map labels {overlaps[:2]}")


def lane_ids(lanes: list[dict[str, Any]]) -> list[str]:
    return [lane["lane_id"] for lane in lanes]


def lanes_status_button(elements: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The assistant header status button (`<name> status, N open lanes…`), which opens the lanes view in-app."""
    for element in elements:
        if str(element.get("type") or "") == "Button" and re.search(r"\bstatus, \d+ open lanes", str(element.get("AXLabel") or "")):
            return element
    return None


class Ui:
    def __init__(self, udid: str, idb: str, trace: Callable[[str, Any], None], shots: Path,
                 bundle: str | None = None):
        self.udid, self.idb, self.trace, self.shots, self.bundle = udid, idb, trace, shots, bundle
        self.env = {**os.environ, "IDB_COMPANION": f"{sd.HOST}:{sd.COMPANION_PORT}"}
        self.screenshots: list[dict[str, str]] = []
        self.viewport: dict[str, float] | None = None

    def _idb(self, *args: str) -> subprocess.CompletedProcess:
        result = subprocess.run([self.idb, *args, "--udid", self.udid], capture_output=True, text=True,
                                timeout=30, check=False, env=self.env)
        self.trace("idb " + " ".join(args[:2]), {"rc": result.returncode, "stderr": result.stderr[-400:]})
        return result

    def elements(self) -> list[dict[str, Any]]:
        result = self._idb("ui", "describe-all", "--json")
        if result.returncode:
            raise AccessibilityInspectionFail(result.stderr)
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

    def read_foreground(self) -> str | None:
        try:
            elements = self.elements()
            result = subprocess.run(["xcrun", "simctl", "spawn", self.udid, "launchctl", "list"],
                                    capture_output=True, text=True, timeout=20, check=False)
            foreground = foreground_bundle(elements, result.stdout) if result.returncode == 0 else None
            roots = [e.get("pid") for e in elements if e.get("role") == "AXApplication"]
            self.trace("foreground_readback", {"at_utc": now_iso(), "ax_root_pids": roots,
                                                 "launchctl_rc": result.returncode,
                                                 "bundle": foreground or "unavailable"})
            return foreground
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError, subprocess.TimeoutExpired):
            return None

    def check_foreground(self) -> None:
        foreground = self.read_foreground()
        self.trace("foreground_check", {"at_utc": now_iso(), "expected_bundle": self.bundle,
                                         "foreground": foreground or "unavailable",
                                         "matched": bool(self.bundle and foreground == self.bundle)})
        if not self.bundle or foreground != self.bundle:
            raise SystemUIInterception(foreground)

    def tap(self, identifier: str, timeout_s: float = 20) -> dict[str, Any]:
        self.check_foreground()
        element = self.find(identifier, timeout_s)
        if element.get("AXEnabled") is False:
            raise AssertFail("disabled tap target: " + identifier)
        element = self.ensure_hit(self.reveal(element))
        frame = self.frame(element)
        self.check_foreground()
        result = self._idb("ui", "tap", str(int(frame["x"] + frame["width"] / 2)), str(int(frame["y"] + frame["height"] / 2)))
        if result.returncode:
            raise SetupFail("native tap failed: " + identifier)
        time.sleep(0.4)
        self.check_foreground()
        return element

    def tap_element(self, element: dict[str, Any], what: str, *, system_dialog: bool = False,
                    alert: str | None = None) -> None:
        if not system_dialog:
            self.check_foreground()
        element = self.reveal(element)
        if not system_dialog:
            element = self.ensure_hit(element)
        frame = self.frame(element)
        if not system_dialog:
            self.check_foreground()
        result = self._idb("ui", "tap", str(int(frame["x"] + frame["width"] / 2)), str(int(frame["y"] + frame["height"] / 2)))
        if result.returncode:
            raise SetupFail("native tap failed: " + what)
        time.sleep(0.4)
        if system_dialog:
            # A different allow-listed alert may follow (Open, then notifications): the caller's loop presses it and
            # checks the app's return when the chain ends. Anything else, including the same alert, is checked now.
            chained = known_system_alert(self.elements())
            if chained is not None and chained[0] != alert:
                self.trace("system_alert_chained", {"pressed": alert, "next": chained[0]})
                return
        self.check_foreground()

    def reveal(self, element: dict[str, Any], max_drags: int = 10) -> dict[str, Any]:
        """Scroll an off-screen tap target into view: drag within the screen, re-find it by its id, repeat. idb taps
        screen points, and the tree lists off-screen scroll content, so tapping such a frame lands on whatever sits
        at the screen edge. A target that does not move when dragged (not in a scroll view) or has no id to re-find
        is a setup failure, never a blind tap."""
        identifier = self.ident(element)
        self.frame(element)  # a target without a usable frame fails as before, without inspecting the screen
        view = self.screen() if self.viewport is None else self.viewport
        self.viewport = view
        for _ in range(max_drags + 1):
            frame = self.frame(element)
            centre = frame["y"] + frame["height"] / 2
            if view["y"] + REVEAL_TOP <= centre <= view["y"] + view["height"] - REVEAL_BOTTOM:
                return element
            if not identifier:
                raise SetupFail("off-screen tap target has no id to scroll to: " + self.label(element)[:60])
            middle = view["y"] + view["height"] / 2
            step = max(-0.4 * view["height"], min(0.4 * view["height"], centre - middle))
            x = str(int(view["x"] + view["width"] / 2))
            result = self._idb("ui", "swipe", x, str(int(middle + step / 2)), x, str(int(middle - step / 2)),
                               "--duration", "1.0")
            if result.returncode:
                raise SetupFail("native swipe failed")
            time.sleep(0.6)
            moved = next((e for e in self.elements() if self.ident(e) == identifier), None)
            if moved is None:
                raise SetupFail("tap target disappeared while scrolling: " + identifier)
            if abs(self.frame(moved)["y"] - frame["y"]) < 1:
                raise SetupFail("off-screen tap target does not scroll into view: " + identifier)
            element = moved
        raise SetupFail("tap target not on screen after scrolling: " + identifier)

    def hit(self, x: float, y: float) -> dict[str, Any] | None:
        """The element iOS hit-tests at a screen point (`idb ui describe-point`); None when it cannot be read."""
        result = self._idb("ui", "describe-point", "--json", str(int(x)), str(int(y)))
        if result.returncode:
            return None
        try:
            item = json.loads(result.stdout)
        except ValueError:
            return None
        if isinstance(item, list):
            item = item[0] if len(item) == 1 else None
        return item if isinstance(item, dict) else None

    def ensure_hit(self, element: dict[str, Any], max_drags: int = 6) -> dict[str, Any]:
        """A tap goes to a screen point. reveal() keeps the frame on screen, but a nested scroll container (the map's
        member sheet) can clip it while the tree still lists it there. Tap only when iOS hit-tests the target's own
        id at its centre; otherwise drag its scroll content from a hit-testable sibling until it does, or fail."""
        identifier = self.ident(element)
        for attempt in range(max_drags + 1):
            frame = self.frame(element)
            x, y = frame["x"] + frame["width"] / 2, frame["y"] + frame["height"] / 2
            hit = self.hit(x, y)
            self.trace("hit_test", {"target": identifier, "x": int(x), "y": int(y),
                                    "hit": self.ident(hit) if hit is not None else None})
            if hit is not None and identifier and self.ident(hit) == identifier:
                return element
            if hit is None or not identifier or attempt == max_drags:
                break
            anchor = self.scroll_anchor(element)
            if anchor is None:
                break
            box, view = self.frame(anchor), self.viewport or self.screen()
            ay = box["y"] + box["height"] / 2
            step = max(-0.4 * view["height"], min(0.4 * view["height"], ay - y))
            ax = str(int(box["x"] + box["width"] / 2))
            if self._idb("ui", "swipe", ax, str(int(ay)), ax, str(int(ay + step)), "--duration", "1.0").returncode:
                raise SetupFail("native swipe failed")
            time.sleep(0.6)
            moved = next((e for e in self.elements() if self.ident(e) == identifier), None)
            if moved is None:
                raise SetupFail("tap target disappeared while scrolling: " + identifier)
            if abs(self.frame(moved)["y"] - (y - frame["height"] / 2)) < 1:
                break
            element = moved
        raise SetupFail("tap target is not hit-testable at its centre (clipped or covered): " + (identifier or "?"))

    def scroll_anchor(self, element: dict[str, Any]) -> dict[str, Any] | None:
        """The nearest hit-testable sibling of the same id family (same scroll content) to drag from."""
        identifier = self.ident(element)
        match = re.fullmatch(r"(.*-)(?:wl-[0-9a-f]{24}|[^-]+)", identifier)
        if not match:
            return None
        y = self.frame(element)["y"]
        siblings = sorted((e for e in self.elements() if self.ident(e).startswith(match.group(1))
                           and self.ident(e) != identifier), key=lambda e: abs(self.frame(e)["y"] - y))
        for sibling in siblings[:4]:
            box = self.frame(sibling)
            hit = self.hit(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            if hit is not None and self.ident(hit) == self.ident(sibling):
                return sibling
        return None

    def dump(self, name: str, elements: list[dict[str, Any]] | None = None) -> Path:
        """Accessibility dump kept as evidence (screen labels only; no credential is ever on screen)."""
        folder = self.shots.parent / "ax"
        folder.mkdir(exist_ok=True)
        path = folder / f"{len(list(folder.iterdir())):02d}-{name}.json"
        path.write_text(json.dumps(elements if elements is not None else self.elements(), indent=1), encoding="utf-8")
        return path

    def clear_system_alerts(self, limit: int = 3) -> list[str]:
        """Press the allow-listed button of each known system alert on screen, dumping the screen first."""
        handled: list[str] = []
        for _ in range(limit):
            for attempt in range(3):
                try:
                    elements = self.elements()
                    break
                except AccessibilityInspectionFail as exc:
                    if not exc.transient_translation or attempt == 2:
                        raise
                    self.trace("alert_ax_retry", {"at_utc": now_iso(), "attempt": attempt + 1})
                    time.sleep(1)
            try:
                found = known_system_alert(elements)
            except SetupFail:
                self.dump("system-alert-unmatched", elements)
                raise
            if found is None:
                if handled:
                    self.check_foreground()  # every chain ends with the app back in front
                return handled
            title, button = found
            self.dump("system-alert", elements)
            # A system alert is not the app under test: an untappable target is a setup failure, never a product FAIL.
            if button.get("AXEnabled") is False:
                raise SetupFail(f"system alert {title!r}: {SYSTEM_ALERTS[title]!r} button is disabled")
            try:
                self.tap_element(button, SYSTEM_ALERTS[title], system_dialog=True, alert=title)
            except AssertFail as error:
                raise SetupFail(f"system alert {title!r}: {error}") from error
            self.trace("system alert", {"title": title, "pressed": SYSTEM_ALERTS[title]})
            handled.append(title)
            time.sleep(1.0)
        self.check_foreground()
        raise SetupFail("system alerts kept appearing: " + ", ".join(handled))

    def swipe_up(self, within: dict[str, float]) -> None:
        x = str(int(within["x"] + within["width"] / 2))
        top, bottom = within["y"] + within["height"] * 0.25, within["y"] + within["height"] * 0.8
        result = self._idb("ui", "swipe", x, str(int(bottom)), x, str(int(top)), "--duration", "0.4")
        if result.returncode:
            raise SetupFail("native swipe failed")
        time.sleep(0.5)

    def screen(self) -> dict[str, float]:
        """The visible screen: the Application element's frame. The tree also lists off-screen scroll content, so
        element frames alone overstate it; they are only the fallback when no Application element is reported."""
        elements = self.elements()
        for element in elements:
            if str(element.get("type") or "") == "Application":
                frame = element.get("frame") or {}
                if all(isinstance(frame.get(k), (int, float)) for k in ("x", "y", "width", "height")) and frame["height"] > 0:
                    return {k: frame[k] for k in ("x", "y", "width", "height")}
        frames = [element["frame"] for element in elements if isinstance(element.get("frame"), dict)
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

def orbit_order(nodes: list[dict[str, Any]], hub: dict[str, float]) -> list[dict[str, Any]]:
    """Order the unfocused rings by the shipped LanesMap geometry.

    LanesMap.tsx:585-610 places up to six nodes on the inner ellipse and the
    remainder on an outer ellipse, each clockwise from the top.
    """
    import math
    if len(nodes) > 16:
        raise AssertFail("unfocused map exposes more than 16 lane nodes")
    cx = hub["x"] + hub["width"] / 2
    cy = hub["y"] + hub["height"] / 2
    def offset(node):
        frame = Ui.frame(node)
        return (frame["x"] + frame["width"] / 2 - cx,
                frame["y"] + frame["height"] / 2 - cy)
    by_radius = sorted(nodes, key=lambda node: sum(x*x for x in offset(node)))
    def clockwise(node, rx, ry):
        dx, dy = offset(node)
        return (math.atan2(dy / ry, dx / rx) + math.pi / 2 + 0.02) % (2 * math.pi)
    if len(nodes) <= 6:
        return sorted(nodes, key=lambda node: clockwise(node, 132, 132))
    inner, outer = by_radius[:6], by_radius[6:]
    return (sorted(inner, key=lambda node: clockwise(node, 100, 140)) +
            sorted(outer, key=lambda node: clockwise(node, 182, 240)))


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
        self.stop_failed = False  # any failed owned stop preserves the scratch for recovery
        self.probe_auth: dict[str, Any] | None = None  # operator credential for loopback probes (never logged)
        self.enroll_checkout = self.v1_checkout  # the reduced proof enrolls against the increment-1 daemon
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
                for capture in (self.ui.screenshot, self.ui.dump):  # screen and accessibility tree, every failure
                    try:
                        capture("failure-" + name)
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
        expected = (sd.v1_lane_ids() if pin == "v1" else sd.all_lane_ids() +
                    (sd.overflow_lane_ids() if pin == "overflow" else []))
        if sorted(seeded["open_lane_ids"]) != sorted(expected):
            raise SetupFail(f"{pin} seed produced unexpected open lanes")
        self.write(f"seed-{pin}.json", seeded)
        return seeded

    def seed_v1(self) -> None:
        layout = sd.make_scratch(self.scratch)
        (self.scratch / OWNER_MARKER).write_text(self.run_id, encoding="utf-8")
        self.write("memory-tree.json", sd.write_memory(layout["memory"]))
        self.seed("v1", self.v1_checkout)

    def seed_inc1(self) -> None:
        """Reduced proof: a fresh scratch seeded directly at the increment-1 pin (no v1 store, no upgrade)."""
        layout = sd.make_scratch(self.scratch)
        (self.scratch / OWNER_MARKER).write_text(self.run_id, encoding="utf-8")
        self.write("memory-tree.json", sd.write_memory(layout["memory"]))
        self.seed("inc1", self.inc1_checkout)
        self.enroll_checkout = self.inc1_checkout

    def start_proxy(self) -> None:
        proxy = sd.copy_proxy(self.args.proxy_source.resolve(), self.run_dir)
        self.processes["proxy"] = sd.start_owned("proxy", [self.python, str(proxy)], env=sd.child_env(self.scratch),
                                                 cwd=proxy.parent, log=self.evidence / "proxy.log", port=sd.PROXY_PORT)
        self.result["proxy"] = {"sha256": sd.PROXY_SHA256, "deltas": sd.PROXY_DELTAS}

    def start_daemon(self, label: str, checkout: Path) -> None:
        env = sd.child_env(self.scratch)
        if not sd.operator_token_path(self.scratch).is_file():
            # work_lanes.show needs operator authority; the pinned wrapper issues the scratch credential.
            self.sh(sd.issue_argv(self.python, checkout, self.scratch), env=env, cwd=checkout, timeout=60)
            if not sd.operator_token_path(self.scratch).is_file():
                raise SetupFail("pinned wrapper did not issue the scratch operator credential")
        self.probe_auth = sd.load_probe_auth(checkout, self.scratch)
        self.result.setdefault("daemon_child_env", {key: ("" if key == "MIC_API" else value)
                                                    for key, value in env.items() if key != "PATH"})
        self.processes["daemon"] = sd.start_owned(label, sd.daemon_argv(self.python, checkout, self.scratch),
                                                  env=env, cwd=checkout, log=self.evidence / f"{label}.log",
                                                  port=sd.DAEMON_PORT, ready_timeout_s=90)
        self.result.setdefault("daemons", []).append(sd.public_receipt(self.processes["daemon"]))

    def stop_owned(self, label: str) -> dict[str, Any]:
        """Stop one owned process; its receipt is dropped only after the stop is verified."""
        try:
            outcome = sd.stop_owned(self.processes[label])
        except Exception:
            self.stop_failed = True
            raise
        del self.processes[label]
        return outcome

    def stop_daemon(self) -> None:
        self.result.setdefault("stops", []).append(self.stop_owned("daemon"))

    def probe(self, lane_id: str | None = None) -> dict[str, Any]:
        """Loopback probe as the scratch operator (work_lanes.show requires operator authority)."""
        return sd.probe(sd.DAEMON_PORT, lane_id, auth=self.probe_auth)

    def probe_a(self) -> None:
        got = self.probe(sd.big_lane_id())
        problems = v1.check_v1_inventory(got["inventory"], sd.v1_lane_ids()) + v1.check_v1_show(got["show"], sd.big_lane_id())
        # Negative control: the same read without operator authority is refused by the daemon.
        anonymous = sd.probe(sd.DAEMON_PORT, sd.big_lane_id())
        refused = (anonymous["show"] or {}).get("error_code")
        if refused != "work_lanes_unauthorized":
            problems.append(f"anonymous show was not refused as unauthorized (got {refused or (anonymous['show'] or {}).get('type')})")
        self.result["checks"]["probe_a"] = {"inventory": sd.summarize_frame(got["inventory"]),
                                            "show": sd.summarize_frame(got["show"]), "problems": problems,
                                            "anonymous_show_error_code": refused}
        if problems:
            raise SetupFail("run A daemon is not serving the v1 wire: " + "; ".join(problems))
        self.inventory_order = [lane["lane_id"] for lane in got["inventory"]["lanes"]]

    def probe_b(self) -> None:
        last: dict[str, Any] = {}

        def ready() -> bool:
            got = self.probe(sd.big_lane_id())
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
    def configure_cfu(self) -> None:
        # Detection-only: absence of this preference proof does not certify suppression or stop the run.
        value = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S +0000")
        record: dict[str, Any] = {"at": now_iso(), "udid": self.udid, "value": value, "verified": False,
                                  "operations": []}
        self.result["cfu"] = record
        def command(*argv: str, timeout: int = 120) -> subprocess.CompletedProcess:
            result = self.simctl(*argv, timeout=timeout, check=False)
            record["operations"].append({"action": list(argv), "rc": result.returncode})
            return result
        try:
            written = command("spawn", self.udid, "defaults", "write", CFU_DOMAIN, CFU_KEY, "-date", value)
            if written.returncode:
                record["error"] = "write failed"
                return
            try:
                stopped = command("shutdown", self.udid)
                shutdown_failed = bool(stopped.returncode)
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
                shutdown_failed = True
                record["shutdown_error"] = f"{type(exc).__name__}: {exc}"
            # Always attempt boot after shutdown, even if shutdown reported an error or timed out.
            try:
                booted = command("boot", self.udid)
                boot_failed = bool(booted.returncode)
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
                boot_failed = True
                record["boot_error"] = f"{type(exc).__name__}: {exc}"
            # A timed-out boot may still complete; attempt the normal readiness check.
            ready = command("bootstatus", self.udid, "-b", timeout=300)
            if shutdown_failed or boot_failed or ready.returncode:
                record["error"] = "shutdown or reboot failed"
                return
            read = command("spawn", self.udid, "defaults", "read", CFU_DOMAIN, CFU_KEY)
            record["readback"] = read.stdout.strip()
            record["verified"] = read.returncode == 0 and read.stdout.strip() == value
            if not record["verified"]:
                record["error"] = "readback failed or differed"
        except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"

    def activate_simulator(self) -> None:
        companion = verified_companion(self.args.idb_companion)
        name = f"{SCENARIO}-{self.run_id}"
        self.udid = self.simctl("create", name, self.args.device_type, self.args.runtime).stdout.strip()
        if not re.fullmatch(r"[0-9A-Fa-f-]{36}", self.udid or ""):
            raise SetupFail("simulator create returned no UDID")
        self.result["simulator"] = {"udid": self.udid, "name": name, "device_type": self.args.device_type,
                                    "runtime": self.args.runtime, "fresh_state": True}
        self.simctl("boot", self.udid)
        self.simctl("bootstatus", self.udid, "-b", timeout=300)
        self.configure_cfu()
        self.content_size = self.simctl("ui", self.udid, "content_size", check=False).stdout.strip() or "large"
        self.simctl("install", self.udid, str(self.args.app.resolve()), timeout=300)
        installed = Path(self.simctl("get_app_container", self.udid, self.args.bundle_id, "app").stdout.strip())
        expected = self.result["proof_app"]["hashes"]
        for name, digest in expected.items():
            if digest and sd.sha256_file(installed / name) != digest:
                raise SetupFail("installed app differs from the admitted app: " + name)
        self.result["simulator"]["installed_app"] = str(installed)
        self.processes["ui-companion"] = sd.start_owned(
            "ui-companion", [companion, "--udid", self.udid,
                             "--grpc-port", str(sd.COMPANION_PORT)],
            env={key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG") if key in os.environ},
            cwd=self.run_dir, log=self.evidence / "ui-companion.log", port=sd.COMPANION_PORT)
        self.ui = Ui(self.udid, self.args.idb, self.trace, self.shots, self.args.bundle_id)

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
        checkout = self.enroll_checkout
        out = self.sh([self.python, str(Path(__file__).resolve().parent / "scratch_daemon.py"), "enroll-link",
                       "--checkout", str(checkout), "--scratch", str(self.scratch)],
                      env=sd.child_env(self.scratch), cwd=checkout)
        url = json.loads(out.stdout.strip().splitlines()[-1])["url"]
        opened = subprocess.run(["xcrun", "simctl", "openurl", self.udid, url], capture_output=True, text=True,
                                timeout=60, check=False)
        self.trace("openurl enrollment", {"rc": opened.returncode})  # the link (one-time code) is never retained
        del url
        if opened.returncode:
            raise SetupFail("enrollment deep link did not open")
        # iOS may confirm the link ("Open in “Pentacle”?") or ask for notifications; only exact known alerts are pressed.
        alerts = self.result.setdefault("system_alerts", [])
        deadline = time.monotonic() + 60
        while not connections_with_snapshot(self.wire(), since):
            alerts.extend(self.ui.clear_system_alerts())
            if time.monotonic() > deadline:
                if hasattr(self.ui, "dump"):
                    self.ui.dump("enroll-timeout")
                raise SetupFail("enrolled app did not receive a daemon snapshot through the loopback proxy")
            time.sleep(1)
        self.result["enrollment"] = {"mechanism": "normal enrollment deep link, fresh simulator, owned scratch registry",
                                     "endpoint": sd.APP_WS_URL}  # code_retained is set by the evidence scan

    def home_enrolled(self) -> None:
        """After enrollment: the assistant tab is unlocked and hydrated; the header is recorded when rendered."""
        alerts = self.result.setdefault("system_alerts", [])
        deadline = time.monotonic() + 30
        while True:
            alerts.extend(self.ui.clear_system_alerts())
            elements = self.ui.elements()
            state = home_state(elements)
            if state is not None:
                break
            if time.monotonic() > deadline:
                self.ui.dump("home-not-unlocked", elements)
                raise SetupFail("enrolled home screen is not unlocked and hydrated")
            time.sleep(1)
        self.ui.dump("home-enrolled", elements)
        self.ui.screenshot("home-enrolled")
        self.result["checks"]["home_enrolled"] = {**state, "system_alerts": list(alerts)}

    def open_lanes(self) -> None:
        """Enter through the header or the guarded deep link, then find the new home."""
        alerts = self.result.setdefault("system_alerts", [])
        alerts.extend(self.ui.clear_system_alerts())
        button = lanes_status_button(self.ui.elements())
        if button is not None:
            self.ui.tap_element(button, "lanes status button")
            self.result["lanes_entry"] = "assistant header status button"
        else:
            opened = subprocess.run(["xcrun", "simctl", "openurl", self.udid, "pentacle://pentacle/lanes"],
                                    capture_output=True, text=True, timeout=60, check=False)
            if opened.returncode:
                raise SetupFail("lanes route deep link did not open")
            self.result["lanes_entry"] = "deep link"
        deadline = time.monotonic() + 30
        while True:
            alerts.extend(self.ui.clear_system_alerts())
            elements = self.ui.elements()
            if any(Ui.ident(element) == "lanes-close" for element in elements):
                break
            if time.monotonic() > deadline:
                self.ui.dump("lanes-not-open", elements)
                raise SetupFail("lanes view did not open from the " + self.result["lanes_entry"])
            time.sleep(1)
        self.ui.find("lanes-close")

    def show_view(self, view: str) -> None:
        """The map and grouped list now share the home scroll surface."""
        if view not in ("map", "list"):
            raise ValueError(view)
        self.ui.find("lanes-close")
        if self.ui.ids("lanes-back"):
            raise AssertFail("expected lanes home before reading the " + view)
        if view == "map":
            self.ui.find("lanes-map-assistant")
        elif not self.ui.ids(LIST_CARD):
            raise AssertFail("grouped lane list did not render")

    def focus_lane(self, lane: str) -> None:
        self.ui.tap(f"lanes-map-lane-{lane}")
        self.ui.find("lanes-back")

    def unfocus_to_page_one(self) -> None:
        self.ui.tap("lanes-back")
        self.ui.find("lanes-map-assistant")

    def visible_order(self, prefix: str) -> list[str]:
        cards = [e for e in self.ui.ids(prefix) if re.fullmatch(re.escape(prefix) + r"wl-[0-9a-f]{24}", Ui.ident(e))]
        if prefix == "lanes-map-lane-":
            cards = orbit_order(cards, Ui.frame(self.ui.find("lanes-map-assistant")))
        else:
            cards.sort(key=lambda e: Ui.frame(e)["y"])
        return [Ui.ident(e)[len(prefix):] for e in cards]

    def bracket_order(self, label: str, read_screen: Any, matches: Any) -> list[str]:
        """Read the screen between two fresh inventory probes; pass only when both probes give the same lane order
        and the screen matches it exactly. At most ORDER_ATTEMPTS attempts, then fail closed."""
        attempts = self.result["checks"].setdefault("order_brackets", {}).setdefault(label, [])
        for _ in range(ORDER_ATTEMPTS):
            before = list((self.probe()["inventory"] or {}).get("lanes", []))
            screen = read_screen()
            after = list((self.probe()["inventory"] or {}).get("lanes", []))
            ok = (lane_ids(before) == lane_ids(after) and grouped_lane_ids(before) == grouped_lane_ids(after)
                  and matches(screen, before))
            attempts.append({"before": lane_ids(before), "after": lane_ids(after), "screen": screen, "ok": ok})
            if ok:
                self.inventory_order = lane_ids(before)
                return screen
        raise AssertFail(f"{label}: rendered order never matched an agreed daemon order in {ORDER_ATTEMPTS} attempts")

    def bracket_list(self, label: str) -> list[str]:
        def matches(visible: list[str], lanes: list[dict[str, Any]]) -> bool:
            expected = grouped_lane_ids(lanes)
            return bool(visible) and len(visible) == len(set(visible)) and visible == [x for x in expected if x in visible]
        return self.bracket_order(label, lambda: self.visible_order(LIST_CARD), matches)

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

    def run_a_list(self) -> None:
        visible = self.bracket_list("run A list")
        self.ui.absent("lane-card-chat-")
        self.ui.absent("lane-card-log-")
        self.ui.screenshot("a-list")
        self.result["checks"]["run_a_list"] = {"visible_lanes": visible}

    def run_a_map(self) -> None:
        self.show_view("map")
        visible = self.visible_order("lanes-map-lane-")
        if set(visible) != set(sd.v1_lane_ids()):
            raise AssertFail("run A map does not show exactly the v1 lanes")
        self.ui.absent("lanes-map-member-")
        self.ui.screenshot("a-map")
        self.result["checks"]["run_a_map"] = {"lanes": visible, "member_nodes": 0}

    def run_a_log(self) -> None:
        since = time.time()
        self.ui.tap(f"lane-row-{sd.big_lane_id()}")
        pair = self.show_after(since)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("v1 lane detail show did not succeed")
        self.ui.find("lanes-back")
        self.ui.absent("lane-log-tab-")
        self.ui.screenshot("a-legacy-lane")
        self.ui.tap("lanes-back")
        self.result["checks"]["run_a_log"] = {"show": pair, "legacy_lane_opened": True}

    def transport_unavailable_probe(self) -> None:
        """Open the lane after the owned daemon is stopped and prove offline visibility."""
        since = time.time()
        self.ui.tap(f"lane-row-{sd.big_lane_id()}")
        self.ui.find_label("Waiting for connection", 30)
        requests = len(show_pairs(self.wire(), since))
        if requests:
            raise AssertFail("offline lane sent a show request while the daemon was stopped")
        self.ui.screenshot("c-transport-unavailable")
        self.ui.tap("lanes-back")
        self.result["checks"]["transport_unavailable"] = {"waiting_visible": True, "requests_sent": requests}

    def run_c_reconnect(self) -> None:
        since = self.processes["daemon"]["started_at"]
        try:
            sd.wait_for(lambda: bool(connections_with_snapshot(self.wire(), since)), 90, "reconnect snapshot")
        except TimeoutError:
            raise AssertFail("app did not reconnect to the upgraded daemon through the unchanged proxy") from None
        if self.app_pids() != [self.app_pid]:
            raise AssertFail("app process changed across the upgrade (restart or reinstall)")
        self.ui.find("lanes-close")
        self.ui.screenshot("c-reconnected-list")
        self.result["checks"]["run_c_reconnect"] = {"app_pid_unchanged": self.app_pid,
            "daemon_b_pid": self.processes["daemon"]["pid"], "connections": connections_with_snapshot(self.wire(), since)}

    def spec_edit(self) -> None:
        sd.tick_edited_spec(self.scratch / "memory")

        def changed() -> bool:
            got = self.probe(sd.big_lane_id())
            return any(e.get("operation") == "item_change" for e in (got["show"] or {}).get("events", []))

        try:
            sd.wait_for(changed, 90, "daemon item_change after spec edit", interval=3)
        except TimeoutError:
            raise SetupFail("daemon sweep did not record an item_change for the edited spec") from None
        self.result["checks"]["spec_edit"] = {"spec_id": sd.EDITED, "item_change": True,
                                              "timing": "fixture timing delta " + json.dumps(sd.FIXTURE_TIMING)}

    def run_b_list(self) -> None:
        visible = self.bracket_list("run B list")
        since = time.time()
        self.ui.tap(f"lane-row-{sd.big_lane_id()}")
        self.ui.find("lanes-back")
        pair = self.show_after(since)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("lane detail show did not succeed")
        self.ui.find("goal-head-default", 30)
        self.ui.screenshot("b-lane")
        self.result["checks"]["run_b_list"] = {"visible_lanes": visible, "show": pair}

    def reduced_list(self) -> None:
        self.run_b_list()
        self.result["checks"]["reduced_list"] = self.result["checks"].pop("run_b_list")

    def reduced_members(self) -> None:
        self.run_b_all_members()
        self.run_b_member_detail()
        self.result["checks"]["reduced_members"] = self.result["checks"]["run_b_all_members"]

    def reduced_map(self) -> None:
        self.run_b_map_pages()
        self.result["checks"]["reduced_map"] = self.result["checks"].pop("run_b_map_pages")

    def run_b_map_pages(self) -> None:
        self.show_view("map")
        visible = self.bracket_order("run B map", lambda: self.visible_order("lanes-map-lane-"),
            lambda seen, lanes: len(seen) == len(set(seen)) and set(seen) == expected_map_lanes(lanes)[0])
        lanes = (self.probe()["inventory"] or {}).get("lanes", [])
        expected, folded = expected_map_lanes(lanes)
        if set(visible) != expected:
            raise AssertFail("map changed before label inspection")
        assert_map_labels(self.ui, expected, folded, {lane["lane_id"]: lane["title"] for lane in lanes})
        if folded:
            self.ui.find("lanes-map-fold-paused-more")
        else:
            self.ui.absent("lanes-map-fold-paused-more")
        self.ui.screenshot("b-map")
        self.result["checks"]["run_b_map_pages"] = {"visible_lanes": visible}

    def run_b_focus_overflow(self) -> None:
        self.focus_lane(sd.big_lane_id())
        pair = self.show_after(time.time() - 10)
        if pair["reply_type"] != "work_lanes.show.ok":
            raise AssertFail("map lane selection did not load its details")
        self.ui.find("goal-head-default", 30)
        self.unfocus_to_page_one()
        self.result["checks"]["run_b_focus_overflow"] = {"show": pair}

    def run_b_all_members(self) -> None:
        ui = self.ui
        ui.tap("goal-head-default")
        ui.find("lanes-back")
        # Reveal the two folded groups before collecting all non-deprecated specs.
        if ui.ids("goal-next-expand"):
            ui.tap("goal-next-expand")
        if ui.ids("goal-done-fold"):
            ui.tap("goal-done-fold")
        got = [x.removeprefix("spec-row-") for x in ui.collect_scrolling("spec-row-", 30, max_swipes=30)]
        if len(got) != 30 or set(got) != set(sd.BIG[:30]):
            raise AssertFail(f"goal exposes {len(got)} members, expected the 30 non-deprecated specs")
        ui.screenshot("b-goal-members")
        self.result["checks"]["run_b_all_members"] = {"members": got, "source": "pinned increment-one daemon; unpaged"}

    def run_b_member_detail(self) -> None:
        ui, spec = self.ui, sd.BIG[0]
        ui.tap(f"spec-row-{spec}")
        ui.find("lanes-back")
        ui.absent("spec-row-")
        ui.find_label("Span 01")
        ui.find_label("Building")
        ui.find_label("0/2 checks")
        ui.absent("member-detail-chat")
        ui.absent("lane-log-tab-")
        ui.screenshot("b-spec")
        ui.tap("lanes-back")
        ui.find(f"spec-row-{spec}")
        ui.tap("lanes-back")
        ui.find("goal-head-default")
        ui.tap("lanes-back")
        ui.find("lanes-close")
        self.result["checks"]["run_b_member_detail"] = {"spec_id": spec, "back": "spec -> goal -> lane -> home"}

    def overflow_phase_boundary(self) -> None:
        if not self.result["checks"].get("run_c_reconnect", {}).get("app_pid_unchanged"):
            raise SetupFail("C evidence missing before overflow")
        self.show_view("map")
        self.result["overflow_phase"] = {"started_at": now_iso(), "prior_checks": sorted(self.result["checks"]), "app_pid": self.app_pid}
        self.write("pre-overflow-result.json", self.result)

    def overflow_add_lanes(self) -> None:
        since = time.time()
        self.seed("overflow", self.inc1_checkout)
        expected = set(sd.all_lane_ids() + sd.overflow_lane_ids())
        last = {}
        def settled():
            got = self.probe()
            ids = [x["lane_id"] for x in (got["inventory"] or {}).get("lanes", [])]
            last["ids"] = ids
            return len(ids) == len(expected) and set(ids) == expected
        sd.wait_for(settled, 120, "overflow inventory", interval=3)
        sd.wait_for(lambda: any(r.get("at", 0) >= since and r.get("direction") == "daemon_to_client"
                                and r.get("type") == "work_lanes.inventory" for r in self.wire()),
                    120, "overflow inventory delivered to client", interval=1)
        self.result["overflow_phase"]["inventory_ids"] = last["ids"]

    def overflow_assert(self) -> None:
        ui = self.ui
        expected = self.result["overflow_phase"]["inventory_ids"]
        self.run_b_map_pages()
        def read_list() -> list[str]:
            return [x.removeprefix(LIST_CARD) for x in ui.collect_scrolling(LIST_CARD, len(expected), max_swipes=30)]
        observed = self.bracket_order("overflow grouped list", read_list,
            lambda seen, lanes: seen == grouped_lane_ids(lanes))
        validate_overflow_list(observed, expected)
        ui.screenshot("overflow-list")
        self.result["overflow_phase"].update(observed_ids=observed, completed_at=now_iso())

    def run_b_index_unavailable(self) -> None:
        memory = self.scratch / "memory"
        sd.hide_memory_root(memory)
        try:
            sd.wait_for(lambda: (self.probe()["inventory"] or {}).get("work_index", {}).get("available") is False,
                        90, "work_index unavailable", interval=3)
            # iOS exposes this static Text by its visible label but may omit its testID.
            self.ui.find_label("DATA AS OF", 60)
            self.ui.screenshot("b-index-unavailable")
        finally:
            sd.restore_memory_root(memory)
        sd.wait_for(lambda: (self.probe()["inventory"] or {}).get("work_index", {}).get("available") is True,
                    90, "work_index restored", interval=3)
        deadline = time.monotonic() + 60
        while any("data as of" in Ui.label(element).lower() for element in self.ui.elements()):
            if time.monotonic() > deadline:
                raise AssertFail("index banner persists after the work root returned")
            time.sleep(1)
        self.result["checks"]["run_b_index_unavailable"] = {"banner": True, "restored": True}

    def run_b_large_text(self) -> None:
        ui = self.ui
        self.simctl("ui", self.udid, "content_size", LARGE_TEXT)
        time.sleep(2)
        try:
            self.show_view("map")
            screen = ui.screen()
            assert_target(ui.find("lanes-close"), screen)
            nodes = ui.ids("lanes-map-lane-")
            if not nodes:
                raise AssertFail("large-text map contains no lane targets")
            for node in nodes:
                assert_target(node)
            overlaps = overlapping(nodes)
            if overlaps:
                raise AssertFail(f"overlapping lane targets at large text {overlaps[:2]}")
            lanes = (self.probe()["inventory"] or {}).get("lanes", [])
            expected, folded = expected_map_lanes(lanes)
            assert_map_labels(ui, expected, folded, {lane["lane_id"]: lane["title"] for lane in lanes})
            ui.screenshot("b-large-text-home")
        finally:
            self.simctl("ui", self.udid, "content_size", self.content_size or "large", check=False)
        self.result["checks"]["run_b_large_text"] = {"content_size": LARGE_TEXT, "lane_targets": len(nodes)}

    def run_b_final(self) -> None:
        self.ui.find(LIST_CARD + sd.big_lane_id())
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
    def flow(self, mode: str) -> list[tuple[str, Callable[[], Any]]]:
        steps = {
            "admission": self.admission, "seed_inc1": self.seed_inc1, "proxy_start": self.start_proxy,
            "daemon_b_start": lambda: self.start_daemon("daemon-b-inc1", self.inc1_checkout), "probe_b": self.probe_b,
            "simulator_activate": self.activate_simulator, "app_launch": self.launch, "enroll": self.enroll,
            "home_enrolled": self.home_enrolled, "open_lanes": self.open_lanes, "reduced_list": self.reduced_list,
            "reduced_members": self.reduced_members, "reduced_map": self.reduced_map,
        }
        return [(name, steps[name]) for name in (SMOKE_STEPS if mode == "smoke" else REDUCED_STEPS)]

    def execute(self, mode: str = "run") -> int:
        self.run_dir.mkdir(parents=True, exist_ok=False)
        self.evidence.mkdir()
        self.shots.mkdir()
        self.trace_file = (self.evidence / "trace.jsonl").open("w", encoding="utf-8")
        verdict, error = "SETUP_FAIL", None
        self.result["mode"] = mode
        try:
            if mode in ("smoke", "reduced"):
                for name, fn in self.flow(mode):
                    self.step(name, fn)
                raise _FlowDone()
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
                ("probe_b", self.probe_b), ("run_c_reconnect", self.run_c_reconnect),
                ("run_b_list", self.run_b_list), ("run_b_all_members", self.run_b_all_members),
                ("run_b_member_detail", self.run_b_member_detail), ("run_b_map_pages", self.run_b_map_pages), ("run_b_focus_overflow", self.run_b_focus_overflow),
                ("run_b_index_unavailable", self.run_b_index_unavailable), ("run_b_large_text", self.run_b_large_text),
                ("run_b_final", self.run_b_final), ("overflow_phase_boundary", self.overflow_phase_boundary),
                ("overflow_add_lanes", self.overflow_add_lanes), ("overflow_assert", self.overflow_assert),
            ]:
                self.step(name, fn)
            verdict = "PASS"
        except _FlowDone:
            verdict = "PASS"
        except AssertFail as exc:
            verdict, error = "FAIL", str(exc)
        except SystemUIInterception as exc:
            verdict, error = "SETUP_FAIL", str(exc)
            self.result["interception"] = {"classification": exc.classification,
                                            "reason_code": "system_ui_interception",
                                            "foreground": exc.foreground,
                                            "timestamp_utc": exc.timestamp_utc,
                                            "video_timestamp": exc.video_timestamp}
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
                attempt(f"{label}_stop", lambda label=label: self.stop_owned(label))
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
        self.result["wire_code_scan"] = scrub_wire_codes(proxy_dir / "throttle-wire.jsonl")
        for name in ("throttle-wire.jsonl", "throttle-process.json"):
            if (proxy_dir / name).is_file():
                shutil.copyfile(proxy_dir / name, self.evidence / name)
        if self.result["wire_code_scan"]["remaining"]:
            raise RuntimeError("wire evidence still holds an enrollment code")
        if "enrollment" in self.result:
            self.result["enrollment"]["code_retained"] = False
        scratch_hashes = {}
        if self.scratch.is_dir():
            sd.assert_scratch_paths(self.scratch)
            for path in sorted(self.scratch.rglob("*")):
                if path.is_file() and path.name != OWNER_MARKER and "operator-auth" not in path.relative_to(self.scratch).parts:
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
        if self.stop_failed:
            raise RuntimeError("an owned stop failed during the run; scratch kept for recovery")
        shutil.rmtree(self.scratch)
        return {"removed": str(self.scratch)}


# ---------------------------------------------------------------------------
# Supplemental: screenshot-harness scenes (separate build identity)
# ---------------------------------------------------------------------------

SUPPLEMENTAL_SCENES = {
    "lanes:v1_wire": {"expect": ["lanes-close"], "prefix_present": "lane-row-"},
    "lanes:inc1_cases": {"expect": ["lanes-close", "lanes-index-banner"], "prefix_present": "lane-row-"},
    "lanes:overflow": {"expect": ["lanes-close"], "prefix_present": "lane-row-"},
}


# Show failure scenes: an ARMED harness build (`EXPO_PUBLIC_HARNESS=1`) connects
# to a loopback stub that serves the shared fixture's v1 inventory and then
# answers the app's real `work_lanes.show` with a typed error, or never answers
# (while still answering pings) so the client's own 30 s RPC timeout settles it.
# Product settlement is unchanged; nothing is injected into component state.
SHOW_FAILURE_BUILD = "harness_release_loopback_stub"
SHOW_FAILURE_SCENES = {
    "lanes:show_error": {"mode": "typed_error", "expect_text": "Lane details unavailable", "min_wait_s": 0},
    "lanes:show_timeout": {"mode": "no_reply", "expect_text": "Request timed out", "min_wait_s": 30},
}

PAGED_SCENE = {"mode": "pagination", "build": SHOW_FAILURE_BUILD}


def _mock_daemon_class():
    tools = Path(__file__).resolve().parents[3] / "test" / "e2e" / "tools"
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    import mock_v2_daemon  # existing public mock; imported, never modified
    return mock_v2_daemon.MockDaemon


class LaneShowStub:
    """Loopback stub for the show failure scenes; records every show request."""

    def __init__(self, mode: str, inventory: dict[str, Any]):
        if mode not in ("typed_error", "no_reply", "pagination"):
            raise ValueError("unknown stub mode")
        base = _mock_daemon_class()
        stub = self

        class _Daemon(base):
            def _snapshot_frame(self, events_mode, exclude):
                return {**super()._snapshot_frame(events_mode, exclude), "work_lanes": inventory}

            async def _dispatch(self, ws, msg):
                if msg.get("type") == "work_lanes.show":
                    await stub._on_show(self, ws, msg)
                    return
                await super()._dispatch(ws, msg)

            async def _on_hello(self, ws, msg):
                await super()._on_hello(ws, msg)
                await self._send(ws, {**inventory, "type": "work_lanes.inventory"})

        self.mode, self.receipts = mode, []
        self.daemon = _Daemon(argparse.Namespace(host="supplemental-host", recent_limit=100, credential_registry=""))
        self.inventory = inventory
        if mode == "pagination":
            lane = inventory["lanes"][0]
            lane.update(members_total=65, detail_revision="a" * 64,
                        goals=[{"goal_id": "g-native-page", "title": "Paged fixture", "state": "in_progress",
                                "rank": 1, "done": 0, "total": 65}], goals_total=1)
            self.members = [{"spec_id": f"spec_native_page_{i:03d}", "title": f"Paged item {i:03d}",
                             "status": "in_progress", "goal_id": "g-native-page"} for i in range(1, 66)]
            lane["members"] = self.members[:8]
            now = now_iso()
            self.daemon.notifications["native-lane-question"] = {
                "notification_id": "native-lane-question", "created_at": now, "updated_at": now,
                "producer": "agent_question.v1", "answer_to_stream_id": lane["lead"]["stream_id"],
                "severity": "info", "title": "Fixture question", "body": "Which fixture option?",
                "dedup_key": "native-lane-question", "state": "open",
                "actions": [{"kind": "ack", "action_id": "answer"}],
                "question": {"question_id": "native-lane-question", "producer_stream_id": lane["lead"]["stream_id"],
                             "state": "open", "response_mode": "single_choice",
                             "options": [{"label": "Use fixture", "value": "yes"}]}}
        self.handler = self.daemon.handler

    async def _on_show(self, daemon, ws, msg) -> None:
        receipt = {"at": time.time(), "request_id": msg.get("request_id"), "lane_id": msg.get("lane_id"),
                   "members_after": msg.get("members_after"), "reply": None}
        self.receipts.append(receipt)
        if self.mode == "typed_error":
            await daemon._send(ws, {"type": "work_lanes.show.error", "request_id": msg.get("request_id"),
                                    "error_code": "work_lanes_show_failed", "error": "synthetic supplemental failure"})
            receipt["reply"] = "work_lanes.show.error"
        elif self.mode == "pagination":
            lane = self.inventory["lanes"][0]
            cursor = msg.get("members_after")
            start = next((i + 1 for i, member in enumerate(self.members) if member["spec_id"] == cursor), 0) if cursor else 0
            page = self.members[start:start + 32]
            next_cursor = page[-1]["spec_id"] if start + len(page) < len(self.members) else None
            await daemon._send(ws, {"type": "work_lanes.show.ok", "request_id": msg.get("request_id"),
                                    "lane": {"lane_id": lane["lane_id"]}, "projection": lane,
                                    "members": page, "members_total": len(self.members), "members_next": next_cursor,
                                    "detail_revision": "a" * 64, "events": [], "updates": []})
            receipt["reply"] = "work_lanes.show.ok"


def start_stub(stub: LaneShowStub, port: int) -> Callable[[], None]:
    """Serve the stub on loopback in a background thread; returns its stop function."""
    import asyncio
    import threading
    import websockets

    loop = asyncio.new_event_loop()
    ready, state = threading.Event(), {}

    async def serve() -> None:
        try:
            state["server"] = await websockets.serve(stub.handler, sd.HOST, port, max_size=None)
        except Exception as exc:
            state["error"] = exc
            ready.set()
            return
        ready.set()
        await state["server"].wait_closed()

    def runner() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(serve())

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    ready.wait(10)
    if "error" in state or not sd.port_listening(port):
        raise SetupFail(f"loopback stub did not listen on {port}: {state.get('error')}")

    def stop() -> None:
        loop.call_soon_threadsafe(state["server"].close)
        thread.join(10)
        if sd.port_listening(port):
            raise SetupFail("loopback stub still listening after stop")
    return stop


def run_show_failure_scene(scene: dict[str, Any], ui: "Ui", stub: LaneShowStub, record: dict[str, Any],
                           lane_id: str) -> None:
    """Open a lane and assert the settled failure state plus a real Retry request."""
    ui.find(f"lane-row-{lane_id}", 60)
    tapped = time.time()
    ui.tap(f"lane-row-{lane_id}")
    deadline = time.monotonic() + 20
    while not stub.receipts:
        if time.monotonic() > deadline:
            raise AssertFail("the app sent no work_lanes.show to the stub")
        time.sleep(0.3)
    pending_visible = None
    if scene["mode"] == "no_reply":
        if ui.ids("lanes-detail-retry"):
            raise AssertFail("the unanswered request settled before the client timeout")
        if not ui.ids("lanes-map-members-loading"):
            raise AssertFail("no pending state (lanes-map-members-loading) while the request is unanswered")
        pending_visible = True
        ui.screenshot("show-pending")
    ui.find_label(scene["expect_text"], scene["min_wait_s"] + 30)
    settled = time.time()
    ui.find("lanes-detail-retry", 5)
    waited = settled - stub.receipts[0]["at"]
    if waited < scene["min_wait_s"] - 1:
        raise AssertFail(f"{scene['expect_text']} appeared after {waited:.1f}s, before the client timeout")
    ui.screenshot("show-settled")
    before = len(stub.receipts)
    earlier = {receipt["request_id"] for receipt in stub.receipts}
    ui.tap("lanes-detail-retry")
    deadline = time.monotonic() + 20
    while len(stub.receipts) == before:
        if time.monotonic() > deadline:
            raise AssertFail("Retry did not send a new work_lanes.show")
        time.sleep(0.3)
    for receipt in stub.receipts[before:]:
        if not receipt["request_id"] or receipt["request_id"] in earlier or receipt["lane_id"] != lane_id:
            raise AssertFail("Retry did not send a fresh request id for the same lane")
    record["show_failure"] = {"mode": scene["mode"], "expect_text": scene["expect_text"], "tapped_at": tapped,
                              "pending_spinner_visible": pending_visible,
                              "settled_after_request_s": round(waited, 1), "retry_requests": len(stub.receipts) - before,
                              "requests": [{k: r[k] for k in ("request_id", "lane_id", "reply")} for r in stub.receipts]}


def supplemental_teardown(udid: str, runner: Callable[..., subprocess.CompletedProcess] | None = None) -> dict[str, Any]:
    """Shut down and delete the simulator this run created; verify it is gone. Never raises."""
    runner = runner or subprocess.run
    record: dict[str, Any] = {"udid": udid}
    for verb in ("shutdown", "delete"):
        try:
            result = runner(["xcrun", "simctl", verb, udid], capture_output=True, text=True, check=False, timeout=120)
            record[f"{verb}_rc"], record[f"{verb}_stderr"] = result.returncode, (result.stderr or "")[-300:]
        except Exception as exc:  # timeout or missing tool: still check the postcondition
            record[f"{verb}_rc"], record[f"{verb}_stderr"] = None, str(exc)[:300]
    try:
        listed = runner(["xcrun", "simctl", "list", "devices", "-j"], capture_output=True, text=True, check=False, timeout=60)
        devices = json.loads(listed.stdout or "{}").get("devices", {}) if listed.returncode == 0 else None
        record["udid_absent"] = devices is not None and not any(
            device.get("udid") == udid for group in devices.values() for device in group)
    except Exception as exc:
        record.update(udid_absent=False, list_error=str(exc)[:300])
    record["complete"] = record["udid_absent"] is True
    return record


def stop_supplemental_companion(record: dict[str, Any], companion: dict[str, Any],
                                stopper: Callable[[dict[str, Any]], Any] | None = None) -> None:
    """Record the companion stop separately; a failure never touches the frozen scene verdict."""
    try:
        record["companion_stop"] = (stopper or sd.stop_owned)(companion)
        record["companion_stopped"] = True
    except Exception as exc:
        record.update(companion_stopped=False, companion_stop_error=str(exc)[:200])


def finalize_supplemental(record: dict[str, Any], teardown: dict[str, Any]) -> dict[str, Any]:
    """The scene verdict is frozen before teardown; incomplete cleanup makes the run SETUP_FAIL without
    overwriting it."""
    record.setdefault("scene_verdict", record.get("verdict"))
    cleaned = (teardown.get("complete") is True and record.get("companion_stopped") is not False
               and record.get("stub_stopped") is not False)
    record["verdict"] = record["scene_verdict"] if cleaned else "SETUP_FAIL"
    if not cleaned:
        record.setdefault("error", "supplemental cleanup incomplete")
    return record


HARNESS_APP_NAME = "Pentacle Harness"  # app.config.ts names the armed (EXPO_PUBLIC_HARNESS=1) build


def admit_supplemental_app(bundle: bytes, app_config: dict[str, Any], production: list[str], build: str) -> dict[str, Any]:
    """Shared admission for every supplemental scene, before any simulator exists: the same compiled loopback
    scan as the proof build, every production operational URL absent, and the scene's declared build identity."""
    if not production:
        raise SetupFail("production public config yielded no operational URLs to reject")
    scan = scan_compiled(bundle, app_config, production)
    if scan["problems"]:
        raise SetupFail("compiled configuration admission failed: " + "; ".join(scan["problems"]))
    if build == SHOW_FAILURE_BUILD and app_config.get("name") != HARNESS_APP_NAME:
        raise SetupFail("show failure scenes need the armed harness build (app name " + HARNESS_APP_NAME + ")")
    return scan


def check_seeded_scene(scene: dict[str, Any], ui: "Ui", stub: Any, record: dict[str, Any], lane_id: str | None) -> None:
    """Screenshot-harness scene: the overlay renders the seeded frame and lane details settle offline."""
    for identifier in scene["expect"]:
        ui.find(identifier, 30)
    if not ui.ids(scene["prefix_present"]):
        raise AssertFail("scene lacks " + scene["prefix_present"])
    ui.screenshot("scene")
    first = sorted((e for e in ui.ids("lane-row-")), key=lambda e: Ui.frame(e)["y"])
    if first:
        ui.tap(Ui.ident(first[0]))
        # Seeded scenes report connected with no socket: the real request path rejects at once.
        for text in ("Lane details unavailable", "Waiting for connection"):
            if any(text.lower() in Ui.label(e).lower() for e in ui.elements()):
                record["offline_log_state"] = text
                break
        else:
            ui.find_label("Lane details unavailable", 20)
            record["offline_log_state"] = "Lane details unavailable"
        ui.screenshot("offline-log")


def check_paged_scene(scene: dict[str, Any], ui: "Ui", stub: LaneShowStub, record: dict[str, Any], lane_id: str) -> None:
    """Drive the existing loopback stub through all pages and a synthetic question."""
    ui.tap(f"lane-row-{lane_id}", 60)
    ui.find("goal-head-g-native-page", 60)
    try:
        sd.wait_for(lambda: len([r for r in stub.receipts if r["reply"] == "work_lanes.show.ok"]) >= 3,
                    60, "three paged show replies")
    except TimeoutError:
        raise AssertFail("pagination did not settle all three pages") from None
    cursors = [r["members_after"] for r in stub.receipts if r["reply"] == "work_lanes.show.ok"]
    if cursors[:3] != [None, "spec_native_page_032", "spec_native_page_064"]:
        raise AssertFail(f"pagination did not request all three pages in order: {cursors}")
    ui.find("questions-skip", 30)
    ui.screenshot("paged-lane-question")
    ui.tap("questions-skip")
    deadline = time.monotonic() + 30
    while stub.daemon.notifications["native-lane-question"]["question"]["state"] == "open":
        if time.monotonic() > deadline:
            raise AssertFail("synthetic question did not settle after skip")
        time.sleep(0.3)
    ui.tap("goal-head-g-native-page")
    rows = [x.removeprefix("spec-row-") for x in ui.collect_scrolling("spec-row-", 65, max_swipes=60)]
    expected = {m["spec_id"] for m in stub.members}
    if len(rows) != 65 or set(rows) != expected:
        raise AssertFail(f"paged goal exposes {len(rows)} of 65 fixture members")
    ui.screenshot("paged-goal")
    record["pagination"] = {"cursors": cursors, "members": len(rows), "question": "synthetic skip settled"}


# Every supplemental scene, with its build identity and its own check. supplemental() is the one path all of
# them take: shared admission -> simulator -> check -> verdict frozen -> companion stop -> checked teardown.
SCENES: dict[str, dict[str, Any]] = {
    **{name: {**spec, "build": SUPPLEMENTAL_BUILD, "check": check_seeded_scene}
       for name, spec in SUPPLEMENTAL_SCENES.items()},
    **{name: {**spec, "build": SHOW_FAILURE_BUILD, "check": run_show_failure_scene}
       for name, spec in SHOW_FAILURE_SCENES.items()},
    "lanes:pagination_question": {**PAGED_SCENE, "check": check_paged_scene},
}


def supplemental(args: argparse.Namespace) -> int:
    """One supplemental scene (separate build identity, labelled harness-rendered) through the shared path."""
    scene = SCENES[args.scene]
    out = args.run_dir.resolve() / ("supplemental-" + args.scene.replace(":", "-") + "-" + uuid.uuid4().hex[:6])
    out.mkdir(parents=True)
    record: dict[str, Any] = {"label": "harness_rendered_state", "build_identity": scene["build"],
                              "scene": args.scene, "not_proof_of": "real daemon request/reply"}
    udid, stop_stub, stub, lane_id = None, None, None, None
    try:
        app = args.app.resolve()
        record["app"] = identity = app_identity(app)
        record["admission"] = admit_supplemental_app(
            (app / "main.jsbundle").read_bytes(),
            json.loads((app / "EXConstants.bundle" / "app.config").read_text(encoding="utf-8")),
            operational_urls(json.loads(args.production_config.read_text(encoding="utf-8"))), scene["build"])
        udid = subprocess.run(["xcrun", "simctl", "create", f"{SCENARIO}-supplemental-{out.name}", args.device_type,
                               args.runtime], capture_output=True, text=True, check=True, timeout=120).stdout.strip()
        for argv in (["boot", udid], ["bootstatus", udid, "-b"], ["install", udid, str(app)]):
            subprocess.run(["xcrun", "simctl", *argv], capture_output=True, text=True, check=True, timeout=300)
        launch = ["launch", udid, identity["bundle_id"]]
        launch_env = None
        if scene["build"] == SHOW_FAILURE_BUILD:
            inventory = json.loads((Path(__file__).resolve().parents[3] / sd.FIXTURE_PATH).read_text(encoding="utf-8"))["inventory_frame"]
            lane_id = inventory["lanes"][0]["lane_id"]
            stub = LaneShowStub(scene["mode"], inventory)
            stop_stub = start_stub(stub, sd.PROXY_PORT)
            query = {"scenario": "lanes-show-failure", "scenario_run_id": out.name, "actions": "disable_pentacle_auth",
                     "ws_url": sd.APP_WS_URL}
            launch += ["-HarnessUrl", "pentacle://harness?" + urlencode(query)]
            launch_env = {**os.environ, "SIMCTL_CHILD_PENTACLE_ALLOW_HARNESS_LAUNCH_ARG": "1"}
            record["stub"] = {"endpoint": sd.APP_WS_URL, "inventory": "shared fixture inventory_frame",
                              "mode": scene["mode"]}
        subprocess.run(["xcrun", "simctl", *launch], capture_output=True, text=True, check=True, timeout=300, env=launch_env)
        companion = sd.start_owned("ui-companion", [args.idb_companion, "--udid", udid, "--grpc-port", str(sd.COMPANION_PORT)],
                                   env={k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "LANG") if k in os.environ},
                                   cwd=out, log=out / "ui-companion.log", port=sd.COMPANION_PORT)
        try:
            ui = Ui(udid, args.idb, lambda *_: None, out, identity["bundle_id"])
            subprocess.run(["xcrun", "simctl", "openurl", udid, "pentacle://pentacle/lanes"], check=True, timeout=60)
            scene["check"](scene, ui, stub, record, lane_id)
            record.update(scene_verdict="PASS", screenshots=ui.screenshots)
        finally:
            stop_supplemental_companion(record, companion)
    except Exception as exc:
        record.setdefault("scene_verdict", "FAIL" if isinstance(exc, AssertFail) else "SETUP_FAIL")
        record["error"] = str(exc)[:300]
    finally:
        if stop_stub:
            try:
                stop_stub()
                record["stub_stopped"] = True
            except Exception as exc:
                record.update(stub_stopped=False, stub_stop_error=str(exc)[:200])
        record["teardown"] = supplemental_teardown(udid) if udid else {"complete": True, "simulator_created": False}
        record = finalize_supplemental(record, record["teardown"])
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
    common.add_argument("--idb-companion", default=COMPANION_PATH)
    for command, help_text in (("run", "the contained A/C/B proof"),
                               ("smoke", "enroll-only smoke: inc1 daemon, launch, enroll, snapshot, teardown"),
                               ("reduced", "reduced proof: smoke + list, one real show, member list, map page 1")):
        proof = sub.add_parser(command, parents=[common], help=help_text)
        proof.add_argument("--app", type=Path, required=True, help="normal Release simulator .app (loopback config)")
        proof.add_argument("--bundle-id", required=True)
        proof.add_argument("--production-config", type=Path, required=True,
                           help="`expo config --type public --json` of the production build (URLs to reject)")
        proof.add_argument("--v1-checkout", type=Path, required=True)
        proof.add_argument("--inc1-checkout", type=Path, required=True)
        proof.add_argument("--python", type=Path, required=True, help="owned venv python for both daemon pins")
        proof.add_argument("--proxy-source", type=Path, required=True, help="retained loopback proxy script")
        proof.add_argument("--run-id")
    extra = sub.add_parser("supplemental", parents=[common], help="one supplemental scene (separate build) through the shared admission path")
    extra.add_argument("--app", type=Path, required=True)
    extra.add_argument("--scene", choices=sorted(SCENES), required=True)
    extra.add_argument("--production-config", type=Path, required=True,
                       help="production public config .json; its operational URLs must be absent (shared admission)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse(argv)
    if args.command == "plan":
        print(json.dumps(plan(), indent=2))
        return 0
    if args.command == "supplemental":
        return supplemental(args)
    return Run(args).execute(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
