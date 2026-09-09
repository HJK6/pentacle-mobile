from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent))

from e2e.scenarios import mock_attachment_photo_only_reconcile  # noqa: E402
from e2e.scenarios import mock_attachment_send_failure_retry  # noqa: E402
from e2e.scenarios import mock_attachment_send_reconcile as scenario  # noqa: E402


@dataclass
class _Event:
    message: str
    received_at: float
    data: dict


class _Stream:
    def __init__(self, events: list[_Event]) -> None:
        self._events = events

    def all_events(self) -> list[_Event]:
        return list(self._events)

    def next_event(self, timeout_s: float = 0.0):
        return None


def _event(message: str, received_at: float, **data) -> _Event:
    return _Event(message=message, received_at=received_at, data=data)


def _events(*, send_state: str | None = None, attachment_count: int = 1, has_text: bool = True) -> list[_Event]:
    optimistic_id = "optimistic_mock_host_mock_session_1"
    rendered = {
        "stream_id": "mock-host:mock-session",
        "correlated_daemon_seq": 31,
        "optimistic_id": optimistic_id,
        "attachment_count": attachment_count,
    }
    if send_state is not None:
        rendered["send_state"] = send_state
    return [
        _event("chat:ws_open", 1.0),
        _event("harness:session_screen_mount", 2.0, stream_id="mock-host:mock-session"),
        _event("chat.compose.optimistic_insert", 3.0, stream_id="mock-host:mock-session", optimistic_id=optimistic_id),
        _event(
            "harness:send_fixture_image_sent",
            3.5,
            stream_id="mock-host:mock-session",
            status="ok",
            has_text=has_text,
            attachment_count=1,
        ),
        _event("chat.compose.optimistic_reconciled", 4.0, stream_id="mock-host:mock-session", optimistic_id=optimistic_id),
        _event("chat:event_rendered", 5.0, **rendered),
    ]


def _failure_retry_events() -> list[_Event]:
    events = _events()
    optimistic_id = "optimistic_mock_host_mock_session_1"
    return [
        *events[:4],
        _event(
            "chat.compose.optimistic_failed",
            3.8,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
            reason="scripted_send_failure",
        ),
        _event(
            "chat.compose.optimistic_retry",
            3.9,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
        ),
        _event(
            "harness:retry_failed_send_sent",
            4.0,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
            status="ok",
        ),
        *events[4:],
    ]


def _failure_retry_events_with_rendered_failed_state() -> list[_Event]:
    events = _events()
    optimistic_id = "optimistic_mock_host_mock_session_1"
    return [
        *events[:4],
        _event(
            "chat:event_rendered",
            3.8,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
            send_state="failed",
        ),
        _event(
            "chat.compose.optimistic_retry",
            3.9,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
        ),
        _event(
            "harness:retry_failed_send_sent",
            4.0,
            stream_id="mock-host:mock-session",
            optimistic_id=optimistic_id,
            status="ok",
        ),
        *events[4:],
    ]


def _patch_daemon(monkeypatch, *, local_path_leaked: bool = False) -> None:
    def fake_await(_path: Path, event: str, *, timeout_s: float = 30.0):
        if event == "upload.ok":
            return {"event": "upload.ok", "blob_sha": "sha-fixture", "size_bytes": 68}
        if event == "send.received":
            return {"event": "send.received", "attachment_count": 1, "has_localPath": local_path_leaked}
        if event == "send.failed":
            return {"event": "send.failed", "reason": "scripted_send_failure"}
        raise AssertionError(event)

    monkeypatch.setattr(scenario, "_await_daemon_log", fake_await)
    monkeypatch.setattr(scenario, "_count_daemon_logs", lambda _path, event: 2 if event == "send.received" else 1)


def test_mock_attachment_send_reconcile_passes_on_upload_send_reconcile(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = scenario.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": "caption from fixture"},
        _Stream(_events()),
    )

    assert verdict.verdict == "PASS"
    assert verdict.extras["optimistic_id"] == "optimistic_mock_host_mock_session_1"


def test_mock_attachment_photo_only_reconcile_uses_empty_text_and_same_assertions(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)
    params = mock_attachment_photo_only_reconcile.params({})

    verdict = mock_attachment_photo_only_reconcile.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": ""},
        _Stream(_events(has_text=False)),
    )

    assert params["text"] == ""
    assert params["image_name"] == "mock-attachment-photo-only.png"
    assert verdict.name == "mock_attachment_photo_only_reconcile"
    assert verdict.verdict == "PASS"


def test_mock_attachment_photo_only_reconcile_fails_if_action_dispatches_text(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = mock_attachment_photo_only_reconcile.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": ""},
        _Stream(_events(has_text=True)),
    )

    assert verdict.verdict == "FAIL"
    assert "text-shape mismatch" in str(verdict.error)


def test_mock_attachment_send_failure_retry_requires_failure_then_retry(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)
    params = mock_attachment_send_failure_retry.params({})

    verdict = mock_attachment_send_failure_retry.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": "caption from fixture"},
        _Stream(_failure_retry_events()),
    )

    assert params["mock_fixture_path"].endswith("attachment_send_failure_retry.json")
    assert verdict.name == "mock_attachment_send_failure_retry"
    assert verdict.verdict == "PASS"
    assert verdict.extras["retry_action"]["status"] == "ok"


def test_mock_attachment_send_failure_retry_accepts_rendered_failed_state(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = mock_attachment_send_failure_retry.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": "caption from fixture"},
        _Stream(_failure_retry_events_with_rendered_failed_state()),
    )

    assert verdict.verdict == "PASS"
    assert verdict.extras["failure"]["send_state"] == "failed"


def test_mock_attachment_send_failure_retry_fails_without_visible_failure(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = mock_attachment_send_failure_retry.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl"), "text": "caption from fixture"},
        _Stream(_events()),
    )

    assert verdict.verdict == "FAIL"
    assert "missing failed optimistic state" in str(verdict.error)


def test_mock_attachment_send_reconcile_fails_if_local_path_leaks(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch, local_path_leaked=True)

    verdict = scenario.run({"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl")}, _Stream(_events()))

    assert verdict.verdict == "FAIL"
    assert "localPath" in str(verdict.error)


def test_mock_attachment_send_reconcile_fails_if_render_stuck_sending(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = scenario.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl")},
        _Stream(_events(send_state="sending")),
    )

    assert verdict.verdict == "FAIL"
    assert "send_state=sending" in str(verdict.error)


def test_mock_attachment_send_reconcile_fails_if_echo_loses_attachment(monkeypatch, tmp_path) -> None:
    _patch_daemon(monkeypatch)

    verdict = scenario.run(
        {"scripted_daemon_log_path": str(tmp_path / "daemon.jsonl")},
        _Stream(_events(attachment_count=0)),
    )

    assert verdict.verdict == "FAIL"
    assert "missing attachment_count" in str(verdict.error)
def test_attachment_send_opens_session_before_fixture_image() -> None:
    assert scenario.actions({}) == ["autoaccept_biometric", "open_existing_chat", "send_fixture_image"]

