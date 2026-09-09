from __future__ import annotations

# This example can run with either a device adapter or a simulator adapter.
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

import json
import time
from pathlib import Path

from ..harness.asserts import EventSpec, Verdict, assert_no_events, assert_sequence
from . import _mock_chat_streamd as M


name = "codex_stream_focus"


def actions(_config: dict) -> list[str]:
    return ["open_existing_chat", "scroll_chat_list"]


def _write_fixture(run_id: str) -> tuple[Path, str]:
    session_name = f"codex-focus-fixture-{run_id}"
    stream_id = f"hostc:{session_name}"
    fixture = Path("/tmp") / f"example-codex-stream-focus-{run_id}.json"
    long_text = "codex focus scroll fixture " + ("payload segment " * 180)
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": {
            "stream_id": stream_id,
            "host": "hostc",
            "provider": "codex",
            "session_name": session_name,
            "title": "Codex focus scroll fixture",
        },
        "snapshot": {
            "sessions": [{
                "stream_id": stream_id,
                "host": "hostc",
                "provider": "codex",
                "session_name": session_name,
                "title": "Codex focus scroll fixture",
            }],
            "events": [],
        },
        "frames": [
            {
                "id": "scrollable-content",
                "at_ms": 3000,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 1,
                    "timestamp": "2026-07-09T18:31:00.000Z",
                    "text": long_text,
                    "stream_id": stream_id,
                    "session_name": session_name,
                    "host": "hostc",
                    "provider": "codex",
                },
            },
            {
                "id": "post-scroll-content",
                "at_ms": 8000,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 2,
                    "timestamp": "2026-07-09T18:31:05.000Z",
                    "text": "post-scroll content should not force bottom",
                    "stream_id": stream_id,
                    "session_name": session_name,
                    "host": "hostc",
                    "provider": "codex",
                },
            },
        ],
        "upload": {"required": True},
    }
    fixture.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return fixture, stream_id


def params(config: dict) -> dict[str, str]:
    run_id = str(config.get("scenario_run_id") or config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or "example-run")
    fixture, stream_id = _write_fixture(run_id)
    return {
        "host": "hostc",
        "provider": "codex",
        "stream_id": stream_id,
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "PENTACLE_EVENT_REPLAY_COMMAND": "",
    }


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None):
    """Assert scrolling away from bottom suppresses stream autoscroll."""
    first_event = assert_sequence(
        stream,
        [
            EventSpec("chat:event_received", timeout_s=60),
            EventSpec("chat:event_rendered", timeout_s=30),
        ],
        name="codex_stream_focus_prereq",
    )
    if first_event.verdict != "PASS":
        return first_event
    verdict = assert_sequence(
        stream,
        [
            EventSpec("chat:user_scrolled", timeout_s=60),
            EventSpec("chat:autoscroll_decision", where={"enabled": False}, timeout_s=30),
        ],
        name="codex_stream_focus",
    )
    if verdict.verdict == "PASS":
        decisions = [
            event for event in stream.all_events()
            if event.message == "chat:autoscroll_decision"
        ]
        disabled_reasons = {
            str(event.data.get("reason"))
            for event in decisions
            if event.data.get("enabled") is False
        }
        if "user_not_at_bottom" not in disabled_reasons and "user_dragging" not in disabled_reasons:
            verdict = Verdict(
                name="codex_stream_focus",
                verdict="FAIL",
                error=f"missing user-position diagnostic reason: {sorted(disabled_reasons)}",
            ).finish()
    verdict.fold_negative_watch(assert_no_events(stream, window_s=3))
    if cap:
        cap.screenshot("codex_stream_focus")
    return verdict.finish()
