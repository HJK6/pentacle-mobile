from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

import time
import hashlib
import json
from pathlib import Path
from typing import Any

from ..harness.asserts import EventSpec, StepResult, Verdict, await_event
from . import _mock_chat_streamd as M


name = "chat_ui_parity_new_chat"

OLD_ROW_TIMEOUT_S = 30.0
NEW_STREAM_LANDING_TIMEOUT_S = 10.0
NEGATIVE_WATCH_WINDOW_S = 3.0


def actions(_config):
    return [
        "autoaccept_biometric",
        "disable_pentacle_auth",
        "open_existing_chat",
        "await_and_open_new_stream",
    ]


def _write_fixture(run_id: str, old_marker: str, new_marker: str) -> tuple[Path, str, str]:
    old_session = f"codex-old-fixture-{run_id}"
    old_stream_id = f"hostc:{old_session}"
    new_session = f"codex-fixture-{run_id}"
    new_stream_id = f"hostc:{new_session}"
    fixture = Path("/tmp") / f"example-new-chat-flash-{run_id}.json"
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": {
            "stream_id": old_stream_id,
            "host": "hostc",
            "provider": "codex",
            "session_name": old_session,
            "title": "New chat flash old fixture",
        },
        "snapshot": {
            "sessions": [
                {
                    "stream_id": old_stream_id,
                    "host": "hostc",
                    "provider": "codex",
                    "session_name": old_session,
                    "title": "New chat flash old fixture",
                },
                {
                    "stream_id": new_stream_id,
                    "host": "hostc",
                    "provider": "codex",
                    "session_name": new_session,
                    "title": "New chat flash new fixture",
                },
            ],
            "events": [],
        },
        "frames": [
            {
                "id": "old-stream-marker",
                "at_ms": 3000,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "USER",
                    "daemon_seq": 1,
                    "timestamp": "2026-07-09T18:29:59.000Z",
                    "text": old_marker,
                    "stream_id": old_stream_id,
                    "session_name": old_session,
                    "host": "hostc",
                    "provider": "codex",
                },
            },
            {
                "id": "new-stream-marker",
                "at_ms": 15000,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 2,
                    "timestamp": "2026-07-09T18:30:00.000Z",
                    "text": f"ACK marker:{new_marker}",
                    "stream_id": new_stream_id,
                    "session_name": new_session,
                    "host": "hostc",
                    "provider": "codex",
                },
            },
        ],
        "upload": {"required": True},
    }
    fixture.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return fixture, old_stream_id, new_stream_id


def params(config: dict) -> dict[str, str]:
    run_id = str(config.get("scenario_run_id") or config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or "example-run")
    run_suffix = hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:8]
    old_marker = f"m2old_{run_suffix}"
    new_marker = f"m2new_{run_suffix}"
    fixture, old_stream_id, new_stream_id = _write_fixture(run_id, old_marker, new_marker)
    return {
        "host": "hostc",
        "provider": "codex",
        "host_filter": "hostc",
        "text": old_marker,
        "marker": new_marker,
        "scenario_run_id": run_id,
        "stream_id": old_stream_id,
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "scripted_marker_stream_id": new_stream_id,
        "PENTACLE_EVENT_REPLAY_COMMAND": "",
    }


def preflight(config: dict, repo_root: Path | None = None) -> str | None:
    host_name = str(config.get("host") or "hostc").strip().lower()
    if host_name not in {"hosta", "hostb", "hostc", "hostd"}:
        return f"new_chat_flash unknown synthetic host {host_name}"
    return M.preflight(config, repo_root)


def _await_step(stream, spec: EventSpec, cutoff: float | None = None) -> StepResult:
    started = time.monotonic()
    event = await_event(stream, spec, not_before=cutoff)
    return StepResult(expected=spec, event=event, elapsed_s=time.monotonic() - started)


def _event_data(event) -> dict[str, Any]:
    return dict(getattr(event, "data", {}) or {})


def _row_mounts_marker(event, marker: str, stream_id: str | None = None) -> bool:
    if event.message != "harness:row_rendered":
        return False
    data = _event_data(event)
    if data.get("lifecycle") != "mount":
        return False
    if stream_id and data.get("stream_id") != stream_id:
        return False
    text_prefix = str(data.get("text_prefix") or "")
    return text_prefix.startswith(marker)


def _await_marker_row(stream, marker: str, stream_id: str, timeout_s: float, not_before: float | None = None):
    deadline = time.monotonic() + timeout_s
    cutoff = not_before or 0.0
    for event in stream.all_events():
        if event.received_at >= cutoff and _row_mounts_marker(event, marker, stream_id):
            return event
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if event and event.received_at >= cutoff and _row_mounts_marker(event, marker, stream_id):
            return event
    return None


def _old_row_leak(event, old_marker: str, old_stream_id: str, new_stream_id: str) -> bool:
    if event.message != "harness:row_rendered":
        return False
    data = _event_data(event)
    if data.get("lifecycle") != "mount":
        return False
    text_prefix = str(data.get("text_prefix") or "")
    event_key = str(data.get("event_key") or "")
    rendered_stream_id = str(data.get("stream_id") or "")
    return (
        text_prefix.startswith(old_marker)
        or old_stream_id in event_key
        or (rendered_stream_id == old_stream_id and rendered_stream_id != new_stream_id)
    )


def _events_after(stream, cutoff: float, window_s: float):
    deadline = time.monotonic() + window_s
    while time.monotonic() < deadline:
        stream.next_event(timeout_s=min(0.25, deadline - time.monotonic()))
    return [event for event in stream.all_events() if event.received_at >= cutoff]


def _setup_fail(name_: str, steps: list[StepResult], error: str, extras: dict | None = None) -> Verdict:
    return Verdict(name=name_, verdict="SETUP_FAIL", steps=steps, error=error, extras=extras or {}).finish()


def _fail(name_: str, steps: list[StepResult], error: str, extras: dict | None = None) -> Verdict:
    return Verdict(name=name_, verdict="FAIL", steps=steps, error=error, extras=extras or {}).finish()


def run(config: dict, stream, cap=None):
    started = time.monotonic()
    host_name = str(config.get("host") or "hostc").strip().lower()
    old_marker = str(config.get("text") or "").strip()
    new_marker = str(config.get("marker") or "").strip()
    scenario_name = name
    steps: list[StepResult] = []
    if cap:
        cap.screenshot(f"{scenario_name}_start")

    old_mount = _await_step(stream, EventSpec("harness:session_screen_mount", timeout_s=30.0))
    steps.append(old_mount)
    old_stream_id = str((_event_data(old_mount.event) if old_mount.event else {}).get("stream_id") or "")
    if not old_mount.passed or not old_stream_id:
        return _setup_fail(
            scenario_name,
            steps,
            "missing old harness:session_screen_mount stream_id",
            {"host": host_name, "old_marker": old_marker, "new_marker": new_marker},
        )

    for spec in [
        EventSpec("harness:transcript_ready_settled", where={"stream_id": old_stream_id}, timeout_s=30.0),
    ]:
        step = _await_step(stream, spec, steps[-1].event.received_at if steps[-1].event else None)
        steps.append(step)
        if not step.passed:
            return _setup_fail(
                scenario_name,
                steps,
                f"missing old-stream event {spec.message!r}",
                {"host": host_name, "old_stream_id": old_stream_id, "old_marker": old_marker, "new_marker": new_marker},
            )

    old_marker_row = _await_marker_row(
        stream,
        old_marker,
        old_stream_id,
        timeout_s=OLD_ROW_TIMEOUT_S,
        not_before=None,
    )
    if not old_marker_row:
        return _setup_fail(
            scenario_name,
            steps,
            "old chat marker row did not render before opening new chat",
            {"host": host_name, "old_stream_id": old_stream_id, "old_marker": old_marker},
        )

    hosts = load_peer_hosts()
    host = hosts.get(host_name)
    timeout_s = float((host.new_stream_timeout_s if host else None) or 30.0)

    observed = _await_step(
        stream,
        EventSpec("harness:new_stream_observed", where={"marker": new_marker, "host": host_name}, timeout_s=timeout_s),
        cutoff=old_marker_row.received_at,
    )
    steps.append(observed)
    new_stream_id = str((_event_data(observed.event) if observed.event else {}).get("stream_id") or "")
    if not observed.passed or not new_stream_id:
        return _setup_fail(
            scenario_name,
            steps,
            "new marker stream was not observed from mobile telemetry",
            {
                "host": host_name,
                "old_stream_id": old_stream_id,
                "old_marker": old_marker,
                "new_marker": new_marker,
                "scripted_fixture": config.get("scripted_daemon_fixture_path"),
            },
        )

    new_mount_event = None
    for spec in [
        EventSpec("harness:open_stream_attempted", where={"stream_id": new_stream_id}, timeout_s=NEW_STREAM_LANDING_TIMEOUT_S),
        EventSpec("harness:session_screen_mount", where={"stream_id": new_stream_id}, timeout_s=NEW_STREAM_LANDING_TIMEOUT_S),
        EventSpec("harness:transcript_ready_settled", where={"stream_id": new_stream_id}, timeout_s=NEW_STREAM_LANDING_TIMEOUT_S),
    ]:
        step = _await_step(stream, spec, steps[-1].event.received_at if steps[-1].event else None)
        steps.append(step)
        if spec.message == "harness:session_screen_mount" and step.event:
            new_mount_event = step.event
        if not step.passed:
            return _setup_fail(
                scenario_name,
                steps,
                f"missing new-stream event {spec.message!r}",
                {
                    "host": host_name,
                    "old_stream_id": old_stream_id,
                    "new_stream_id": new_stream_id,
                    "old_marker": old_marker,
                    "new_marker": new_marker,
                    "scripted_fixture": config.get("scripted_daemon_fixture_path"),
                },
            )

    new_settled = steps[-1].event
    watch_cutoff = new_mount_event.received_at if new_mount_event else (new_settled.received_at if new_settled else time.monotonic())
    watched_events = _events_after(stream, watch_cutoff, NEGATIVE_WATCH_WINDOW_S)
    leaks = [
        event
        for event in watched_events
        if _old_row_leak(event, old_marker, old_stream_id, new_stream_id)
    ]

    extras = {
        "host": host_name,
        "old_stream_id": old_stream_id,
        "new_stream_id": new_stream_id,
        "old_marker": old_marker,
        "new_marker": new_marker,
        "old_marker_row": old_marker_row.to_dict(),
        "negative_watch_window_s": NEGATIVE_WATCH_WINDOW_S,
        "old_row_leak_count": len(leaks),
        "duration_s": round(time.monotonic() - started, 2),
        "scripted_fixture": config.get("scripted_daemon_fixture_path"),
    }
    if leaks:
        return _fail(
            scenario_name,
            steps,
            "old-stream row mounted after new stream transcript settled",
            {**extras, "old_row_leaks": [event.to_dict() for event in leaks[:5]]},
        )

    if cap:
        cap.screenshot(f"{scenario_name}_end")
    return Verdict(name=scenario_name, verdict="PASS", steps=steps, extras=extras).finish()
