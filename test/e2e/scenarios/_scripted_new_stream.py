from __future__ import annotations

import json
import re
import time
from pathlib import Path


def _safe(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")[:48] or "stream"


def write_fixture(
    *,
    scenario_name: str,
    host: str,
    provider: str,
    marker: str,
    at_ms: int,
    run_id: str | None = None,
) -> dict[str, str]:
    safe_marker = _safe(marker)
    safe_run = _safe(run_id or safe_marker or str(int(time.time())))
    session_name = f"{provider}-fixture-{safe_run}"
    stream_id = f"{host}:{session_name}"
    fixture = Path("/tmp") / f"pentacle-new-stream-{_safe(scenario_name)}-{safe_run}.json"
    payload = {
        "schema_version": 1,
        "name": scenario_name,
        "stream": {
            "stream_id": stream_id,
            "host": host,
            "provider": provider,
            "session_name": session_name,
            "title": f"{scenario_name} fixture",
        },
        "snapshot": {"sessions": [], "events": []},
        "frames": [
            {
                "id": "marker-stream",
                "at_ms": at_ms,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 1,
                    "timestamp": "2026-07-09T18:30:00.000Z",
                    "text": f"ACK marker:{marker}",
                    "stream_id": stream_id,
                    "session_name": session_name,
                    "host": host,
                    "provider": provider,
                },
            },
            {
                "id": "active-stream-followup",
                "at_ms": at_ms + 3000,
                "type": "chat.event",
                "wait_for_client": False,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 2,
                    "timestamp": "2026-07-09T18:30:03.000Z",
                    "text": f"follow-up marker:{marker}",
                    "stream_id": stream_id,
                    "session_name": session_name,
                    "host": host,
                    "provider": provider,
                },
            },
        ],
        "upload": {"required": True},
    }
    fixture.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return {
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "scripted_marker_stream_id": stream_id,
        "PENTACLE_EVENT_REPLAY_COMMAND": "",
    }
