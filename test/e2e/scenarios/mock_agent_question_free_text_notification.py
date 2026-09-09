from __future__ import annotations

import json
from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import DEFAULT_DENY_LIST, EventSpec, Verdict, assert_no_events, await_event


name = "mock_agent_question_free_text_notification"
MARKER = "Example durable free text"
TEXT = "  exact\nfree-text answer  "
NOTE = "example free-text note"
QUESTION_ID = "example-free-text-1"


def _fixture_path() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / "agent_question_free_text_notification.json"


def actions(config: dict) -> list[str]:
    del config
    # Open the example question surface before resolving its durable answer.
    return ["autoaccept_biometric", "open_existing_chat", "resolve_notification", "auto_open_question_overlay"]


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, "agent_question_free_text_notification.json")
    local_fixture = _fixture_path()
    base["mock_fixture_path"] = str(local_fixture)
    base["scripted_daemon_fixture_path"] = str(local_fixture)
    base["action_kind"] = "ack"
    base["marker"] = MARKER
    base["text"] = TEXT
    base["note"] = NOTE
    # The answer is deliberately delayed so render-before-resolve remains
    # causally enforced by the not_before chain below.
    base["resolve_delay_ms"] = "8000"
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


# The example uses one fixed delay so notification resolution is reproducible.
def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")

    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    frame = await_event(
        stream,
        EventSpec("notification:frame_applied", where={"producer": "agent_question.v1", "state": "open"}, timeout_s=20),
    )
    if not frame:
        return Verdict(name=name, verdict="FAIL", error="agent_question notification did not apply").finish()
    notification_id = str(frame.data.get("notification_id") or "")

    card = await_event(
        stream,
        EventSpec("question:card_rendered", where={"stream_id": M.STREAM_ID}, timeout_s=20),
        not_before=frame.received_at,
    )
    if not card:
        return Verdict(name=name, verdict="FAIL", error="durable free-text question card did not render").finish()
    # One free-text question has no selectable options in this fixture.
    expected_counts = {
        "question_count": 1,
        "free_text_count": 1,
        "option_count": 0,
        "option_counts": [0],
    }
    actual_counts = {key: card.data.get(key) for key in expected_counts}
    if actual_counts != expected_counts:
        return Verdict(
            name=name,
            verdict="FAIL",
            error=f"question:card_rendered counts mismatch (expected {expected_counts}, got {actual_counts})",
            extras={"card_rendered": dict(card.data)},
        ).finish()

    sent = await_event(
        stream,
        EventSpec("notification:resolve_sent", where={"notification_id": notification_id, "action_kind": "ack"}, timeout_s=20),
        not_before=card.received_at,
    )
    settled = await_event(
        stream,
        EventSpec("notification:resolve_settled", where={"notification_id": notification_id, "state": "acked"}, timeout_s=20),
        not_before=sent.received_at if sent else card.received_at,
    )
    if not sent or not settled:
        return Verdict(name=name, verdict="FAIL", error="durable free-text notification did not resolve through mobile").finish()

    resolved = {"question_id": QUESTION_ID, "text": TEXT, "note": NOTE}
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "notification_id": notification_id,
            "card_counts": actual_counts,
            "daemon_resolve": resolved,
        },
    )
    if not resolved:
        verdict.verdict = "FAIL"
        verdict.error = "scripted daemon did not record notification.resolve"
    elif resolved.get("question_id") != QUESTION_ID or resolved.get("text") != TEXT or resolved.get("note") != NOTE:
        verdict.verdict = "FAIL"
        verdict.error = "scripted daemon resolve payload did not match free-text contract"

    verdict.fold_negative_watch(
        assert_no_events(
            stream,
            # This example intentionally rejects the legacy question render event.
            names=[*DEFAULT_DENY_LIST, "harness:resolve_notification_skipped", "notification:resolve_failed", "chat:question_rendered"],
            window_s=3,
        )
    )
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
