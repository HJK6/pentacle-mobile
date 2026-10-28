"""Bounded load-responsiveness check for the operator's session list.

During a paced multi-stream chat burst from the public mock daemon, real taps
open and close the assistant sessions drawer (the product successor of All
Chats) and every injected event must reach JS ingestion. The claim is sampled
responsiveness at the probe instants only, never continuous absence of freezes.
A control mode arms a harness-only JS stall to prove the probe detects one.
"""
from __future__ import annotations

import math
import re
import threading
import time
from urllib.parse import urlsplit

from ..harness.asserts import EventSpec, Verdict, await_event

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

name = "all_chats_load"
HOST = "mock-host"
PROVIDER = "codex"
SESSION_COUNT = 8
BURST_STREAM_IDS = tuple(f"{HOST}:sample-{index:02d}" for index in range(SESSION_COUNT))
WITNESS_STREAM_ID = f"{HOST}:sample-04"
TRIGGER_STREAM_ID = f"{HOST}:stall-trigger"
TRIGGER_SEQ = 1
DEFAULT_ASSISTANT_STREAM_ID = "home:assistant"
EVENTS_PER_STREAM = 40
BURST_EVENT_COUNT = SESSION_COUNT * EVENTS_PER_STREAM
# Aggregate 10 Hz: the sustained cadence mock_composite_chat_load validated;
# this measures UI responsiveness under live delivery, not a transport backlog.
FRAME_INTERVAL_MS = 100
TEXT_SEGMENT = "synthetic live burst segment "
TRANSITION_BOUND_MS = 2000
TRANSITION_TIMEOUT_MS = 8000
MIN_BURST_CYCLES = 6
DELIVERY_GRACE_S = 10
STALL_MS = 5000
STALL_BEGIN_WAIT_S = 3.0
POLL_INTERVAL_S = 0.05
CLAIM = "sampled responsiveness at probe instants; not continuous"
MODES = {"normal", "stall_control"}
SESSIONS_LABEL = re.compile(r"Sessions, \d+ need you")
PANEL_ID = "assistant-drawer-panel"
SCRIM_LABEL = "Close sessions"


def mode(config: dict) -> str:
    value = str(config.get("PENTACLE_ALL_CHATS_MODE") or "normal").strip()
    if value not in MODES:
        raise ValueError(f"PENTACLE_ALL_CHATS_MODE must be normal or stall_control, got {value!r}")
    return value


def actions(config: dict) -> list[str]:
    # The standard cold-launch unblockers: the mock daemon issues no operator
    # credential, so the app connects only with disable_pentacle_auth.
    base = ["autoaccept_biometric", "disable_pentacle_auth"]
    return base + (["chat_list_js_stall"] if mode(config) == "stall_control" else [])


def fixture_url(config: dict) -> str:
    url = str(config.get("ws_url") or "")
    parsed = urlsplit(url)
    if (parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("all_chats_load requires an explicit loopback mock URL")
    return url


def params(config: dict) -> dict[str, str]:
    values = {
        "host": HOST,
        "provider": PROVIDER,
        "stream_id": BURST_STREAM_IDS[0],
        "active_stream_ids": ",".join(BURST_STREAM_IDS),
        "ws_url": fixture_url(config),
        "scenario_run_id": str(config.get("scenario_run_id") or ""),
    }
    if mode(config) == "stall_control":
        values.update({
            "chat_list_js_stall_stream_id": TRIGGER_STREAM_ID,
            "chat_list_js_stall_seq": str(TRIGGER_SEQ),
            "chat_list_js_stall_ms": str(STALL_MS),
        })
    return values


def preflight(config: dict, repo_root=None) -> str | None:
    del repo_root
    try:
        mode(config)
        fixture_url(config)
    except ValueError as exc:
        return str(exc)
    return None


def _session(stream_id: str, title: str) -> dict:
    host, session_name = stream_id.split(":", 1)
    return {"stream_id": stream_id, "host": host, "provider": PROVIDER, "session_name": session_name,
            "title": title, "online": True}


def build_snapshot(config: dict) -> dict:
    assistant = str(config.get("PENTACLE_ASSISTANT_STREAM_ID") or DEFAULT_ASSISTANT_STREAM_ID)
    sessions = [_session(stream_id, f"Chat sample {index:02d}") for index, stream_id in enumerate(BURST_STREAM_IDS)]
    sessions.append(_session(TRIGGER_STREAM_ID, "Stall trigger"))
    sessions.append(_session(assistant, "Assistant"))
    return {"sessions": sessions, "events": []}


def _event(stream_id: str, seq: int, ordinal: int) -> dict:
    host, session_name = stream_id.split(":", 1)
    return {"stream_id": stream_id, "host": host, "provider": PROVIDER, "session_name": session_name,
            "kind": "ASSIST", "daemon_seq": seq,
            "timestamp": f"2026-01-01T00:{ordinal // 60:02d}:{ordinal % 60:02d}Z",
            "text": f"burst {stream_id} #{seq:03d} " + TEXT_SEGMENT * 13 + f"end-{ordinal:04d}"}


def build_burst() -> list[dict]:
    frames = []
    for ordinal in range(BURST_EVENT_COUNT):
        stream_id = BURST_STREAM_IDS[ordinal % SESSION_COUNT]
        frames.append({**_event(stream_id, ordinal // SESSION_COUNT + 1, ordinal), "at_ms": ordinal * FRAME_INTERVAL_MS})
    return frames


def trigger_event() -> dict:
    return _event(TRIGGER_STREAM_ID, TRIGGER_SEQ, BURST_EVENT_COUNT)


def run_injector(control, frames, *, interval_s=FRAME_INTERVAL_MS / 1000, clock=time.monotonic, sleep=time.sleep,
                 progress=None) -> dict:
    """Send each frame at its schedule, keeping at least `interval_s` between
    sends: a late acknowledgement accrues lateness, never a catch-up burst."""
    record = {"frames": [], "first_send_mono": None, "last_ack_mono": None, "error": None}
    started = clock()
    last_send = None
    for index, frame in enumerate(frames):
        scheduled = started + index * interval_s
        due = scheduled if last_send is None else max(scheduled, last_send + interval_s)
        wait = due - clock()
        if wait > 0:
            sleep(wait)
        sent = last_send = clock()
        if record["first_send_mono"] is None:
            record["first_send_mono"] = sent
        event = {key: value for key, value in frame.items() if key != "at_ms"}
        row = {"stream_id": event["stream_id"], "seq": event["daemon_seq"], "sent_mono": sent,
               "lateness_ms": round((sent - scheduled) * 1000, 3), "acked": False}
        record["frames"].append(row)
        try:
            control.rpc("debug_replay_event", expected_stream_id=event["stream_id"], event=event)
        except Exception as exc:  # noqa: BLE001 - recorded as setup evidence
            record["error"] = str(exc)
            break
        row["acked"] = True
        record["last_ack_mono"] = clock()
        if progress:
            progress(index + 1)
    return record


# ---- native probe ------------------------------------------------------------

def _frame(element) -> dict | None:
    frame = element.get("frame") if isinstance(element, dict) else None
    if isinstance(frame, dict) and all(isinstance(frame.get(k), (int, float)) for k in ("x", "y", "width", "height")):
        return frame
    return None


def _ident(element) -> str:
    return str(element.get("AXIdentifier") or element.get("AXUniqueId") or "")


def _find(elements, *, identifier=None, label=None) -> list[dict]:
    found = []
    for element in elements:
        if identifier is not None and _ident(element) != identifier:
            continue
        if label is not None:
            text = str(element.get("AXLabel") or "")
            if not (label.fullmatch(text) if isinstance(label, re.Pattern) else text == label):
                continue
        if _frame(element) and _frame(element)["width"] > 0 and _frame(element)["height"] > 0:
            found.append(element)
    return found


def _panel_open(elements) -> bool:
    return bool(_find(elements, identifier=PANEL_ID))


def _centre(frame) -> tuple[int, int]:
    return int(frame["x"] + frame["width"] / 2), int(frame["y"] + frame["height"] / 2)


def _open_target(elements) -> tuple[int, int] | None:
    buttons = _find(elements, label=SESSIONS_LABEL)
    return _centre(_frame(buttons[0])) if len(buttons) == 1 else None


def _close_target(ui, elements) -> tuple[int, int] | None:
    roots = [_frame(e) for e in elements if e.get("role") == "AXApplication" and _frame(e)]
    panels = _find(elements, identifier=PANEL_ID)
    if len(roots) != 1 or len(panels) != 1:
        return None
    root, panel = roots[0], _frame(panels[0])
    left_x, right_x = panel["x"] + panel["width"], root["x"] + root["width"]
    if right_x - left_x < 20:
        return None
    point = int((left_x + right_x) / 2), int(root["y"] + root["height"] / 2)
    hit = ui.describe_point(*point)
    return point if isinstance(hit, dict) and hit.get("AXLabel") == SCRIM_LABEL else None


def _transition(ui, kind, *, mono, wall, sleep, require_rows=()) -> tuple[dict, list]:
    want_open = kind == "open"
    elements = ui.elements()
    record = {"kind": kind, "tap_started_mono": None, "tap_started_wall": None, "observed_mono": None,
              "latency_ms": None, "outcome": "pre_state", "pre_state_ok": _panel_open(elements) != want_open,
              "polls": 0, "describe_ms": []}
    if not record["pre_state_ok"]:
        return record, elements
    target = _open_target(elements) if want_open else _close_target(ui, elements)
    if target is None:
        record["outcome"] = "target_missing"
        return record, elements
    record["tap_started_mono"], record["tap_started_wall"] = mono(), wall()
    ui.tap_point(*target)
    deadline = record["tap_started_mono"] + TRANSITION_TIMEOUT_MS / 1000
    record["outcome"] = "timeout"
    while mono() < deadline:
        before = mono()
        elements = ui.elements()
        after = mono()
        record["polls"] += 1
        record["describe_ms"].append(round((after - before) * 1000, 1))
        rows_ready = all(_find(elements, identifier=f"assistant-drawer-row-{row}") for row in require_rows)
        if _panel_open(elements) == want_open and (not want_open or rows_ready):
            # Conservative upper bound: the observing describe-all has returned.
            record["observed_mono"], record["outcome"] = after, "observed"
            record["latency_ms"] = round((after - record["tap_started_mono"]) * 1000, 1)
            break
        sleep(POLL_INTERVAL_S)
    return record, elements


def probe_cycle(ui, *, mono=time.monotonic, wall=time.time, sleep=time.sleep, require_rows=(WITNESS_STREAM_ID,)) -> dict:
    """Open then close the real drawer. Both responses need JS to commit."""
    cycle = {"started_mono": mono(), "transitions": [], "rows_present": []}
    opened, elements = _transition(ui, "open", mono=mono, wall=wall, sleep=sleep, require_rows=require_rows)
    cycle["transitions"].append(opened)
    if opened["outcome"] != "observed":
        return cycle
    cycle["rows_present"] = [s for s in BURST_STREAM_IDS if _find(elements, identifier=f"assistant-drawer-row-{s}")]
    closed, _ = _transition(ui, "close", mono=mono, wall=wall, sleep=sleep)
    cycle["transitions"].append(closed)
    ui.check_foreground()
    return cycle


# ---- evidence ----------------------------------------------------------------

def received_identities(events) -> list[tuple[str, int]]:
    found = []
    for event in events:
        if getattr(event, "message", "") != "chat:event_received":
            continue
        data = getattr(event, "data", {}) or {}
        try:
            seq = int(data.get("seq"))
        except (TypeError, ValueError):
            continue
        if data.get("stream_id"):
            found.append((str(data["stream_id"]), seq))
    return found


def stall_window(events, *, mono_to_wall) -> dict | None:
    """Stall traces carry the device wall clock (`Date.now()`); a simulator
    shares the host clock, so taps (host `time.time()`) compare directly.
    `skew_s` records host receipt minus device emit for the begin trace."""
    marks = {}
    for event in events:
        data = getattr(event, "data", {}) or {}
        if getattr(event, "message", "") == "harness:ui_trace" and data.get("kind") in {
                "chat_list_js_stall_begin", "chat_list_js_stall_end"} and data["kind"] not in marks:
            marks[data["kind"]] = (event, data)
    if set(marks) != {"chat_list_js_stall_begin", "chat_list_js_stall_end"}:
        return None
    begin_event, begin = marks["chat_list_js_stall_begin"]
    _end_event, end = marks["chat_list_js_stall_end"]
    begin_wall = float(begin["timestamp_emitter_wall"]) / 1000
    return {"begin_wall": begin_wall, "end_wall": float(end["timestamp_emitter_wall"]) / 1000,
            "stall_ms": int(begin.get("stall_ms") or 0),
            "skew_s": round(mono_to_wall(begin_event.received_at) - begin_wall, 3)}


def _p(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)] if ordered else None


def evaluate(evidence: dict) -> tuple[str, list[str], dict]:
    setup, failures = list(evidence.get("setup_errors") or []), []
    frames = evidence.get("frames") or []
    if not (evidence.get("baseline") or {}).get("ok"):
        setup.append("baseline_failed")
    if len(frames) < int(evidence.get("expected_count") or BURST_EVENT_COUNT) or not all(f.get("acked") for f in frames):
        setup.append("burst_not_acked")
    start, end = evidence.get("first_send_mono"), evidence.get("last_ack_mono")
    transitions = [t for c in evidence.get("cycles") or [] for t in c["transitions"]]
    in_window = [c for c in evidence.get("cycles") or []
                 if start is not None and end is not None and start <= c["started_mono"] <= end]
    if any(not t.get("pre_state_ok") or t.get("outcome") == "target_missing" for t in transitions):
        failures.append("responsiveness_invalid")
    if any(t.get("outcome") == "observed" and t["latency_ms"] > TRANSITION_BOUND_MS for t in transitions):
        failures.append("responsiveness_bound")
    if any(t.get("outcome") == "timeout" for t in transitions):
        failures.append("responsiveness_timeout")
    complete = [c for c in in_window if len(c["transitions"]) == 2 and all(t["outcome"] == "observed" for t in c["transitions"])]
    thirds = set()
    if start is not None and end is not None and end > start:
        thirds = {min(2, int(3 * (c["started_mono"] - start) / (end - start))) for c in in_window}
    if len(complete) < MIN_BURST_CYCLES or thirds != {0, 1, 2}:
        failures.append("probe_coverage")
    expected = {(f["stream_id"], int(f["seq"])) for f in frames}
    delivered = set(evidence.get("received") or []) & expected
    if delivered != expected:
        failures.append("delivery_missing")
    latencies = [t["latency_ms"] for t in transitions if t.get("outcome") == "observed"]
    describes = [d for t in transitions for d in t.get("describe_ms", [])]
    metrics = {
        "claim": CLAIM, "mode": evidence.get("mode"),
        "delivered_count": len(delivered), "expected_count": len(expected),
        "burst_cycle_count": len(complete), "transition_count": len(transitions),
        "latency_ms": {"p50": _p(latencies, .5), "p95": _p(latencies, .95), "max": max(latencies) if latencies else None},
        "describe_ms": {"p50": _p(describes, .5), "p95": _p(describes, .95), "max": max(describes) if describes else None},
        "frame_lateness_ms_max": max((f.get("lateness_ms") or 0 for f in frames), default=None),
        "bounds": {"transition_ms": TRANSITION_BOUND_MS, "timeout_ms": TRANSITION_TIMEOUT_MS, "min_cycles": MIN_BURST_CYCLES},
    }
    if evidence.get("mode") == "stall_control":
        stall = evidence.get("stall")
        qualifying = []
        if stall:
            latest = stall["begin_wall"] + (STALL_MS - TRANSITION_BOUND_MS) / 1000
            # A tap that starts inside the stall and early enough that its
            # response cannot commit before stall end must exceed the bound.
            qualifying = [t for t in transitions if t.get("tap_started_wall") is not None
                          and stall["begin_wall"] <= t["tap_started_wall"] <= latest]
        metrics["stall_control"] = {"stall": stall, "qualifying_transitions": len(qualifying),
                                    "exercised": bool(qualifying), "expected_verdict": "FAIL"}
        if not qualifying:
            setup.append("stall_control_not_exercised")
    if setup:
        return "SETUP_FAIL", setup, metrics
    return ("FAIL" if failures else "PASS"), failures, metrics


# ---- live run ----------------------------------------------------------------

class _DrawerUI:
    """The probe's view of the bound simulator through the existing idb wrapper."""

    def __init__(self, config):
        from ._m1_native_ui import NativeUI
        self.native = NativeUI(config)

    def elements(self):
        return self.native.elements()

    def tap_point(self, x, y):
        self.native._command("tap", str(x), str(y))

    def describe_point(self, x, y):
        import json
        return json.loads(self.native._command("describe-point", str(x), str(y), "--json"))

    def check_foreground(self):
        self.native.check_foreground()


def _await_sessions_button(ui, timeout_s=30.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _open_target(ui.elements()):
            return True
        time.sleep(0.25)
    return False


def _await_stall_begin(stream, timeout_s) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if any(getattr(e, "message", "") == "harness:ui_trace"
               and (e.data or {}).get("kind") == "chat_list_js_stall_begin" for e in stream.all_events()):
            return True
        time.sleep(0.02)
    return False


def run(config: dict, stream, cap=None) -> Verdict:
    from ._m1_mock_control import MockControl

    run_mode = mode(config)
    url = fixture_url(config)
    evidence = {"mode": run_mode, "baseline": {"ok": False, "error": None}, "frames": [], "cycles": [],
                "expected_count": BURST_EVENT_COUNT, "first_send_mono": None, "last_ack_mono": None,
                "received": [], "stall": None, "setup_errors": []}
    controls = []
    try:
        control = MockControl(url)
        controls.append(control)
        control.rpc("debug_replay_snapshot_config", snapshot=build_snapshot(config), host=HOST)
        if not await_event(stream, EventSpec("chat:ws_open", timeout_s=30)):
            raise RuntimeError("chat:ws_open missing")
        ui = _DrawerUI(config)
        if not _await_sessions_button(ui):
            evidence["baseline"]["error"] = "assistant header Sessions button absent"
            raise RuntimeError(evidence["baseline"]["error"])
        baseline = probe_cycle(ui, require_rows=BURST_STREAM_IDS)
        evidence["baseline"].update(cycle=baseline, ok=len(baseline["transitions"]) == 2
                                    and all(t["outcome"] == "observed" for t in baseline["transitions"])
                                    and baseline["rows_present"] == list(BURST_STREAM_IDS))
        if cap:
            cap.screenshot(f"{name}_baseline")
        if not evidence["baseline"]["ok"]:
            raise RuntimeError("baseline drawer cycle failed")

        injector = MockControl(url)
        controls.append(injector)
        sent = {"count": 0}
        result = {}
        thread = threading.Thread(target=lambda: result.update(run_injector(
            injector, build_burst(), progress=lambda n: sent.update(count=n))), daemon=True)
        thread.start()
        triggered = run_mode != "stall_control"
        screenshot_taken = False
        while thread.is_alive():
            if not triggered and sent["count"] >= BURST_EVENT_COUNT // 2:
                # Trigger with no cycle in flight, then tap once the stall has begun.
                trigger = MockControl(url)
                controls.append(trigger)
                trigger.rpc("debug_replay_event", expected_stream_id=TRIGGER_STREAM_ID, event=trigger_event())
                triggered = True
                if not _await_stall_begin(stream, STALL_BEGIN_WAIT_S):
                    evidence["setup_errors"].append("stall_begin_trace_missing")
            evidence["cycles"].append(probe_cycle(ui))
            if cap and not screenshot_taken and sent["count"] >= BURST_EVENT_COUNT // 2:
                cap.screenshot(f"{name}_mid_burst")
                screenshot_taken = True
        thread.join()
        evidence.update(frames=result.get("frames", []), first_send_mono=result.get("first_send_mono"),
                        last_ack_mono=result.get("last_ack_mono"))
        if result.get("error"):
            evidence["setup_errors"].append("injector: " + result["error"])
        expected = {(f["stream_id"], int(f["seq"])) for f in evidence["frames"]}
        deadline = time.monotonic() + DELIVERY_GRACE_S
        while time.monotonic() < deadline and not expected <= set(received_identities(stream.all_events())):
            time.sleep(0.25)
    except Exception as exc:  # noqa: BLE001 - classified by the oracle below
        if evidence["baseline"]["ok"]:
            evidence["setup_errors"].append(str(exc))
        else:
            evidence["baseline"]["error"] = evidence["baseline"]["error"] or str(exc)
    finally:
        for control in controls:
            try:
                control.close()
            except Exception:  # noqa: BLE001
                pass
    events = stream.all_events()
    evidence["received"] = received_identities(events)
    offset = time.time() - time.monotonic()
    evidence["stall"] = stall_window(events, mono_to_wall=lambda mono: mono + offset)
    verdict, failures, metrics = evaluate(evidence)
    if cap:
        cap.screenshot(f"{name}_end")
    return Verdict(name=name, verdict=verdict, error="; ".join(failures) or None, extras={
        **metrics, "baseline": evidence["baseline"], "cycles": evidence["cycles"],
        "frames": evidence["frames"], "setup_errors": evidence["setup_errors"]}).finish()
