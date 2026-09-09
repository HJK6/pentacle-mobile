from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from . import _mock_chat_streamd as M
from .report_viewer_horizontal_scroll import _poll_element_frames
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_chat_row_swipe_snap"
SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}
ACTION_WIDTH = 64
OPEN_WIDTH = ACTION_WIDTH * 2
def _row_surface(stream_id: str) -> tuple[str, str, str]:
    suffix = re.sub(r"[^a-zA-Z0-9_-]", "-", stream_id)
    return f"chat-row-{suffix}", f"chat-row-rename-{suffix}", f"chat-row-delete-{suffix}"


def _candidate_stream_ids() -> list[str]:
    return [M.STREAM_ID, *[f"{M.HOST}:swipe-row-{index:02d}" for index in range(1, 18)]]


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "chat_list_load_probe"]


def _write_fixture(path: Path) -> None:
    sessions = []
    for index in range(18):
        primary = index == 0
        session_name = M.SESSION_NAME if primary else f"swipe-row-{index:02d}"
        stream_id = M.STREAM_ID if primary else f"{M.HOST}:{session_name}"
        sessions.append({
            "stream_id": stream_id,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": session_name,
            "title": "Swipe snap probe" if primary else f"Scrollable row {index:02d}",
            "last_text": "Swipe endpoint fixture",
            "last_kind": "ASSIST",
            "last_event_at": f"2026-07-23T12:{59 - index:02d}:00.000Z",
            "online": True,
        })
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": sessions[0],
        "snapshot": {"sessions": sessions, "events": []},
        "history": {"streams": []},
        "frames": [],
        "upload": {},
        "send_echo": {},
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def params(config: dict) -> dict[str, str]:
    run_id = str(config.get("scenario_run_id") or config.get("RUN_ID") or "swipe-snap")
    fixture = Path("/tmp") / f"pentacle-{name}-{run_id}.json"
    _write_fixture(fixture)
    payload = M.params_for_fixture(config, fixture.name)
    payload["mock_fixture_path"] = str(fixture)
    payload["scripted_daemon_fixture_path"] = str(fixture)
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def endpoint_failure(baseline_x: float, settled_x: float, state: str, tolerance: float = 5) -> str | None:
    expected = baseline_x if state == "closed" else baseline_x - OPEN_WIDTH
    if abs(settled_x - expected) <= tolerance:
        return None
    return f"{state} row x={settled_x}, expected {expected}±{tolerance}"


def close_swipe_start_x(baseline_x: float, open_x: float, width: float) -> float:
    return max(baseline_x + width * 0.2, open_x + width * 0.55)


def _swipe(udid: str, start: tuple[float, float], end: tuple[float, float], duration: float = 0.35) -> str | None:
    result = subprocess.run(
        [
            "idb", "ui", "swipe",
            str(int(start[0])), str(int(start[1])), str(int(end[0])), str(int(end[1])),
            "--duration", str(duration), "--udid", udid,
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if result.returncode == 0:
        return None
    return (result.stderr or result.stdout or "idb swipe failed").strip()


def _settled(stream, state: str, not_before: float, stream_id: str):
    return await_event(
        stream,
        EventSpec(
            "chat:row_swipe_settled",
            where={"stream_id": stream_id, "subsystem": "chat_list", "scenario": "endpoint_snap", "state": state},
            timeout_s=8,
        ),
        not_before=not_before,
    )


def run(config: dict, stream, cap=None) -> Verdict:
    ready = await_event(stream, EventSpec("harness:all_chats_ready", timeout_s=20))
    if not ready:
        return Verdict(name=name, verdict="SETUP_FAIL", error="all-chats fixture did not become ready").finish()
    udid = str(config["PENTACLE_TARGET_UDID"])
    surfaces = {stream_id: _row_surface(stream_id) for stream_id in _candidate_stream_ids()}
    before = _poll_element_frames(
        udid,
        {row_id for row_id, _, _ in surfaces.values()},
        require_all=False,
    )
    if not before:
        return Verdict(name=name, verdict="SETUP_FAIL", error="chat-row accessibility frame missing").finish()
    visible = []
    for stream_id, (row_id, rename_id, delete_id) in surfaces.items():
        frame = before.get(row_id)
        if not frame:
            continue
        try:
            x, y, width, height = (float(frame[key]) for key in ("x", "y", "width", "height"))
        except (KeyError, TypeError, ValueError):
            continue
        if y >= 0 and width > 0 and height > 0:
            visible.append((y, stream_id, row_id, rename_id, delete_id, x, width, height))
    if not visible:
        return Verdict(name=name, verdict="SETUP_FAIL", error="no mounted chat row has a usable frame").finish()
    _, selected_stream_id, row_id, rename_id, delete_id, x, width, height = min(visible)
    frame = before[row_id]
    try:
        y = float(frame["y"])
    except (KeyError, TypeError, ValueError):
        return Verdict(name=name, verdict="SETUP_FAIL", error=f"invalid chat-row frame: {frame}").finish()
    if cap:
        cap.screenshot("chat_row_swipe_closed")

    failures: list[str] = []
    started = ready.received_at
    error = _swipe(udid, (x + width * 0.75, y + height / 2), (x + width * 0.67, y + height / 2))
    short = _settled(stream, "closed", started, selected_stream_id)
    short_frames = _poll_element_frames(udid, {row_id})
    if error:
        failures.append(f"short swipe injection failed: {error}")
    if not short:
        failures.append("short swipe emitted no closed settle")
    if short_frames:
        failure = endpoint_failure(x, float(short_frames[row_id]["x"]), "closed")
        if failure:
            failures.append(failure)
    else:
        failures.append("row frame missing after short swipe")

    full_start = short.received_at if short else started
    error = _swipe(udid, (x + width * 0.85, y + height / 2), (x + width * 0.15, y + height / 2))
    opened = _settled(stream, "open", full_start, selected_stream_id)
    open_frames = _poll_element_frames(udid, {row_id, rename_id, delete_id})
    if error:
        failures.append(f"full swipe injection failed: {error}")
    if not opened:
        failures.append("full swipe emitted no open settle")
    if open_frames:
        failure = endpoint_failure(x, float(open_frames[row_id]["x"]), "open")
        if failure:
            failures.append(failure)
        for identifier in (rename_id, delete_id):
            if abs(float(open_frames[identifier]["width"]) - ACTION_WIDTH) > 3:
                failures.append(f"{identifier} width is not {ACTION_WIDTH}")
    else:
        failures.append("open row/action accessibility frames missing")

    close_start = opened.received_at if opened else full_start
    open_x = float(open_frames[row_id]["x"]) if open_frames else x - OPEN_WIDTH
    error = _swipe(
        udid,
        (close_swipe_start_x(x, open_x, width), y + height / 2),
        (x + width * 0.85, y + height / 2),
    )
    reclosed = _settled(stream, "closed", close_start, selected_stream_id)
    if error:
        failures.append(f"close swipe injection failed: {error}")
    if not reclosed:
        failures.append("open row did not settle closed before diagonal probe")

    reopen_start = reclosed.received_at if reclosed else close_start
    error = _swipe(
        udid,
        (x + width * 0.85, y + height / 2),
        (x + width * 0.15, y + height / 2),
    )
    reopened = _settled(stream, "open", reopen_start, selected_stream_id)
    if error:
        failures.append(f"parent-scroll setup swipe failed: {error}")
    if not reopened:
        failures.append("row did not reopen before parent-scroll probe")

    parent_scroll_start = reopened.received_at if reopened else reopen_start
    error = _swipe(
        udid,
        (x + width * 0.5, y + height * 0.75),
        (x + width * 0.5, y - height * 1.5),
        0.45,
    )
    diagonal = _settled(stream, "closed", parent_scroll_start, selected_stream_id)
    closed_frames = _poll_element_frames(udid, {row_id})
    if error:
        failures.append(f"diagonal swipe injection failed: {error}")
    if not diagonal:
        failures.append("diagonal handoff emitted no closed settle")
    elif diagonal.data.get("reason") != "parent_scroll":
        failures.append(f"diagonal handoff settled for {diagonal.data.get('reason')}, expected parent_scroll")
    if closed_frames:
        failure = endpoint_failure(x, float(closed_frames[row_id]["x"]), "closed")
        if failure:
            failures.append(failure)

    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "selected_stream_id": selected_stream_id,
            "short_closed": short is not None,
            "full_open": opened is not None,
            "full_reclosed": reclosed is not None,
            "parent_scroll_reopened": reopened is not None,
            "diagonal_closed": diagonal is not None,
            "action_width": ACTION_WIDTH,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)

