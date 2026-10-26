from __future__ import annotations

import time
from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import DEFAULT_DENY_LIST, EventSpec, Verdict, assert_no_events, await_event


name = "mock_agent_question_notification"
MARKER = "Mock durable question"
SELECTION = "approve"
NOTE = "mock note"
QUESTION_ID = "mock-agent-question-1"


def _fixture_path() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / "agent_question_notification.json"


def actions(config: dict) -> list[str]:
    del config
    # auto_open_question_overlay: the redesigned question surface renders in
    # the FAB-opened overlay; arm the user-equivalent press so the durable
    # card renders before the delay-sequenced armed resolve fires.
    return ["autoaccept_biometric", "open_existing_chat", "resolve_notification", "auto_open_question_overlay"]


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, "agent_question_notification.json")
    local_fixture = _fixture_path()
    base["mock_fixture_path"] = str(local_fixture)
    base["scripted_daemon_fixture_path"] = str(local_fixture)
    base["action_kind"] = "ack"
    base["marker"] = MARKER
    base["selection"] = SELECTION
    base["note"] = NOTE
    # Legacy chat:question_rendered gate retired with the FAB/overlay
    # redesign; delay-sequence the armed resolve (render-before-resolve stays
    # causal via not_before= chaining).
    base["resolve_delay_ms"] = "8000"
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _await_answered_rows(stream, *, not_before: float, timeout_s: float = 20.0) -> dict[int, object]:
    wanted = {41, 42, 43}
    deadline = time.monotonic() + timeout_s
    found: dict[int, object] = {}
    seen_ids: set[int] = set()
    while time.monotonic() < deadline:
        candidates = stream.all_events()
        next_event = stream.next_event(timeout_s=min(0.25, max(0.0, deadline - time.monotonic())))
        if next_event is not None:
            candidates.append(next_event)
        for event in candidates:
            marker = id(event)
            if marker in seen_ids:
                continue
            seen_ids.add(marker)
            if event.received_at < not_before or event.message != "chat:event_rendered":
                continue
            if event.data.get("stream_id") != M.STREAM_ID:
                continue
            seq = event.data.get("seq")
            if seq in wanted:
                found[int(seq)] = event
        if wanted.issubset(found):
            return found
    return found


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
        return Verdict(name=name, verdict="FAIL", error="durable question card did not render").finish()
    # Exact redesigned-contract counts: one single-choice question with the
    # fixture's single non-meta option.
    expected_counts = {
        "question_count": 1,
        "option_count": 1,
        "option_counts": [1],
        "free_text_count": 0,
    }
    actual_counts = {key: card.data.get(key) for key in expected_counts}
    if actual_counts != expected_counts:
        return Verdict(
            name=name,
            verdict="FAIL",
            error=f"question:card_rendered counts mismatch (expected {expected_counts}, got {actual_counts})",
            extras={"card_rendered": dict(card.data)},
        ).finish()

    # The app answers an agent question through prompt.answer (answerDaemonPrompt),
    # not notification.resolve, so the oracle is its dispatch trace followed by the
    # resolved notification the daemon broadcasts: a selection takes the stored ack action, so acked.
    sent = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "prompt_answer_dispatched", "question_id": QUESTION_ID}, timeout_s=20),
        not_before=card.received_at,
    )
    settled = await_event(
        stream,
        EventSpec("notification:frame_applied", where={"notification_id": notification_id, "state": "acked"}, timeout_s=20),
        not_before=sent.received_at if sent else card.received_at,
    )
    if not sent or not settled:
        return Verdict(name=name, verdict="FAIL", error="durable notification did not resolve through mobile").finish()

    answered_rows = _await_answered_rows(stream, not_before=0.0)
    answered_texts: dict[int, str] = {}
    for seq in (41, 42, 43):
        answered = answered_rows.get(seq)
        if not answered:
            found = ",".join(str(item) for item in sorted(answered_rows)) or "none"
            return Verdict(name=name, verdict="FAIL", error=f"answered notification event seq={seq} did not render; found={found}").finish()
        answered_text = str(answered.data.get("rendered_text") or "")
        if answered.data.get("display_rule") != "activity:question":
            return Verdict(name=name, verdict="FAIL", error=f"answered notification seq={seq} did not render as a question activity row").finish()
        if "notification.answer" in answered_text or "[tell:notification-answer-" in answered_text:
            return Verdict(name=name, verdict="FAIL", error=f"answered notification seq={seq} rendered raw JSON").finish()
        answered_texts[seq] = answered_text

    log_path = Path(str(config.get("scripted_daemon_log_path") or ""))
    resolved = M.await_daemon_resolve(log_path)
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "notification_id": notification_id,
            "card_counts": actual_counts,
            "answered_rendered_texts": answered_texts,
            "daemon_resolve": resolved,
        },
    )
    if not resolved:
        verdict.verdict = "FAIL"
        verdict.error = "scripted daemon did not record notification.resolve"
    elif resolved.get("selections") != [SELECTION] or resolved.get("custom_text") != NOTE:
        # prompt.answer carries the note as the choice's free text (v2 custom_text).
        verdict.verdict = "FAIL"
        verdict.error = "scripted daemon resolve payload did not match selections/custom_text"

    verdict.fold_negative_watch(
        assert_no_events(
            stream,
            names=[*DEFAULT_DENY_LIST, "harness:resolve_notification_skipped", "notification:resolve_failed"],
            window_s=3,
        )
    )
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
