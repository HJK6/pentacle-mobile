from __future__ import annotations

import json
from pathlib import Path


def open_empty_session(events: list[dict], *, provider: str = "codex") -> dict:
    hydrated = False
    rendered = False
    for event in events:
        if event["name"] == "connection.open":
            continue
        if event["name"] == "screen.mounted":
            continue
        if event["name"] == "history.ready":
            hydrated = True
        if event["name"] == "empty.rendered":
            if not hydrated:
                return {"verdict": "FAIL", "error": "empty state rendered before hydration"}
            rendered = True
    if not rendered:
        return {"verdict": "FAIL", "error": "empty state was not rendered"}
    return {"verdict": "PASS", "provider": provider}


def save_local_session(path: Path, stream_id: str, host: str = "hostc") -> None:
    path.write_text(json.dumps([{
        "stream_id": stream_id,
        "host": host,
        "source": "empty_session",
    }]), encoding="utf-8")


def test_empty_session_uses_the_default_provider() -> None:
    assert open_empty_session([
        {"name": "connection.open"},
        {"name": "screen.mounted"},
        {"name": "history.ready"},
        {"name": "empty.rendered"},
    ])["provider"] == "codex"


def test_empty_session_renders_only_after_history_is_ready() -> None:
    result = open_empty_session([
        {"name": "screen.mounted"},
        {"name": "history.ready"},
        {"name": "empty.rendered"},
    ])
    assert result["verdict"] == "PASS"


def test_optimistic_only_render_fails_closed() -> None:
    result = open_empty_session([
        {"name": "screen.mounted"},
        {"name": "empty.rendered"},
        {"name": "history.ready"},
    ])
    assert result == {"verdict": "FAIL", "error": "empty state rendered before hydration"}


def test_spawned_stream_is_recorded_before_later_assertions(tmp_path: Path) -> None:
    state_path = tmp_path / "sessions.json"
    save_local_session(state_path, "hostc:codex:sample")
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved == [{
        "stream_id": "hostc:codex:sample",
        "host": "hostc",
        "source": "empty_session",
    }]
