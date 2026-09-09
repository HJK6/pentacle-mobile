from __future__ import annotations

import json
import re
import time
from pathlib import Path

from ._run_state import save_seeded_stream


SIMULATOR_META = {"target_compat": {"device", "simulator"}, "requires": []}


def _safe_slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "default"


def _run_id(config: dict) -> str:
    return str(
        config.get("scenario_run_id")
        or config.get("RUN_ID")
        or config.get("PENTACLE_RUN_ID")
        or f"biometric-matrix-{int(time.time())}"
    )


def default_stream_id(config: dict, *, host: str, provider: str, scenario_name: str) -> str:
    slug = _safe_slug(_run_id(config))[-48:]
    return f"{host}:l1-{provider}-{_safe_slug(scenario_name)}-{slug}"


def fixture_path(config: dict, *, scenario_name: str, stream_id: str) -> Path:
    override = str(config.get("PENTACLE_MOCK_CHAT_STREAMD_FIXTURE_DIR") or "").strip()
    if override:
        base = Path(override).expanduser()
    else:
        base = Path(config.get("PENTACLE_WALK_STATE_DIR") or f"/tmp/pentacle-walk-state-{_safe_slug(_run_id(config))}")
    return base / "scripted-daemon" / f"{_safe_slug(scenario_name)}-{_safe_slug(stream_id)}.json"


def ensure_seeded(config: dict, *, host: str, provider: str, stream_id: str) -> None:
    if str(config.get("PENTACLE_E2E_TARGET") or "").lower() != "simulator":
        return
    save_seeded_stream(
        run_id=_run_id(config),
        host=host,
        provider=provider,
        stream_id=stream_id,
        state_dir=config.get("PENTACLE_WALK_STATE_DIR"),
    )


def write_existing_chat_fixture(
    config: dict,
    *,
    scenario_name: str,
    host: str,
    provider: str,
    stream_id: str,
    include_activity: bool = False,
) -> Path:
    session_name = stream_id.split(":", 1)[1] if ":" in stream_id else stream_id
    path = fixture_path(config, scenario_name=scenario_name, stream_id=stream_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    title = f"L1 {scenario_name}"
    frames = [
        _frame(
            "seed-user",
            0,
            "USER",
            10,
            "seeded biometric matrix chat",
            host=host,
            provider=provider,
            session_name=session_name,
            stream_id=stream_id,
            wait_for_client=True,
        ),
        _frame(
            "seed-assist",
            250,
            "ASSIST",
            11,
            "Seeded assistant reply for existing-chat mount.",
            host=host,
            provider=provider,
            session_name=session_name,
            stream_id=stream_id,
        ),
        _frame(
            "post-send-assist",
            3500,
            "ASSIST",
            12,
            "Assistant reply after the harness send.",
            host=host,
            provider=provider,
            session_name=session_name,
            stream_id=stream_id,
        ),
    ]
    if include_activity:
        frames.append(
            _frame(
                "post-toggle-activity",
                12000,
                "TOOL",
                13,
                "Bash echo fixture activity",
                host=host,
                provider=provider,
                session_name=session_name,
                stream_id=stream_id,
                raw={
                    "source": "scripted-daemon",
                },
            )
        )
    payload = {
        "schema_version": 1,
        "name": scenario_name,
        "stream": {
            "stream_id": stream_id,
            "host": host,
            "provider": provider,
            "session_name": session_name,
            "title": title,
        },
        "snapshot": {
            "sessions": [
                {
                    "stream_id": stream_id,
                    "host": host,
                    "provider": provider,
                    "session_name": session_name,
                    "title": title,
                    "display_name": title,
                    "last_event_at": "2026-07-09T18:29:00.000Z",
                    "last_text": "Seeded assistant reply for existing-chat mount.",
                    "last_kind": "ASSIST",
                    "working": False,
                    "online": True,
                }
            ],
            "events": [],
        },
        "frames": frames,
        "send_echo": {
            "daemon_seq": 50,
            "timestamp": "2026-07-09T18:30:00.000Z",
            "wait_for_send_s": 120,
        },
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def write_spawn_chat_fixture(
    config: dict,
    *,
    scenario_name: str,
    host: str,
    provider: str,
    assistant_replies: list[str] | None = None,
) -> Path:
    placeholder_stream_id = f"{host}:pending-{_safe_slug(scenario_name)}"
    placeholder_session = placeholder_stream_id.split(":", 1)[1]
    path = fixture_path(config, scenario_name=scenario_name, stream_id=placeholder_stream_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    replies = assistant_replies or [
        f"{provider} assistant reply for {host}.",
        f"{provider} assistant second reply for {host}.",
    ]
    payload = {
        "schema_version": 1,
        "name": scenario_name,
        "stream": {
            "stream_id": placeholder_stream_id,
            "host": host,
            "provider": provider,
            "session_name": placeholder_session,
            "title": f"L1 {scenario_name}",
        },
        "snapshot": {"sessions": [], "events": []},
        "frames": [],
        "send_echo": {
            "match": "latest_spawn",
            "host": host,
            "provider": provider,
            "daemon_seq": 70,
            "wait_for_send_s": 120,
            "assistant_replies": [
                {
                    "daemon_seq": 170,
                    "terminal_daemon_seq": 171,
                    "text": replies[0],
                },
                *[
                    {
                        "daemon_seq": 270 + (idx * 100),
                        "terminal_daemon_seq": 271 + (idx * 100),
                        "text": text,
                    }
                    for idx, text in enumerate(replies[1:])
                ],
            ],
        },
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def _frame(
    frame_id: str,
    at_ms: int,
    kind: str,
    daemon_seq: int,
    text: str,
    *,
    host: str,
    provider: str,
    session_name: str,
    stream_id: str,
    wait_for_client: bool = False,
    raw: dict | None = None,
) -> dict:
    frame = {
        "id": frame_id,
        "at_ms": at_ms,
        "type": "chat.event",
        "event": {
            "kind": kind,
            "daemon_seq": daemon_seq,
            "timestamp": "2026-07-09T18:29:00.000Z",
            "text": text,
            "stream_id": stream_id,
            "session_name": session_name,
            "host": host,
            "provider": provider,
        },
    }
    if raw is not None:
        frame["event"]["raw"] = raw
    if wait_for_client:
        frame["wait_for_client"] = True
    return frame
