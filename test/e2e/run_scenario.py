#!/usr/bin/env python3
"""Execute the public simulator scenarios and publish one result with owned teardown."""
from __future__ import annotations

import argparse
import http.server
import importlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from urllib.parse import quote, quote_plus, urlencode, urlsplit
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from e2e.harness import scenario_simctl_command
from e2e.harness.asserts import EventSpec, Verdict, assert_no_events, await_event
from e2e.harness.log_capture import LogStream
from recorder_preflight import VideoRecorder


REPORT_MODULES = {
    "report_viewer_horizontal_scroll": "e2e.scenarios.report_viewer_horizontal_scroll",
    "report_viewer_runtime_sentinel": "e2e.scenarios.report_viewer_runtime_sentinel",
    "report_viewer_comments_keyboard": "e2e.scenarios.report_viewer_comments_keyboard",
}


class _CatalogDaemonRefusal(RuntimeError):
    def __init__(self, code, receipt=None):
        self.code, self.receipt = code, receipt or {}
        super().__init__("dashboard catalog daemon refused asset.get: " + code)


class _SecretMask:
    """Mask the launch credential before any runner-owned evidence is written."""
    def __init__(self, secret):
        forms = {secret, quote(secret, safe=""), quote_plus(secret)}
        frontier = set(forms)
        # Native NDJSON wraps the JSON telemetry in eventMessage: two escaping
        # layers, including platform ASCII/slash escape choices, reach raw logs.
        for _depth in range(2):
            encoded = {json.dumps(value, ensure_ascii=ascii_only)[1:-1]
                       for value in frontier for ascii_only in (False, True)}
            encoded |= {value.replace("/", "\\/") for value in encoded}
            forms.update(encoded)
            frontier = encoded
        self.forms = sorted(forms, key=len, reverse=True)

    def __call__(self, text):
        for value in self.forms:
            text = text.replace(value, "[REDACTED]")
        return text

    def value(self, value):
        """Sanitize decoded event/error/collector values before retention."""
        if isinstance(value, str):
            return self(value)
        if isinstance(value, dict):
            return {self(str(key)): self.value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.value(item) for item in value]
        return value


def _sanitize_command_result(result, mask):
    result.stdout = mask(result.stdout) if isinstance(result.stdout, str) else result.stdout
    result.stderr = mask(result.stderr) if isinstance(result.stderr, str) else result.stderr
    if hasattr(result, "args") and hasattr(mask, "value"):
        result.args = mask.value(result.args)
    return result


class _SecretSafeWriter:
    def __init__(self, output, mask):
        self.output, self.mask, self.pending = output, mask, ""
        self.keep = max(map(len, mask.forms)) - 1

    def write(self, text):
        # A log chunk can end in the middle of a token. Retain enough text to
        # redact it with the following chunk, before anything reaches disk.
        combined = self.mask(self.pending + text)
        split = max(0, len(combined) - self.keep)
        self.output.write(combined[:split])
        self.pending = combined[split:]
        return len(text)

    def flush(self):
        self.output.flush()

    def close(self):
        self.output.write(self.mask(self.pending))
        self.pending = ""
        self.output.close()


class _SecretSafeLogPath:
    def __init__(self, path, mask):
        self.path, self.mask = path, mask

    def open(self, *args, **kwargs):
        return _SecretSafeWriter(self.path.open(*args, **kwargs), self.mask)


def dashboard_catalog_inputs(config, *, internal_phase=False):
    """Validate fixture inputs without reading a credential or starting native work."""
    if "_dashboard_catalog_phase" in config and not internal_phase:
        raise ValueError("_dashboard_catalog_phase is reserved for the owned phase coordinator")
    raw_url = config.get("PENTACLE_DAEMON_WS_URL", "")
    try:
        parsed = urlsplit(raw_url)
        valid_url = (isinstance(raw_url, str) and not any(char.isspace() or char == "\0" for char in raw_url)
                     and parsed.scheme in {"ws", "wss"}
                     and parsed.hostname in {"127.0.0.1", "::1"}
                     and parsed.port is not None and 1 <= parsed.port <= 65535
                     and parsed.username is None and parsed.password is None
                     and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        valid_url = False
    if not valid_url:
        raise ValueError("dashboard_catalog requires an explicit loopback PENTACLE_DAEMON_WS_URL")
    spec_id = config.get("dashboard_catalog_spec_id", "")
    if not isinstance(spec_id, str) or not re.fullmatch(r"example__[a-z0-9_]+", spec_id):
        raise ValueError("dashboard_catalog_spec_id must name the seeded synthetic example__ catalog")
    token_file = config.get("daemon_token_file", "")
    if not isinstance(token_file, str) or not token_file or not Path(token_file).is_absolute():
        raise ValueError("daemon_token_file must name the existing absolute 0600 credential file")
    owner = config.get("daemon_token_owner_stream_id", "")
    if not isinstance(owner, str) or not re.fullmatch(r"(?:hostx|local):[A-Za-z0-9._-]{1,128}", owner):
        raise ValueError("daemon_token_owner_stream_id must supply the fixture token-issuance record's stream ID")
    if owner == "hostx:example-producer":
        raise ValueError("fixture app credential owner must differ from hostx:example-producer")
    if config.get("runtime_sentinel", "clean") != "clean":
        raise ValueError("dashboard_catalog does not accept report-viewer runtime sentinel modes")
    return {"ws_url": raw_url, "dashboard_catalog_spec_id": spec_id}


def _read_dashboard_token(config):
    # Only the real native execution path calls this function. No token is
    # generated, installed in SecureStore, echoed, or included in the report.
    descriptor = None
    try:
        descriptor = os.open(config["daemon_token_file"], os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("daemon_token_file must be an owned regular 0600 file")
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            descriptor = None
            token = source.read(65537).strip()
        if not token or len(token) > 65536 or any(char.isspace() for char in token) or "\0" in token:
            raise ValueError("daemon_token_file has an invalid credential format")
        return token
    except (OSError, UnicodeError):
        raise ValueError("daemon_token_file could not be read securely") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


class DashboardCatalogScenario:
    """Real app/daemon journey, separate from the fixed report-viewer plan."""
    name = "dashboard_catalog"
    SCENARIO_META = {"target_compat": {"simulator"}, "requires": ["real_fixture_daemon"]}
    latest = "example-report-20261007T1300Z"

    @staticmethod
    def actions(_config):
        return ["autoaccept_biometric"]

    @staticmethod
    def params(config):
        values = dashboard_catalog_inputs(config, internal_phase=True)
        if config.get("_dashboard_catalog_phase") == "unset":
            # An explicit empty override disables any baked Expo extra value.
            values["dashboard_catalog_spec_id"] = ""
        return values

    @staticmethod
    def _events(config, stream):
        return [event for event in stream.all_events()
                if event.data.get("scenario_run_id") == config["scenario_run_id"]
                and getattr(event, "native_pid", None) == config.get("_native_launch_pid")]

    def _stop_on_denial(self, config, stream):
        for event in self._events(config, stream):
            if (event.message == "harness:ui_trace" and event.data.get("kind") in {"dashboard_report_asset_get", "dashboard_catalog_asset_get"}) and event.data.get("status") == "error":
                code = event.data.get("error_code")
                if not isinstance(code, str) or not code:
                    raise RuntimeError("asset.get failed without its exact daemon error code")
                if not re.fullmatch(r"[a-z][a-z0-9_.]*", code):
                    raise RuntimeError("asset.get transport failed: " + code)
                raise _CatalogDaemonRefusal(code, {key: event.data.get(key) for key in
                    ["kind", "asset_id", "spec_id", "listed_stream_id", "request_stream_id"]})

    @staticmethod
    def _await_connection(config, stream):
        # Existing store telemetry has no run-id field. Bind it to this fresh
        # launch's verified native PID and post-arming receipt time instead.
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            transitions = [event for event in stream.all_events()
                           if event.message == "harness:ui_trace"
                           and event.data.get("kind") == "store_state_transition"
                           and getattr(event, "native_pid", None) == config["_native_launch_pid"]
                           and event.received_at >= config["_native_armed_at"]]
            current = transitions[-1] if transitions else None
            if (current and current.data.get("connected") is True
                    and current.data.get("connecting") is False
                    and current.data.get("has_hydrated") is True):
                return current
            time.sleep(.1)
        raise RuntimeError("real fixture daemon connection did not hydrate before dashboard entry")

    def _elements(self, config, stream):
        self._stop_on_denial(config, stream)
        result = subprocess.run(["idb", "ui", "describe-all", "--udid", config["SIMULATOR_UDID"], "--json"],
                                capture_output=True, text=True, timeout=20, check=False)
        config["trace"]("dashboard describe-all", result)
        if result.returncode:
            raise RuntimeError("native dashboard accessibility inspection failed")
        try:
            decoded = json.loads(result.stdout)
            elements = decoded if isinstance(decoded, list) else decoded.get("elements", [])
        except (ValueError, AttributeError):
            try:
                elements = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            except ValueError:
                raise RuntimeError("native dashboard accessibility output is malformed") from None
        self._stop_on_denial(config, stream)
        return [element for element in elements if isinstance(element, dict)]

    def _element(self, config, stream, identifier, text=None):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            for element in self._elements(config, stream):
                if identifier not in (element.get("AXIdentifier"), element.get("AXUniqueId")):
                    continue
                labels = " ".join(str(element.get(key) or "") for key in ["AXLabel", "AXValue", "label", "value"])
                if text is None or text in labels:
                    return element
            time.sleep(.2)
        raise RuntimeError("dashboard accessibility assertion missing: " + identifier + (" / " + text if text else ""))

    def _text(self, config, stream, text):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            for element in self._elements(config, stream):
                if text in " ".join(str(element.get(key) or "") for key in ["AXLabel", "AXValue", "label", "value"]):
                    return
            time.sleep(.2)
        raise RuntimeError("seeded report body did not render in native accessibility")

    def _tap(self, config, stream, identifier):
        element = self._selector_element(config, stream, identifier) if identifier.startswith("dashboard-selector-") else self._element(config, stream, identifier)
        frame = element.get("frame")
        if element.get("AXEnabled") is False or not isinstance(frame, dict) or not all(
                isinstance(frame.get(key), (int, float)) for key in ["x", "y", "width", "height"]):
            raise RuntimeError("native dashboard tap target is unavailable: " + identifier)
        result = subprocess.run(["idb", "ui", "tap", str(int(frame["x"] + frame["width"] / 2)),
                                 str(int(frame["y"] + frame["height"] / 2)), "--udid", config["SIMULATOR_UDID"]],
                                capture_output=True, text=True, timeout=20, check=False)
        config["trace"]("dashboard tap " + identifier, result)
        if result.returncode:
            raise RuntimeError("native dashboard tap failed: " + identifier)

    def _selector_element(self, config, stream, identifier):
        # Selectors live in a horizontal native ScrollView. Reveal offscreen
        # boards with an actual gesture rather than tapping beyond the display.
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            elements = self._elements(config, stream)
            frames = [(item, item.get("frame")) for item in elements]
            frames = [(item, frame) for item, frame in frames if isinstance(frame, dict)
                      and all(isinstance(frame.get(key), (int, float)) for key in ["x", "y", "width", "height"])]
            tabs = [frame for item, frame in frames if str(item.get("AXIdentifier") or item.get("AXUniqueId") or "").endswith("-tab-button")]
            width = max((frame["x"] + frame["width"] for frame in tabs), default=0)
            selectors = [(item, frame) for item, frame in frames
                         if str(item.get("AXIdentifier") or item.get("AXUniqueId") or "").startswith("dashboard-selector-")]
            target = next(((item, frame) for item, frame in selectors
                           if identifier in (item.get("AXIdentifier"), item.get("AXUniqueId"))), None)
            if width > 0 and target:
                item, frame = target
                left, right = max(14, frame["x"]), min(width - 14, frame["x"] + frame["width"])
                if right - left >= 20:
                    return {**item, "frame": {**frame, "x": left, "width": right - left}}
            if width > 0 and selectors:
                row = (target or selectors[0])[1]
                y = str(int(row["y"] + row["height"] / 2))
                start, end = (.15, .85) if target and target[1]["x"] < 14 else (.85, .15)
                result = subprocess.run(["idb", "ui", "swipe", str(int(width * start)), y,
                                         str(int(width * end)), y, "--duration", "0.4", "--udid", config["SIMULATOR_UDID"]],
                                        capture_output=True, text=True, timeout=20, check=False)
                config["trace"]("dashboard reveal selector " + identifier, result)
                if result.returncode:
                    raise RuntimeError("native dashboard selector gesture failed")
            time.sleep(.2)
        raise RuntimeError("native dashboard selector was not visible: " + identifier)

    def run(self, config, stream, cap=None):
        evidence = {"phase": config["_dashboard_catalog_phase"],
                    "credential_mechanism": "existing pentacle_token harness parameter (memory only)",
                    "credential_provenance": {"source": "fleet token-issuance record (supplied fixture precondition)",
                        "owner_stream_id": config["daemon_token_owner_stream_id"], "app_observed": False}}
        try:
            if evidence["phase"] == "configured":
                evidence["connection_ready"] = serialize_event(self._await_connection(config, stream))
            self._tap(config, stream, "dashboards-tab-button")
            if evidence["phase"] == "unset":
                self._element(config, stream, "dashboards-empty-state", "No dashboards yet")
                # Observe after the empty render as well; a late request is a failure.
                time.sleep(2.5)
                events = self._events(config, stream)
                if any((event.message == "harness:ui_trace" and str(event.data.get("kind", "")).startswith("dashboard_catalog_asset_")) for event in events):
                    raise RuntimeError("unset catalog issued an asset request")
                evidence["empty_state"] = "No dashboards yet"
                if cap:
                    cap.screenshot("catalog-unset")
                return Verdict(self.name, "PASS", extras=evidence).finish()
            self._element(config, stream, "dashboard-catalog-version", "0.2.0+aaaaaaa")
            self._tap(config, stream, "dashboard-selector-example-report")
            self._element(config, stream, "dashboard-report-latest", self.latest)
            self._text(config, stream, "Synthetic report " + self.latest + ".")
            if not any((event.message == "harness:ui_trace" and event.data.get("kind") == "dashboard_catalog_asset_list")
                       and event.data.get("spec_id") == config["dashboard_catalog_spec_id"]
                       for event in self._events(config, stream)):
                raise RuntimeError("actual configured catalog asset.list evidence is absent")
            gets = [event for event in self._events(config, stream)
                    if (event.message == "harness:ui_trace" and event.data.get("kind") == "dashboard_report_asset_get")
                    and event.data.get("status") == "ok"
                    and event.data.get("asset_id") == self.latest]
            if not gets:
                raise RuntimeError("app's actual cross-owner asset.get evidence is absent")
            got = gets[-1]
            if (got.data.get("listed_stream_id") != "hostx:example-producer"
                    or got.data.get("request_stream_id") != got.data.get("listed_stream_id")
                    or got.data.get("spec_id") != "example__dashboard_reports"):
                raise RuntimeError("asset.get did not use the listed report owner/spec")
            evidence["cross_owner_asset_get"] = serialize_event(got)
            evidence["latest"] = self.latest
            evidence["body_marker"] = "Synthetic report " + self.latest + "."
            if cap:
                cap.screenshot("catalog-report")
            for board in ["example-board", "example-hosted"]:
                self._tap(config, stream, "dashboard-selector-" + board)
                self._element(config, stream, "dashboard-board-unsupported-" + board, "Unsupported on this client")
                evidence[board] = "Unsupported on this client"
                if cap:
                    cap.screenshot("catalog-" + board)
            self._stop_on_denial(config, stream)
            return Verdict(self.name, "PASS", extras=evidence).finish()
        except _CatalogDaemonRefusal as exc:
            return Verdict(self.name, "FAIL", error=str(exc), extras={**evidence, "daemon_error_code": exc.code,
                "stopped_on_denial": True, "authorization_fallback": False, "failed_asset_get": exc.receipt}).finish()
        except Exception as exc:
            return Verdict(self.name, "FAIL", error=str(exc), extras=evidence).finish()


class QuestionContract:
    """Offline public scenario contract consumed by supplied-record tests only."""
    PROCEEDED_REPLY_TIMEOUT_S = 10
    def __init__(self, name):
        self.name = name
        self.await_event, self.assert_no_events = await_event, assert_no_events

    def run(self, config, stream, cap=None):
        from e2e.scenarios._question_evidence import rendered_noise_rows, proceeded_reply_row
        start = self.await_event(stream, EventSpec("harness:spawn_chat_then_send_sent", {"status": "ok"}))
        if not start:
            return Verdict(self.name, "FAIL", error="fixture send absent").finish()
        stream_id = start.data.get("stream_id")
        card = self.await_event(stream, EventSpec("question:card_rendered", {"stream_id": stream_id}), not_before=start.received_at)
        if not card:
            return Verdict(self.name, "FAIL", error="question card did not render").finish()
        if self.name.endswith("multi") and card.data.get("question_count", 0) < 2:
            return Verdict(self.name, "SETUP_FAIL", error="<2 questions in supplied fixture").finish()
        if self.name.endswith("note") and card.data.get("option_count", 0) < 3:
            return Verdict(self.name, "FAIL", error="fewer options than supplied contract").finish()
        answered = self.await_event(stream, EventSpec("harness:dismiss_question_sent", {"stream_id": stream_id}), not_before=card.received_at)
        if not answered:
            return Verdict(self.name, "FAIL", error="supplied answer evidence absent").finish()
        noise = rendered_noise_rows(stream, stream_id, card.received_at, answered.received_at)
        if noise:
            return Verdict(self.name, "FAIL", error="pending question noise rendered", extras={"noise_rows": [e.to_dict() for e in noise]}).finish()
        proceeded = proceeded_reply_row(stream, stream_id, answered.received_at, self.PROCEEDED_REPLY_TIMEOUT_S)
        if not proceeded:
            return Verdict(self.name, "FAIL", error="no harness:row_rendered assistant row after supplied answer").finish()
        result = Verdict(self.name, "PASS", extras={**card.data, "proceeded_row": dict(proceeded.data)})
        result.fold_negative_watch(self.assert_no_events(stream))
        return result.finish()


def build_scenarios(*, peer_hosts=None, reachability=None, codex_preflight=None):
    scenarios = {name: SimpleNamespace(module=importlib.import_module(module)) for name, module in REPORT_MODULES.items()}
    scenarios["dashboard_catalog"] = SimpleNamespace(module=DashboardCatalogScenario())
    for name in ["agent_question_multi", "agent_question_note"]:
        scenarios[name] = SimpleNamespace(module=QuestionContract(name))
    return scenarios


def read_env(path: Path):
    values = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError(f"malformed scenario env input at line {number}")
        value = match[2].strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f"malformed scenario env quote at line {number}")
            value = value[1:-1]
        if match[1] in values:
            raise ValueError(f"duplicate scenario env key at line {number}")
        values[match[1]] = value
    return values


def serialize_event(event):
    result = event.to_dict()
    result["native_process_id"] = getattr(event, "native_pid", None)
    return result


def resolve_pids(result, bundle):
    if result.returncode:
        raise RuntimeError("native launchctl process census failed")
    found = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0].isdigit() and re.search(r"(?:^|:)" + re.escape(bundle) + r"(?:\[|$)", parts[-1]):
            found.append(parts[0])
    return sorted(set(found))


def crash_signal(lines, pid):
    for line in lines:
        if re.search(r"(?<!\d)" + re.escape(pid) + r"(?!\d)", line) and re.search(r"SIGABRT|signal 6|Abort trap: 6", line):
            return {"verified": True, "signal": "SIGABRT", "pid": pid, "evidence": line.strip()}
    return None


def signal_owned_native(command, udid, bundle, pid, signal):
    """Signal the exact simulator launchd job resolved to the armed native PID."""
    if signal not in {"SIGTERM", "SIGABRT"} or not re.fullmatch(r"[1-9][0-9]*", str(pid)):
        raise RuntimeError("owned native signal identity invalid")
    listed = command("spawn", udid, "launchctl", "list")
    if resolve_pids(listed, bundle) != [pid]:
        raise RuntimeError("owned termination identity changed")
    labels = []
    for line in listed.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[0] == pid and re.search(r"(?:^|:)" + re.escape(bundle) + r"(?:\[|$)", parts[2]):
            labels.append(parts[2])
    if len(labels) != 1:
        raise RuntimeError("owned native signal job is not unique")
    service = "system/" + labels[0]
    killed = command("spawn", udid, "launchctl", "kill", signal, service)
    if killed.returncode:
        raise RuntimeError("owned native sentinel termination failed: " + killed.stderr)
    return {"signal": signal, "pid": pid, "service": service, "returncode": killed.returncode}


class NativeCapture:
    def __init__(self, config, runs_dir, stem):
        self.config, self.runs_dir, self.stem = config, runs_dir, stem
        self.screenshots = []

    def screenshot(self, label):
        name = self.stem + "-" + re.sub(r"[^A-Za-z0-9_.-]", "_", label) + ".png"
        result = subprocess.run(scenario_simctl_command("io", self.config["SIMULATOR_UDID"], "screenshot", str(self.runs_dir / name), config=self.config), capture_output=True, text=True, timeout=20, check=False)
        self.config["trace"]("screenshot", result)
        if result.returncode or not (self.runs_dir / name).is_file():
            raise RuntimeError("bound simulator screenshot failed")
        self.screenshots.append(name)


def record_cleanup_failure(result, message):
    if result.error and not result.extras.get("cleanup_failures"):
        result.extras["primary_failure"] = {"verdict": result.verdict, "error": result.error}
    result.extras.setdefault("cleanup_failures", []).append(message)
    result.verdict = "SETUP_FAIL"
    if not result.error:
        result.error = message


def _native_failure_result(name, result, error, monitor, mask):
    if result.extras.get("stopped_on_denial") and result.extras.get("daemon_error_code"):
        result.extras.setdefault("secondary_failures", []).append(mask(str(error)))
        return result
    return Verdict(name, "SETUP_FAIL", error=mask(str(error)),
                   extras={"runtime_monitor": monitor} if monitor else {})


def execute_dashboard_catalog(config, runs_dir, stem):
    """Own both cold launches; do not run the unset leg after a daemon denial."""
    dashboard_catalog_inputs(config)
    if any(runs_dir.glob(stem + "-configured*")) or any(runs_dir.glob(stem + "-unset*")):
        raise ValueError("dashboard catalog phase evidence already exists")
    phases, proofs, sidecars = [], [], []
    for phase in ["configured", "unset"]:
        phase_stem = stem + "-" + phase
        phase_config = {**config, "scenario_run_id": config["scenario_run_id"] + "-" + phase}
        payload, proof = execute_native("dashboard_catalog", phase_config, runs_dir, phase_stem, _catalog_phase=phase)
        payload["result"].setdefault("extras", {}).setdefault("phase", phase)
        phases.append(payload)
        proofs.append(proof)
        sidecar = phase_stem + ".case.json"
        with (runs_dir / sidecar).open("x", encoding="utf-8") as output:
            json.dump(payload, output, indent=2)
            output.write("\n")
        sidecars.append(sidecar)
        if payload["verdict"] != "PASS":
            break
    failure = next((phase for phase in phases if phase["verdict"] != "PASS"), None)
    result = Verdict("dashboard_catalog", failure["verdict"] if failure else "PASS",
        error=failure["result"].get("error") if failure else None,
        extras={"phases": [{"phase": phase["result"]["extras"].get("phase"),
                            "verdict": phase["verdict"], "result_sidecar": sidecar}
                           for phase, sidecar in zip(phases, sidecars)],
                "fixture": "externally seeded real public web-gate daemon; no mock fallback",
                "credential_provenance": {"source": "fleet token-issuance record (supplied fixture precondition)",
                    "owner_stream_id": config["daemon_token_owner_stream_id"], "report_owner_stream_id": "hostx:example-producer",
                    "app_observed": False},
                "credential_mechanism": "existing pentacle_token harness parameter (memory only)",
                **({key: value for key, value in failure["result"]["extras"].items()
                    if key in {"daemon_error_code", "stopped_on_denial", "authorization_fallback", "failed_asset_get"}} if failure else {})}).finish()
    closed = [identity for proof in proofs for identity in proof["closed"]]
    orphans = [identity for proof in proofs for identity in proof["orphans"]]
    return {"scenario": "dashboard_catalog", "verdict": result.verdict, "result": result.to_dict(),
            "all_events": [event for phase in phases for event in phase["all_events"]],
            "artifacts": {"case_results": sidecars}}, {
                "attempted": sum(proof["attempted"] for proof in proofs), "closed": closed,
                "closed_count": len(closed), "orphans": orphans, "orphan_count": len(orphans)}


DEFAULT_SIMULATOR_DEVICE_SET = Path.home() / "Library" / "Developer" / "CoreSimulator" / "Devices"


def require_idb_visible_device_set(config, environ=None):
    """idb resolves only the default device set; a private set needs the gate's IDB_COMPANION address."""
    environ = os.environ if environ is None else environ
    root = Path(config["PENTACLE_SCENARIO_DEVICE_SET_ROOT"])
    if os.path.realpath(root) != os.path.realpath(DEFAULT_SIMULATOR_DEVICE_SET) and not environ.get("IDB_COMPANION"):
        raise ValueError("dashboard_catalog idb inspection needs IDB_COMPANION for a non-default simulator device set")


def execute_native(name, config, runs_dir, stem, *, _catalog_phase=None):
    if name == "dashboard_catalog":
        dashboard_catalog_inputs(config)
        if _catalog_phase is None:
            return execute_dashboard_catalog(config, runs_dir, stem)
        if _catalog_phase not in {"configured", "unset"}:
            raise ValueError("invalid internal dashboard catalog phase")
        config = {**config, "_dashboard_catalog_phase": _catalog_phase}
    if name not in REPORT_MODULES and name != "dashboard_catalog":
        raise ValueError("only public report fixture and dashboard_catalog scenarios are executable here")
    if name == "dashboard_catalog":
        dashboard_catalog_inputs(config, internal_phase=True)
    udid = config.get("PENTACLE_GATE_BOUND_SIMULATOR_UDID") or config.get("PENTACLE_SIMULATOR_UDID")
    bundle = config.get("PENTACLE_GATE_BOUND_BUNDLE_ID") or config.get("PENTACLE_BUNDLE_ID")
    if not re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", udid or "") or not bundle:
        raise ValueError("exact bound simulator and bundle are required")
    simctl = scenario_simctl_command(config=config)
    if name == "dashboard_catalog":
        require_idb_visible_device_set(config)
    config["SIMULATOR_UDID"] = udid
    run_id, sentinel = config["scenario_run_id"], config.get("runtime_sentinel", "clean")
    module = DashboardCatalogScenario() if name == "dashboard_catalog" else importlib.import_module(REPORT_MODULES[name])
    credential_token = _read_dashboard_token(config) if name == "dashboard_catalog" else None
    mask = _SecretMask(credential_token) if credential_token else lambda value: value
    raw_name, trace_name = stem + ".log", stem + ".ui.jsonl"
    stream = LogStream(udid, _SecretSafeLogPath(runs_dir / raw_name, mask) if credential_token else runs_dir / raw_name,
                       bundle_id=bundle, config=config)
    if credential_token:
        native_feed_line = stream.feed_line
        stream.feed_line = lambda line: native_feed_line(mask(line))
    recorder = VideoRecorder(udid, runs_dir / (stem + ".mp4"), config=config)
    cap = NativeCapture(config, runs_dir, stem)
    trace_file = (runs_dir / trace_name).open("w", encoding="utf-8")
    def trace(action, result):
        trace_file.write(json.dumps({"action": mask(action), "at": time.time(), "returncode": result.returncode,
            "stdout": mask(result.stdout), "stderr": mask(result.stderr)}) + "\n")
        trace_file.flush()
    config["trace"] = trace
    def command(*args, env=None):
        try:
            result = subprocess.run([*simctl, *args], capture_output=True, text=True, timeout=30, check=False, env=env)
        except Exception as exc:
            if credential_token:
                raise RuntimeError(mask(str(exc))) from None
            raise
        if credential_token:
            result = _sanitize_command_result(result, mask)
        trace("simctl " + " ".join(args), result)
        return result
    def liveness():
        started = time.time()
        result = command("spawn", udid, "launchctl", "list")
        pids = resolve_pids(result, bundle)
        return {"checked_at": started, "completed_at": time.time(), "returncode": result.returncode,
            "stderr": result.stderr, "resolved_bundle_id": bundle, "resolved_pids": pids, "bundle_present": bool(pids)}
    launch_pid = None
    release_server = None
    release_ready, request_arrived = threading.Event(), threading.Event()
    result = Verdict(name, "SETUP_FAIL", error="native setup did not complete")
    teardown = {"attempted": 0, "closed": [], "closed_count": 0, "orphans": [], "orphan_count": 0}
    monitor = None
    video = None
    owned_signal = None
    try:
        # A running bundle belongs to another journey; the runner must not adopt or kill it.
        if liveness()["resolved_pids"]:
            raise RuntimeError("bound harness bundle already has a running process")
        stream.start()
        if not recorder.start():
            raise RuntimeError("case recorder did not become ready")
        if name == "report_viewer_runtime_sentinel" and sentinel == "fatal":
            token = uuid.uuid4().hex
            class ReleaseHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path != "/" + token:
                        self.send_error(404)
                        return
                    request_arrived.set()
                    if not release_ready.wait(20):
                        self.send_error(503)
                        return
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"released")
                def log_message(self, *_args):
                    pass
            release_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ReleaseHandler)
            threading.Thread(target=release_server.serve_forever, daemon=True).start()
            config["runtime_sentinel_release_url"] = f"http://127.0.0.1:{release_server.server_port}/{token}"
        query = {"scenario": name, "scenario_run_id": run_id, "actions": ",".join(module.actions(config)), **module.params(config)}
        if credential_token:
            query["pentacle_token"] = credential_token
        url = "pentacle://harness?" + urlencode(query)
        launched = command("launch", udid, bundle, "-HarnessUrl", url,
            env={**os.environ, "SIMCTL_CHILD_PENTACLE_ALLOW_HARNESS_LAUNCH_ARG": "1"})
        match = re.fullmatch(re.escape(bundle) + r":\s*(\d+)\s*", launched.stdout.strip())
        if launched.returncode or not match:
            raise RuntimeError("bound harness launch did not return its exact PID")
        launch_pid = match[1]
        config["_native_launch_pid"] = launch_pid
        teardown["attempted"] = 1
        armed = await_event(stream, EventSpec("harness:harness_armed", {"scenario_run_id": run_id, "scenario": name}, 20))
        before = liveness()
        if not armed or getattr(armed, "native_pid", None) != launch_pid or before["resolved_pids"] != [launch_pid]:
            raise RuntimeError("same-run arming did not verify the exact launched native PID")
        config["_native_armed_at"] = armed.received_at
        identity = {"verified": True, "bundle_id": bundle, "launch_pid": launch_pid,
            "armed_telemetry_pid": armed.native_pid, "pre_scenario_pids": before["resolved_pids"]}
        result = module.run(config, stream, cap)
        if name == "dashboard_catalog" and result.extras.get("stopped_on_denial"):
            # Preserve the exact denial and perform only owned teardown. Do not
            # take further UI steps, screenshots or start the unset phase.
            result.extras["runtime_monitor"] = {"process_identity": identity,
                "outcome": {"kind": "stopped_on_denial"}, "settle_s": 0}
        else:
            if name == "report_viewer_runtime_sentinel" and sentinel == "fatal":
                if not request_arrived.wait(10):
                    raise RuntimeError("fatal sentinel did not request its owned loopback release")
                release_ready.set()
            if name == "report_viewer_runtime_sentinel" and sentinel in {"crash_only", "liveness_loss"}:
                current = liveness()
                if current["resolved_pids"] != [launch_pid]:
                    raise RuntimeError("owned termination identity changed")
                owned_signal = signal_owned_native(command, udid, bundle, launch_pid,
                    "SIGABRT" if sentinel == "crash_only" else "SIGTERM")
            time.sleep(2.5)
            after = liveness()
            errors = [e for e in stream.all_events() if e.message == "harness:runtime_error" and e.data.get("scenario_run_id") == run_id and getattr(e, "native_pid", None) == launch_pid]
            signal_evidence = crash_signal(stream.lines, launch_pid)
            owned = sentinel if name == "report_viewer_runtime_sentinel" and sentinel in {"crash_only", "liveness_loss"} else None
            kind = "harness_owned_crash" if owned == "crash_only" else "harness_owned_termination" if owned == "liveness_loss" else "alive" if after["bundle_present"] else "unexpected_exit"
            monitor = {"settle_s": 2.5, "fresh_crash_report": None, "crash_exit_signal": signal_evidence,
                "liveness": after, "process_identity": identity, "outcome": {"kind": kind, "pids": after["resolved_pids"]}, "owned_termination": owned,
                "owned_signal": owned_signal}
            if sentinel == "fatal":
                released = [e for e in stream.all_events() if e.message == "harness:runtime_sentinel_released" and e.data.get("scenario_run_id") == run_id and e.data.get("sentinel") == sentinel and getattr(e, "native_pid", None) == launch_pid]
                fatal = [e for e in errors if e.data.get("source") == "uncaught" and e.data.get("fatal") is True]
                monitor["post_identity_release"] = {"verified": bool(released and request_arrived.is_set() and release_ready.is_set()), "transport": "loopback_ack", "sentinel": sentinel, "scenario_run_id": run_id, "telemetry_pid": launch_pid}
                monitor["fatal_runtime_error_identity"] = {"verified": bool(fatal), "sentinel": sentinel, "scenario_run_id": run_id, "telemetry_pid": launch_pid}
            result.extras["runtime_monitor"] = monitor
            if errors or not after["bundle_present"]:
                result.verdict, result.error = "FAIL", "observed native runtime error or process exit"
            cap.screenshot("settled")
    except Exception as exc:
        result = _native_failure_result(name, result, exc, monitor, mask)
    finally:
        if release_server:
            release_ready.set()
            release_server.shutdown()
            release_server.server_close()
        if launch_pid:
            try:
                current = liveness()["resolved_pids"]
                if current == [launch_pid]:
                    stopped = command("terminate", udid, bundle)
                    if stopped.returncode:
                        raise RuntimeError("owned app termination failed")
                    deadline = time.monotonic() + 5
                    while liveness()["resolved_pids"] == [launch_pid] and time.monotonic() < deadline:
                        time.sleep(.1)
                if launch_pid in liveness()["resolved_pids"]:
                    raise RuntimeError("owned app survived teardown")
                teardown["closed"].append(f"native:{udid}:{launch_pid}")
            except Exception as exc:
                teardown["orphans"].append(f"native:{udid}:{launch_pid}")
                record_cleanup_failure(result, str(exc))
        if recorder.process:
            try:
                video = recorder.stop()
                if not video.get("video_finalized") or video.get("video_alive_after_teardown") or video.get("video_forced_kill"):
                    record_cleanup_failure(result, "case recorder teardown failed")
            except Exception as exc:
                record_cleanup_failure(result, "case recorder teardown failed: " + mask(str(exc)))
        try:
            stream.close()
        except Exception as exc:
            record_cleanup_failure(result, str(exc))
        try:
            trace_file.close()
        except Exception as exc:
            record_cleanup_failure(result, "UI trace close failed: " + mask(str(exc)))
        teardown.update(closed_count=len(teardown["closed"]), orphan_count=len(teardown["orphans"]))
    result.finish()
    payload = {"scenario": name, "verdict": result.verdict, "result": result.to_dict(),
        "all_events": [serialize_event(event) for event in stream.all_events()],
        "extras": {"screen_capture": video}, "artifacts": {"video": stem + ".mp4" if video else None, "screenshots": cap.screenshots},
        "raw_log_sidecar": raw_name, "ui_trace_sidecar": trace_name}
    if credential_token:
        payload, teardown = mask.value(payload), mask.value(teardown)
    return payload, teardown


def main(argv=None, *, execute=execute_native):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario")
    parser.add_argument("--runs-dir", type=Path, default=Path(__file__).parent / "runs")
    parser.add_argument("--env-file", type=Path, default=Path.home() / ".pentacle-test.env")
    args = parser.parse_args(argv)
    args.runs_dir.mkdir(parents=True, exist_ok=True)
    run_id = os.environ.get("PENTACLE_RUN_ID") or str(uuid.uuid4())
    stem = re.sub(r"[^A-Za-z0-9_.-]", "_", run_id)
    result_path = args.runs_dir / (stem + ".json")
    teardown_path = args.runs_dir / (stem + ".teardown.json")
    if result_path.exists() or teardown_path.exists():
        raise ValueError("scenario result identity already exists")
    proof = {"attempted": 0, "closed": [], "closed_count": 0, "orphans": [], "orphan_count": 0}
    try:
        config = read_env(args.env_file)
        config.update({key: value for key, value in os.environ.items() if key.startswith("PENTACLE_")})
        config.update(scenario_run_id=run_id, runtime_sentinel=os.environ.get("PENTACLE_RUNTIME_SENTINEL", "clean"), env_file=str(args.env_file))
        payload, proof = execute(args.scenario, config, args.runs_dir, stem)
    except Exception as exc:
        result = Verdict(args.scenario, "SETUP_FAIL", error=str(exc)).finish()
        payload = {"scenario": args.scenario, "verdict": result.verdict, "result": result.to_dict(), "all_events": []}
    payload["owned_session_teardown_sidecar"] = teardown_path.name
    teardown_path.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    with result_path.open("x", encoding="utf-8") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")
    print(json.dumps({"scenario": args.scenario, "verdict": payload["verdict"], "result": str(result_path)}))
    return 0 if payload["verdict"] == "PASS" else 4 if payload["verdict"] == "SETUP_FAIL" else 1


if __name__ == "__main__":
    raise SystemExit(main())
