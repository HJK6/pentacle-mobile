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
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from urllib.parse import urlencode
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


def execute_native(name, config, runs_dir, stem):
    if name not in REPORT_MODULES:
        raise ValueError("only public report fixture scenarios are executable here")
    udid = config.get("PENTACLE_GATE_BOUND_SIMULATOR_UDID") or config.get("PENTACLE_SIMULATOR_UDID")
    bundle = config.get("PENTACLE_GATE_BOUND_BUNDLE_ID") or config.get("PENTACLE_BUNDLE_ID")
    if not re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", udid or "") or not bundle:
        raise ValueError("exact bound simulator and bundle are required")
    simctl = scenario_simctl_command(config=config)
    config["SIMULATOR_UDID"] = udid
    run_id, sentinel = config["scenario_run_id"], config.get("runtime_sentinel", "clean")
    module = importlib.import_module(REPORT_MODULES[name])
    raw_name, trace_name = stem + ".log", stem + ".ui.jsonl"
    stream = LogStream(udid, runs_dir / raw_name, bundle_id=bundle, config=config)
    recorder = VideoRecorder(udid, runs_dir / (stem + ".mp4"), config=config)
    cap = NativeCapture(config, runs_dir, stem)
    trace_file = (runs_dir / trace_name).open("w", encoding="utf-8")
    def trace(action, result):
        trace_file.write(json.dumps({"action": action, "at": time.time(), "returncode": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr}) + "\n")
        trace_file.flush()
    config["trace"] = trace
    def command(*args):
        result = subprocess.run([*simctl, *args], capture_output=True, text=True, timeout=30, check=False)
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
        url = "pentacle://harness?" + urlencode(query)
        launched = command("launch", udid, bundle, "-PentacleHarnessURL", url)
        match = re.fullmatch(re.escape(bundle) + r":\s*(\d+)\s*", launched.stdout.strip())
        if launched.returncode or not match:
            raise RuntimeError("bound harness launch did not return its exact PID")
        launch_pid = match[1]
        teardown["attempted"] = 1
        armed = await_event(stream, EventSpec("harness:harness_armed", {"scenario_run_id": run_id, "scenario": name}, 20))
        before = liveness()
        if not armed or getattr(armed, "native_pid", None) != launch_pid or before["resolved_pids"] != [launch_pid]:
            raise RuntimeError("same-run arming did not verify the exact launched native PID")
        identity = {"verified": True, "bundle_id": bundle, "launch_pid": launch_pid,
            "armed_telemetry_pid": armed.native_pid, "pre_scenario_pids": before["resolved_pids"]}
        result = module.run(config, stream, cap)
        if name == "report_viewer_runtime_sentinel" and sentinel == "fatal":
            if not request_arrived.wait(10):
                raise RuntimeError("fatal sentinel did not request its owned loopback release")
            release_ready.set()
        if name == "report_viewer_runtime_sentinel" and sentinel in {"crash_only", "liveness_loss"}:
            current = liveness()
            if current["resolved_pids"] != [launch_pid]:
                raise RuntimeError("owned termination identity changed")
            killed = command("spawn", udid, "kill", "-ABRT" if sentinel == "crash_only" else "-TERM", launch_pid)
            if killed.returncode:
                raise RuntimeError("owned native sentinel termination failed")
        time.sleep(2.5)
        after = liveness()
        errors = [e for e in stream.all_events() if e.message == "harness:runtime_error" and e.data.get("scenario_run_id") == run_id and getattr(e, "native_pid", None) == launch_pid]
        signal_evidence = crash_signal(stream.lines, launch_pid)
        owned = sentinel if name == "report_viewer_runtime_sentinel" and sentinel in {"crash_only", "liveness_loss"} else None
        kind = "harness_owned_crash" if owned == "crash_only" else "harness_owned_termination" if owned == "liveness_loss" else "alive" if after["bundle_present"] else "unexpected_exit"
        monitor = {"settle_s": 2.5, "fresh_crash_report": None, "crash_exit_signal": signal_evidence,
            "liveness": after, "process_identity": identity, "outcome": {"kind": kind, "pids": after["resolved_pids"]}, "owned_termination": owned}
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
        result = Verdict(name, "SETUP_FAIL", error=str(exc), extras={"runtime_monitor": monitor} if monitor else {})
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
                result.verdict, result.error = "SETUP_FAIL", str(exc)
        if recorder.process:
            video = recorder.stop()
            if not video.get("video_finalized") or video.get("video_alive_after_teardown") or video.get("video_forced_kill"):
                result.verdict, result.error = "SETUP_FAIL", "case recorder teardown failed"
        try:
            stream.close()
        except Exception as exc:
            result.verdict, result.error = "SETUP_FAIL", str(exc)
        trace_file.close()
        teardown.update(closed_count=len(teardown["closed"]), orphan_count=len(teardown["orphans"]))
    result.finish()
    payload = {"scenario": name, "verdict": result.verdict, "result": result.to_dict(),
        "all_events": [serialize_event(event) for event in stream.all_events()],
        "extras": {"screen_capture": video}, "artifacts": {"video": stem + ".mp4" if video else None, "screenshots": cap.screenshots},
        "raw_log_sidecar": raw_name, "ui_trace_sidecar": trace_name}
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
