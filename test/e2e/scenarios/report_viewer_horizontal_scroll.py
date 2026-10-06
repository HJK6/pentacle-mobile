"""Drive the public report fixture through native accessibility and scroll telemetry."""
from __future__ import annotations
import json
import subprocess
import time
from ..harness.asserts import EventSpec, Verdict, await_event

name = "report_viewer_horizontal_scroll"
SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}


def actions(_config):
    return ["autoaccept_biometric", "open_report_viewer"]


def params(_config):
    return {}


def accessible_frame(elements, identifier, require_enabled=False):
    # Prefer the declared identifier across all elements before considering aliases.
    for key in ["AXIdentifier", "AXUniqueId"]:
        for element in elements:
            if element.get(key) == identifier and not (require_enabled and element.get("AXEnabled") is False):
                frame = element.get("frame")
                if isinstance(frame, dict) and all(isinstance(frame.get(k), (int, float)) for k in ["x", "y", "width", "height"]):
                    return frame
    return None


def _poll_element_frames(udid, identifiers, timeout_s=10, *, trace=None, require_all=True):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() <= deadline:
        result = subprocess.run(["idb", "ui", "describe-all", "--udid", udid, "--json"], capture_output=True, text=True, timeout=20, check=False)
        if trace:
            trace("describe-all", result)
        try:
            decoded = json.loads(result.stdout)
            elements = decoded if isinstance(decoded, list) else decoded.get("elements", [])
        except ValueError:
            try:
                # The installed public idb CLI emits one JSON object per element.
                elements = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            except ValueError:
                elements = []
        frames = {identifier: frame for identifier in identifiers if (frame := accessible_frame(elements, identifier))}
        if result.returncode == 0 and (len(frames) == len(identifiers) if require_all else bool(frames)):
            return frames
        time.sleep(0.2)
    return {}


def swipe(config, frame):
    x, y, w, h = (frame[k] for k in ["x", "y", "width", "height"])
    result = subprocess.run(["idb", "ui", "swipe", str(int(x + w * .85)), str(int(y + h / 2)),
        str(int(x + w * .15)), str(int(y + h / 2)), "--duration", "0.5", "--udid", config["SIMULATOR_UDID"]], capture_output=True, text=True, timeout=20, check=False)
    config["trace"]("swipe", result)
    if result.returncode:
        raise RuntimeError(result.stderr or "native swipe failed")


def _await_qualified_scroll(stream, where, cutoff):
    # A native animation starts with small offsets. Qualify the movement while
    # waiting under one deadline, rather than judging its first sample.
    deadline = time.monotonic() + 10

    def qualifies(event):
        return event is not None and event.message == "report:table_scrolled" \
            and cutoff <= event.received_at <= deadline \
            and all(event.data.get(key) == value for key, value in where.items()) \
            and event.data.get("offset_x", 0) > 20

    for event in stream.all_events():
        if time.monotonic() > deadline:
            return None
        if qualifies(event):
            return event
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(.5, deadline - time.monotonic()))
        if time.monotonic() > deadline:
            return None
        if qualifies(event):
            return event
    return None


def run(config, stream, cap=None):
    run_id = config["scenario_run_id"]
    where = {"scenario_run_id": run_id, "block_id": f"wide-matrix--{run_id}"}
    ready = await_event(stream, EventSpec("harness:report_viewer_ready", {"scenario_run_id": run_id}, 20))
    metrics = await_event(stream, EventSpec("report:table_metrics", where, 20))
    if not ready or not metrics or metrics.data.get("content_width", 0) <= metrics.data.get("viewport_width", 0):
        return Verdict(name, "FAIL", error="wide report fixture did not render overflow metrics").finish()
    frames = _poll_element_frames(config["SIMULATOR_UDID"], [f"report-table-scroll-wide-matrix--{run_id}"], trace=config["trace"])
    if not frames:
        return Verdict(name, "FAIL", error="report table accessibility target absent").finish()
    cutoff = time.monotonic()
    swipe(config, next(iter(frames.values())))
    moved = _await_qualified_scroll(stream, where, cutoff)
    if cap:
        cap.screenshot("scrolled")
    passed = moved is not None and moved.data.get("offset_x", 0) > 20
    return Verdict(name, "PASS" if passed else "FAIL", error=None if passed else "native gesture did not scroll the report table", extras={"metrics": metrics.to_dict(), "scrolled": moved.to_dict() if moved else None}).finish()
