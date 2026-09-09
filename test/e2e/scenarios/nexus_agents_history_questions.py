from __future__ import annotations

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event

SCENARIO_META = {"target_compat": {"simulator", "device"}, "requires": []}

name = "assistant_history_questions"
CHILD_STREAM_ID = "mock-host:child-worker"
CHILD_NAME = "History worker"
HISTORY_TEXT = "Render the visible roster and history."


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "resolve_notification"]


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, "assistant_history_questions.json")
    base.update({
        "openStatus": "1",
        "agentHistory": CHILD_STREAM_ID,
        "agentHistoryGeneration": "child-generation",
        "action_kind": "ack",
        "marker": "History question",
        "text": "Scenario free-text assertion.",
    })
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    del repo_root
    return M.preflight(config)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    roster = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "assistant_roster_rendered"}, timeout_s=25),
    )
    history = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "assistant_history_rendered", "child_stream_id": CHILD_STREAM_ID}, timeout_s=25),
        not_before=roster.received_at if roster else None,
    )
    answer = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "prompt_answer_dispatched", "question_id": "history-question"}, timeout_s=25),
        not_before=roster.received_at if roster else None,
    )
    failures: list[str] = []
    if not roster or CHILD_STREAM_ID not in roster.data.get("child_stream_ids", []):
        failures.append("Assistant roster did not render the direct child ID")
    if not roster or CHILD_NAME not in roster.data.get("child_names", []):
        failures.append("Assistant roster did not render the direct child name")
    if not history or HISTORY_TEXT not in history.data.get("row_texts", []):
        failures.append("history did not render the synthetic tell row")
    if not answer or answer.data.get("text_present") is not True:
        failures.append("durable free-text answer did not dispatch prompt.answer")
    if cap:
        cap.screenshot(name)
    return Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "child_stream_id": CHILD_STREAM_ID,
            "roster": dict(roster.data) if roster else None,
            "history": dict(history.data) if history else None,
            "prompt_answer": dict(answer.data) if answer else None,
        },
    ).finish()
