from __future__ import annotations

import json


def event_line(run_id: str, *, include_value: bool = True) -> str:
    data = {"run_id": run_id} if include_value else {"field_names": ["run_id"]}
    return "[EVENT] " + json.dumps({"name": "runner.ready", "data": data})


def parse_event_line(line: str) -> dict | None:
    if not line.startswith("[EVENT] "):
        return None
    try:
        payload = json.loads(line.removeprefix("[EVENT] "))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def matches_run(line: str, run_id: str) -> bool:
    payload = parse_event_line(line)
    return bool(payload and payload.get("data", {}).get("run_id") == run_id)


def test_ready_event_carries_the_run_value() -> None:
    line = event_line("run-1")
    assert matches_run(line, "run-1")
    assert not matches_run(line, "run-2")


def test_names_only_payload_does_not_satisfy_value_matching() -> None:
    assert not matches_run(event_line("run-1", include_value=False), "run-1")


def test_truncated_event_is_counted_as_unparseable() -> None:
    line = event_line("run-1")[:-5] + "<truncated>"
    assert parse_event_line(line) is None


def test_unrelated_log_lines_are_ignored() -> None:
    assert parse_event_line("ordinary output") is None
