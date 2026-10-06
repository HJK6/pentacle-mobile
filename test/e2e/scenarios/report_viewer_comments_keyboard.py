"""Add a comment to the local report fixture using the actual native keyboard."""
from __future__ import annotations
import hashlib
import subprocess
from .report_viewer_horizontal_scroll import accessible_frame, _poll_element_frames
from ..harness.asserts import EventSpec, Verdict, await_event

name = "report_viewer_comments_keyboard"
SCENARIO_META = {"target_compat": {"simulator"}, "requires": ["real_keyboard"]}


def actions(_config):
    return ["autoaccept_biometric", "open_report_viewer"]


def params(_config):
    return {}


def comment_body(run_id):
    return str(int(hashlib.sha256(run_id.encode()).hexdigest()[:12], 16))


def run(config, stream, cap=None):
    run_id, udid = config["scenario_run_id"], config["SIMULATOR_UDID"]
    ready = await_event(stream, EventSpec("harness:report_viewer_ready", {"scenario_run_id": run_id}, 20))
    if not ready:
        return Verdict(name, "FAIL", error="report fixture not ready").finish()
    def invoke(*args):
        result = subprocess.run(["idb", "ui", *args, "--udid", udid], capture_output=True, text=True, timeout=20, check=False)
        config["trace"](" ".join(args), result)
        if result.returncode:
            raise RuntimeError(result.stderr or "native keyboard action failed")
    def tap(identifier):
        frames = _poll_element_frames(udid, [identifier], trace=config["trace"])
        if not frames:
            raise RuntimeError(f"missing accessibility target {identifier}")
        frame = frames[identifier]
        invoke("tap", str(int(frame["x"] + frame["width"] / 2)), str(int(frame["y"] + frame["height"] / 2)))
    tap(f"report-block-comment-target--{run_id}")
    tap("report-comment-input")
    keyboard = await_event(stream, EventSpec("report:comment_keyboard", {"scenario_run_id": run_id, "unobscured": True}, 10))
    if cap and keyboard:
        cap.screenshot("keyboard")
    body = comment_body(run_id)
    invoke("text", body)
    tap("report-comment-send")
    confirmed = await_event(stream, EventSpec("report:comment_confirmed", {"scenario_run_id": run_id, "body": body}, 10))
    if cap:
        cap.screenshot("comment")
    passed = keyboard is not None and confirmed is not None
    return Verdict(name, "PASS" if passed else "FAIL", error=None if passed else "native comment/keyboard telemetry absent", extras={"comment_body": body, "confirmed": confirmed.to_dict() if confirmed else None}).finish()
