from __future__ import annotations

import json
import math
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..harness.asserts import Verdict

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

name = "all_chats_load"
EVENT_COUNT = 120
SETUP_EVENT_COUNT = 100
SESSION_COUNT = 8
BURST_COUNT = 4
BURST_SIZE = 5
REPORT_COUNT = 4
QUESTION_COUNT = 4
STATUS_STREAM_ID = "mock-host:sample-04"
STATUS_TOGGLE_ID = "chat-row-toggle-mock-host-sample-04"
STATUS_WITNESS_ID = f"card-status-mini-{STATUS_STREAM_ID}"
NEW_CHAT_BUTTON_ID = "new-chat-button"


class HarnessEvidenceError(RuntimeError):
    """Raised when a synthetic evidence payload is malformed."""


def _profile(config: dict) -> dict[str, int | str]:
    mode = str(config.get("chat_list_mode") or "control").strip().lower()
    if mode not in {"control", "stress"}:
        raise ValueError(f"chat_list_mode must be control or stress, got {mode!r}")
    if mode == "stress":
        return {"mode": mode, "setup_event_count": 200, "event_count": 240}
    return {"mode": mode, "setup_event_count": SETUP_EVENT_COUNT, "event_count": EVENT_COUNT}


def _setup_ingestion_timeout_s(mode: str, event_timeout_s: float) -> float:
    return max(event_timeout_s, 30.0) if mode == "stress" else event_timeout_s


def _fixture_path(config: dict) -> Path:
    profile = _profile(config)
    base = Path(str(config.get("fixture_dir") or (Path(tempfile.gettempdir()) / "example-mobile-fixtures")))
    base.mkdir(parents=True, exist_ok=True)
    path = base / "all_chats_load.fixture.json"
    origin = datetime(2026, 1, 1, tzinfo=timezone.utc)
    sessions = [
        {
            "stream_id": f"mock-host:sample-{index:02d}",
            "host": "mock-host",
            "provider": "codex",
            "session_name": f"sample-{index:02d}",
            "title": f"Chat sample {index:02d}",
            "online": True,
        }
        for index in range(SESSION_COUNT)
    ]
    frames = []
    for sequence in range(int(profile["setup_event_count"])):
        stream_id = sessions[sequence % SESSION_COUNT]["stream_id"]
        timestamp = (origin + timedelta(seconds=sequence)).isoformat().replace("+00:00", "Z")
        frames.append({
            "id": f"sample-{sequence:04d}",
            "at_ms": 0,
            "type": "chat.event",
            "event": {
                "stream_id": stream_id,
                "kind": "ASSIST",
                "daemon_seq": sequence + 1,
                "timestamp": timestamp,
                "text": f"synthetic chat event {sequence + 1}",
            },
        })
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": sessions[0],
        "snapshot": {"sessions": sessions, "events": []},
        "frames": frames,
        "harness_control": {
            "unread_items": [
                {"item_id": f"sample-item-{index}", "read": False}
                for index in range(REPORT_COUNT)
            ],
            "open_questions": [
                {"question_id": f"sample-question-{index}", "state": "open"}
                for index in range(QUESTION_COUNT)
            ],
        },
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "chat_list_load_probe"]


def params(config: dict) -> dict[str, str]:
    profile = _profile(config)
    fixture = _fixture_path(config)
    return {
        "host": "mock-host",
        "provider": "codex",
        "stream_id": "mock-host:sample-00",
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "chat_list_event_count": str(profile["event_count"]),
        "chat_list_setup_event_count": str(profile["setup_event_count"]),
        "chat_list_session_count": str(SESSION_COUNT),
        "chat_list_burst_size": str(BURST_SIZE),
        "chat_list_item_count": str(REPORT_COUNT),
        "chat_list_question_count": str(QUESTION_COUNT),
        "chat_list_mode": str(profile["mode"]),
    }


def preflight(config: dict, repo_root=None) -> str | None:
    del repo_root
    fixture = str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip()
    if fixture and not Path(fixture).expanduser().exists():
        return f"synthetic fixture missing: {fixture}"
    return None


def _p95(values: list[float]) -> float:
    if not values:
        return float("inf")
    ordered = sorted(float(value) for value in values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(len(ordered) * 0.95) - 1))]


def status_probe_freeze_reason(probes: list[dict]) -> str | None:
    if not probes:
        return "no status probes"
    if any(not isinstance(probe, dict) for probe in probes):
        return "status probe is not an object"
    if any(probe.get("stable") is False for probe in probes):
        return "status geometry was not stable"
    return None


def evaluate_paired_evidence(control: dict, stress: dict) -> dict:
    """Compare two synthetic profiles without consulting external state."""
    control_events = int(control.get("event_count") or 0)
    stress_events = int(stress.get("event_count") or 0)
    failures = []
    if control_events <= 0:
        failures.append("control profile has no events")
    if stress_events < control_events:
        failures.append("stress profile has fewer events than control")
    return {
        "passed": not failures,
        "failures": failures,
        "control_event_count": control_events,
        "stress_event_count": stress_events,
    }


def evaluate_paired_profiles(control: dict, stress: dict) -> dict:
    return evaluate_paired_evidence(control, stress)


def _metric(value: object, field: str, *, numeric: bool = True) -> float | int | bool:
    if isinstance(value, bool):
        return value
    if numeric:
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise HarnessEvidenceError(f"{field} is not numeric") from exc
    return value  # type: ignore[return-value]


def _product_apply_coverage(events: list, burst: int, setup_event_count: int = SETUP_EVENT_COUNT) -> tuple[list[float], list[dict]]:
    expected = setup_event_count + burst * BURST_SIZE
    samples = []
    for event in events:
        data = getattr(event, "data", {}) or {}
        if data.get("kind") != "chat_list_state_applied":
            continue
        if int(data.get("max_sequence") or 0) == expected:
            samples.append(float(getattr(event, "received_at", 0.0)))
    return samples, [{"burst": burst, "expected_sequence": expected, "matched": bool(samples)}]


def _open_return_metrics(events: list, *, started, committed) -> tuple[float, float]:
    start_at = float(getattr(started, "received_at", started or 0.0))
    commit_at = float(getattr(committed, "received_at", committed or start_at))
    return max(0.0, (commit_at - start_at) * 1000.0), max(0.0, commit_at - start_at)


def _release_burst(config: dict, burst: int) -> dict:
    del config
    first = SETUP_EVENT_COUNT + (burst - 1) * BURST_SIZE + 1
    last = first + BURST_SIZE - 1
    return {
        "burst": burst,
        "first_sequence": first,
        "last_sequence": last,
        "expected_unread_count": max(0, REPORT_COUNT - burst),
        "expected_open_question_count": max(0, QUESTION_COUNT - burst),
    }


def _seed_status_probe(config: dict) -> dict:
    return {
        "stream_id": STATUS_STREAM_ID,
        "toggle_id": STATUS_TOGGLE_ID,
        "witness_id": STATUS_WITNESS_ID,
        "source": str(config.get("status_source") or "synthetic"),
    }


def _app_rss_kb(config: dict) -> dict[str, int | str]:
    try:
        value = max(0, int(config.get("rss_kb") or 0))
    except (TypeError, ValueError):
        value = 0
    return {"rss_kb": value, "source": "synthetic-config"}


def _idb_scroll_to_top(udid: str) -> None:
    del udid


def _status_toggle_frame_is_safe(frames: dict[str, dict]) -> bool:
    frame = frames.get(STATUS_TOGGLE_ID)
    return bool(frame and float(frame.get("width", 0)) > 0 and float(frame.get("height", 0)) > 0)


def _status_toggle_is_clipped_above(frames: dict[str, dict] | None) -> bool:
    if not frames or STATUS_TOGGLE_ID not in frames:
        return False
    return float(frames[STATUS_TOGGLE_ID].get("y", 0)) < 0


def _status_probe_geometry_is_stable(before: dict[str, dict], after: dict[str, dict]) -> bool:
    frame_a = before.get(STATUS_TOGGLE_ID)
    frame_b = after.get(STATUS_TOGGLE_ID)
    if not frame_a or not frame_b:
        return False
    return all(abs(float(frame_a.get(key, 0)) - float(frame_b.get(key, 0))) <= 2 for key in ("x", "y", "width", "height"))


def _find_status_toggle_frames(udid: str) -> dict[str, dict]:
    del udid
    return {}


def _wait_ax_state(udid: str, identifier: str, present: bool, timeout_s: float) -> tuple[bool, list[str]]:
    del udid, identifier, timeout_s
    return present, []


def _physical_status_probe(config: dict) -> dict:
    return {
        "status": "synthetic",
        "geometry_stable": True,
        "rss": _app_rss_kb(config),
        "reason": "provided by public fixture data",
    }


def run(config: dict, stream, cap=None) -> Verdict:
    expected = int(config.get("chat_list_event_count") or EVENT_COUNT)
    events = list(stream.all_events())
    received = [
        event for event in events
        if getattr(event, "message", "") == "chat:event_received"
    ]
    rendered = [
        event for event in events
        if getattr(event, "message", "") == "chat:event_rendered"
    ]
    failures = []
    if len(received) < expected:
        failures.append(f"expected at least {expected} received events, observed {len(received)}")
    if len(rendered) < expected:
        failures.append(f"expected at least {expected} rendered events, observed {len(rendered)}")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "event_count": len(received),
            "rendered_count": len(rendered),
            "expected_event_count": expected,
            "profile": _profile(config),
            "status_probe": _physical_status_probe(config),
        },
    )
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()

