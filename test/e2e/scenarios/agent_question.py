"""Agent-question L3 — simulator-safe scripted daemon walk.

The local scripted daemon injects an `agent_question.v1` notification with four
options, waits for the mobile app to resolve it, and then emits a follow-up
assistant event. The scenario asserts the redesigned question:card_rendered
contract (exact counts), notification resolution, daemon resolve payload, and
post-answer progress without requiring a live Claude session or production
daemon. The legacy chat:question_rendered event is retired and explicitly
denied.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import (
    DEFAULT_DENY_LIST,
    EventSpec,
    Verdict,
    assert_no_events,
    await_event,
)


name = "agent_question"

ANSWER_OPTION = "2"
MARKER = "Mock agent question"
NOTE = "simulator scripted agent_question"

NOISE_RE = re.compile(
    r"[\u2500-\u257f]|^\s*[>\u203a\u276f]\s|^\s*(reconnect ok|connected|connecting|disconnected)\s*$",
    re.I,
)


def actions(_config):
    # autoaccept_biometric + disable_pentacle_auth are the standard cold-launch
    # unblockers. spawn_chat_then_send spawns the claude chat + sends the
    # question-forcing prompt. dismiss_question waits for the pending question
    # and answers it (runs AFTER the card renders — the action's own
    # waitForPendingQuestion gates on the session carrying a question).
    return [
        "autoaccept_biometric",
        "open_existing_chat",
        "resolve_notification",
        # The redesigned question surface lives behind the question FAB; this
        # armed action performs the user-equivalent FAB press so the overlay
        # (and question:card_rendered) renders.
        "auto_open_question_overlay",
    ]


def _fixture_path(config: dict) -> Path:
    run_id = str(
        config.get("scenario_run_id")
        or config.get("RUN_ID")
        or config.get("PENTACLE_RUN_ID")
        or f"mock-{int(time.time())}"
    )
    return Path("/tmp") / f"pentacle-agent-question-{run_id}.json"


def _write_fixture(path: Path) -> None:
    question = {
        "schema_version": 1,
        "question_id": "mock-agent-question-main",
        "title": MARKER,
        "body": "Pick one option.",
        "dedup_key": "mock-agent-question-main",
        "producer_stream_id": M.STREAM_ID,
        "producer_provider": M.PROVIDER,
        "response_mode": "single_choice",
        "options": [
            {"label": "1", "value": "1"},
            {"label": "2", "value": "2"},
            {"label": "3", "value": "3"},
            {"label": "4", "value": "4"},
        ],
        "ttl_seconds": 3600,
    }
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": {
            "stream_id": M.STREAM_ID,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": M.SESSION_NAME,
            "title": "Mock agent question",
        },
        "snapshot": {"sessions": [], "events": []},
        "frames": [
            {
                "id": "anchor",
                "at_ms": 0,
                "type": "chat.event",
                "wait_for_client": True,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 40,
                    "timestamp": "2026-07-09T18:30:00.000Z",
                    "text": "Ready for a scripted question.",
                },
            },
            {
                "id": "after-answer",
                "at_ms": 1500,
                "type": "chat.event",
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 41,
                    "timestamp": "2026-07-09T18:30:01.000Z",
                    "text": "2",
                },
            },
        ],
        "notifications": [
            {
                "id": "question",
                "at_ms": 1,
                "wait_for_client": True,
                "await_resolve": True,
                "resolve_timeout_s": 30,
                "notification": {
                    "producer": "agent_question.v1",
                    "severity": "info",
                    "title": MARKER,
                    "body": "Pick one option.",
                    "actions": [
                        {
                            "kind": "ack",
                            "action_id": "answer-2",
                            "label": "Answer 2",
                            "value": ANSWER_OPTION,
                        }
                    ],
                    "question": question,
                },
            }
        ],
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def params(config):
    fixture = _fixture_path(config)
    _write_fixture(fixture)
    base = M.params_for_fixture(config, fixture.name)
    base["mock_fixture_path"] = str(fixture)
    base["scripted_daemon_fixture_path"] = str(fixture)
    base["action_kind"] = "ack"
    base["marker"] = MARKER
    base["selection"] = ANSWER_OPTION
    base["note"] = NOTE
    # Questions render in the FAB/overlay redesign; the retired legacy
    # chat:question_rendered gate (resolve_after_question_rendered) is gone.
    # The armed resolve is sequenced by delay instead: the overlay auto-open
    # render lands ~1-2s after the notification applies at mock pacing, and
    # the scenario still enforces render-before-resolve causally via
    # not_before= chaining, so a late render fails closed.
    base["resolve_delay_ms"] = "8000"
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _rendered_noise_rows(stream, stream_id: str, start: float, end: float):
    rows = []
    for event in stream.all_events():
        if event.received_at < start or event.received_at > end:
            continue
        if event.message != "harness:row_rendered":
            continue
        if str(event.data.get("stream_id") or "") != stream_id:
            continue
        if str(event.data.get("lifecycle") or "mount") != "mount":
            continue
        text = str(event.data.get("text_prefix") or "")
        if NOISE_RE.search(text):
            rows.append(event)
    return rows


def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")

    verdict = Verdict(name=name, verdict="PASS")

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
    stream_id = M.STREAM_ID

    card = await_event(
        stream,
        EventSpec("question:card_rendered", where={"stream_id": stream_id}, timeout_s=20),
        not_before=frame.received_at,
    )
    if not card:
        return Verdict(name=name, verdict="FAIL", error="question:card_rendered absent").finish()
    # Exact redesigned-contract counts: one single-choice question with the
    # fixture's four non-meta options and no free-text item.
    expected_counts = {
        "option_count": 4,
        "question_count": 1,
        "option_counts": [4],
        "free_text_count": 0,
    }
    actual_counts = {key: card.data.get(key) for key in expected_counts}
    if actual_counts != expected_counts:
        return Verdict(
            name=name,
            verdict="FAIL",
            error=f"question:card_rendered counts mismatch (expected {expected_counts}, got {actual_counts})",
            extras={"stream_id": stream_id, "card_rendered": dict(card.data)},
        ).finish()
    verdict.extras["card_counts"] = actual_counts

    # 3. resolve_notification must send the answer over the local daemon RPC.
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
        verdict.verdict = "FAIL"
        verdict.error = "scripted agent_question notification did not resolve through mobile"
        if cap:
            cap.screenshot(f"{name}_end")
        return verdict.finish()
    verdict.extras["answered_option"] = ANSWER_OPTION

    noise_rows = _rendered_noise_rows(stream, stream_id, card.received_at, settled.received_at)
    if noise_rows:
        verdict.verdict = "FAIL"
        verdict.error = "pane/TUI noise rendered while a question was pending"
        verdict.extras["noise_rows"] = [event.to_dict() for event in noise_rows[:5]]
        if cap:
            cap.screenshot(f"{name}_end")
        return verdict.finish()

    # 4. The scripted daemon emits a follow-up assistant event only after the
    #    mobile answer resolves, proving the local question round-trip cleared.
    proceeded = await_event(
        stream,
        EventSpec("chat:event_received", where={"stream_id": stream_id}, timeout_s=90),
        not_before=settled.received_at,
    )
    if not proceeded:
        verdict.verdict = "FAIL"
        verdict.error = (
            "agent did not proceed after the answer "
            "(no chat:event_received post-answer)"
        )
        if cap:
            cap.screenshot(f"{name}_end")
        return verdict.finish()

    verdict.fold_negative_watch(
        assert_no_events(
            stream,
            # chat:question_rendered is the retired legacy render event; the
            # redesigned contract is question:card_rendered and any legacy
            # emission is a regression.
            names=[*DEFAULT_DENY_LIST, "harness:resolve_notification_skipped", "notification:resolve_failed", "chat:question_rendered"],
            window_s=3,
        )
    )
    verdict.extras["stream_id"] = stream_id
    verdict.extras["notification_id"] = notification_id
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
