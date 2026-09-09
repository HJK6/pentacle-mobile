"""Dry-run checks for synthetic question scenarios.

The tests use an in-memory event stream to require row-level render evidence,
reject noise, and validate free-text question counts without a device.
"""
from __future__ import annotations

from dataclasses import dataclass

import run_scenario


@dataclass
class _Event:
    message: str
    received_at: float
    data: dict

    def to_dict(self) -> dict:
        return {"message": self.message, "received_at": self.received_at, "data": dict(self.data)}


class _Stream:
    def __init__(self, events: list[_Event]) -> None:
        self._events = events

    def all_events(self) -> list[_Event]:
        return list(self._events)

    def next_event(self, timeout_s: float = 0.0) -> None:
        return None


def _event(message: str, received_at: float, **data) -> _Event:
    return _Event(message=message, received_at=received_at, data=data)


def _matches(event: _Event, spec) -> bool:
    if event.message != spec.message:
        return False
    for key, expected in (spec.where or {}).items():
        if event.data.get(key) != expected:
            return False
    return True


def _scenario(name: str):
    return run_scenario.build_scenarios(
        peer_hosts={},
        reachability=lambda *_args, **_kwargs: None,
        codex_preflight=lambda *_args, **_kwargs: None,
    )[name].module


def _patch_await(monkeypatch, scenario) -> None:
    def fake_await_event(stream_arg, spec, not_before=None):
        cutoff = not_before or 0.0
        for event in stream_arg.all_events():
            if event.received_at >= cutoff and _matches(event, spec):
                return event
        return None

    monkeypatch.setattr(scenario, "await_event", fake_await_event)


def _assist_row(received_at: float) -> _Event:
    # A rendered assistant reply row — the (c) "proceeded" evidence.
    return _event(
        "harness:row_rendered",
        received_at,
        stream_id="S1",
        lifecycle="mount",
        displayRule="bubble:assistant",
        text_prefix="the agent reply",
    )


def _multi_events(
    *,
    with_noise: bool = False,
    with_proceed_row: bool = True,
    question_count: int = 2,
    option_counts=None,
) -> list[_Event]:
    events = [
        _event("harness:spawn_chat_then_send_sent", 1.0, status="ok", stream_id="S1"),
        _event(
            "question:card_rendered",
            2.0,
            stream_id="S1",
            question_count=question_count,
            free_text_count=1,
            option_counts=([3, 1] if option_counts is None else option_counts),
            scan_incomplete=False,
            locked_count=0,
        ),
    ]
    if with_noise:
        events.append(
            _event(
                "harness:row_rendered",
                3.0,
                stream_id="S1",
                lifecycle="mount",
                text_prefix="reconnect ok",
            )
        )
    events.extend(
        [
            _event(
                "harness:dismiss_question_sent",
                4.0,
                stream_id="S1",
                answer_count=2,
                free_text_count=1,
            ),
            _event("chat:event_received", 5.0, stream_id="S1"),
        ]
    )
    if with_proceed_row:
        events.append(_assist_row(5.5))
    return events


def _note_events(
    *,
    with_noise: bool = False,
    with_proceed_row: bool = True,
    option_count: int = 3,
) -> list[_Event]:
    events = [
        _event("harness:spawn_chat_then_send_sent", 1.0, status="ok", stream_id="S1"),
        _event("question:card_rendered", 2.0, stream_id="S1", option_count=option_count),
    ]
    if with_noise:
        events.append(
            _event(
                "harness:row_rendered",
                3.0,
                stream_id="S1",
                lifecycle="mount",
                text_prefix="reconnect ok",
            )
        )
    events.extend(
        [
            _event("harness:dismiss_question_sent", 4.0, stream_id="S1", answer_count=1),
            _event("chat:event_received", 5.0, stream_id="S1"),
        ]
    )
    if with_proceed_row:
        events.append(_assist_row(5.5))
    return events


def _run(scenario, events, monkeypatch):
    _patch_await(monkeypatch, scenario)
    # (c) reply-row poll must not block on the pre-populated synthetic stream.
    monkeypatch.setattr(scenario, "PROCEEDED_REPLY_TIMEOUT_S", 0.0)
    monkeypatch.setattr(
        scenario,
        "assert_no_events",
        lambda *_args, **_kwargs: type("NW", (), {"passed": True, "fired": []})(),
    )
    return scenario.run({}, _Stream(events))


# --- agent_question_multi --------------------------------------------------


def test_agent_question_multi_passes_with_card_counts(monkeypatch) -> None:
    scenario = _scenario("agent_question_multi")
    verdict = _run(scenario, _multi_events(), monkeypatch)
    assert verdict.verdict == "PASS"
    assert verdict.extras["question_count"] == 2
    assert verdict.extras["option_counts"] == [3, 1]
    assert verdict.extras["proceeded_row"]["displayRule"] == "bubble:assistant"


def test_agent_question_multi_fails_with_single_question_card(monkeypatch) -> None:
    scenario = _scenario("agent_question_multi")
    verdict = _run(scenario, _multi_events(question_count=1, option_counts=[3]), monkeypatch)
    # The scenario classifies a single-question card as a prompt/setup problem
    # (the forcing prompt did not yield a multi-question), not a product FAIL.
    assert verdict.verdict == "SETUP_FAIL"
    assert "<2 questions" in verdict.error


def test_agent_question_multi_fails_on_pending_noise_row(monkeypatch) -> None:
    scenario = _scenario("agent_question_multi")
    verdict = _run(scenario, _multi_events(with_noise=True), monkeypatch)
    assert verdict.verdict == "FAIL"
    assert "noise" in verdict.error
    assert verdict.extras["noise_rows"]


# (b) retired 2026-07-12 with the legacy chat:question_rendered digest
# telemetry (current question surface); count-level negatives above and
# in the card assertions replace the digest negatives.


# (c) negative proof — answer landed (event_received) but no assistant reply row.
def test_agent_question_multi_fails_without_proceeded_reply_row(monkeypatch) -> None:
    scenario = _scenario("agent_question_multi")
    verdict = _run(scenario, _multi_events(with_proceed_row=False), monkeypatch)
    assert verdict.verdict == "FAIL"
    assert "no harness:row_rendered assistant row" in verdict.error


# --- agent_question_note ---------------------------------------------------


def test_agent_question_note_passes_with_card_counts(monkeypatch) -> None:
    scenario = _scenario("agent_question_note")
    verdict = _run(scenario, _note_events(), monkeypatch)
    assert verdict.verdict == "PASS"
    assert verdict.extras["proceeded_row"]["displayRule"] == "bubble:assistant"


def test_agent_question_note_fails_with_too_few_options(monkeypatch) -> None:
    scenario = _scenario("agent_question_note")
    verdict = _run(scenario, _note_events(option_count=2), monkeypatch)
    assert verdict.verdict == "FAIL"
    assert "fewer options" in verdict.error


def test_agent_question_note_fails_on_pending_noise_row(monkeypatch) -> None:
    scenario = _scenario("agent_question_note")
    verdict = _run(scenario, _note_events(with_noise=True), monkeypatch)
    assert verdict.verdict == "FAIL"
    assert "noise" in verdict.error
    assert verdict.extras["noise_rows"]


# (c) negative proof — answer landed but no assistant reply row rendered.
def test_agent_question_note_fails_without_proceeded_reply_row(monkeypatch) -> None:
    scenario = _scenario("agent_question_note")
    verdict = _run(scenario, _note_events(with_proceed_row=False), monkeypatch)
    assert verdict.verdict == "FAIL"
    assert "no harness:row_rendered assistant row" in verdict.error

