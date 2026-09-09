from __future__ import annotations

from dataclasses import dataclass

import pytest


STREAM_ID = "hostc:stream-1"
RUN_ID = "run-1"
EXPECTED = [
    {"seq": 100, "kind": "USER"},
    {"seq": 101, "kind": "ASSIST_TEXT"},
    {"seq": 102, "kind": "SYSTEM"},
    {"seq": 110, "kind": "USER"},
    {"seq": 111, "kind": "ASSIST_TEXT"},
]
RENDERABLE = {101, 102, 111}


@dataclass(frozen=True)
class TraceEvent:
    name: str
    stream_id: str
    seq: int | None
    at: float
    run_id: str = RUN_ID
    projection: tuple[int, ...] | None = None


def assert_event_continuity(
    trace: list[TraceEvent],
    stream_id: str,
    expected: list[dict],
    *,
    run_id: str = RUN_ID,
    expected_complete: bool = True,
    render_target_ms: float = 2000.0,
) -> tuple[bool, str | None, dict]:
    expected_seqs = [item["seq"] for item in expected]
    received = {
        event.seq for event in trace
        if event.name == "event.received" and event.stream_id == stream_id
        and event.seq is not None
    }
    rendered = {
        event.seq for event in trace
        if event.name == "row.rendered" and event.stream_id == stream_id
        and event.seq is not None
    }
    foreign = sum(
        event.name == "event.received" and event.stream_id != stream_id
        for event in trace
    )
    projections = [
        event for event in trace
        if event.name == "render.projection"
        and event.stream_id == stream_id
        and event.run_id == run_id
        and event.projection is not None
    ]
    projection = projections[-1].projection if projections else None
    projection_values = list(projection or ())
    duplicate_projection = sorted({
        value for value in projection_values if projection_values.count(value) > 1
    })
    missing = [seq for seq in expected_seqs if seq not in received]
    final_seq = expected_seqs[-1]
    final_received = final_seq in received
    final_rendered = final_seq in rendered
    final_received_at = next(
        (event.at for event in trace if event.name == "event.received"
         and event.stream_id == stream_id and event.seq == final_seq),
        None,
    )
    final_rendered_at = next(
        (event.at for event in trace if event.name == "row.rendered"
         and event.stream_id == stream_id and event.seq == final_seq),
        None,
    )
    later = sorted({
        event.seq for event in trace
        if event.name == "event.received" and event.stream_id == stream_id
        and event.seq is not None and event.seq > final_seq
    })
    turns = sum(item["kind"] == "USER" for item in expected) >= 2 and final_received
    info = {
        "expected_count": len(expected_seqs),
        "received_count": len(received),
        "missing": missing,
        "foreign_stream_events": foreign,
        "final_event_received": final_received,
        "final_event_rendered": final_rendered,
        "final_event_render_ms": (
            (final_rendered_at - final_received_at) * 1000
            if final_received_at is not None and final_rendered_at is not None else None
        ),
        "render_projection_complete": (
            projection_values == expected_seqs
            and not duplicate_projection
        ),
        "duplicate_rendered": duplicate_projection,
        "later_than_final": later,
        "journey_turns_present": turns,
        "final_event_render_within_target": (
            final_rendered_at is not None and final_received_at is not None
            and (final_rendered_at - final_received_at) * 1000 <= render_target_ms
        ),
    }
    failures = []
    if not expected_complete:
        failures.append("INCONCLUSIVE: expected event set is incomplete")
    if missing:
        failures.append(f"missing events: {missing}")
    if foreign:
        failures.append("foreign stream events were observed")
    if not info["render_projection_complete"]:
        failures.append("logical render projection is absent or incomplete")
    if duplicate_projection:
        failures.append(f"duplicate RENDERED seq(s): {duplicate_projection}")
    if later:
        failures.append(f"events later than final: {later}")
    if not turns:
        failures.append("driven journey is incomplete")
    if final_received and not final_rendered:
        failures.append("final event was not rendered")
    return not failures, "; ".join(failures) or None, info


def _good_trace(render_offset: float = 0.05) -> list[TraceEvent]:
    trace = []
    at = 1000.0
    for item in EXPECTED:
        trace.append(TraceEvent("event.received", STREAM_ID, item["seq"], at))
        if item["seq"] in RENDERABLE:
            trace.append(TraceEvent("row.rendered", STREAM_ID, item["seq"], at + render_offset))
        at += 1.0
    trace.append(TraceEvent(
        "render.projection", STREAM_ID, None, at,
        projection=tuple(item["seq"] for item in EXPECTED),
    ))
    return trace


def test_complete_trace_passes() -> None:
    ok, error, info = assert_event_continuity(_good_trace(), STREAM_ID, EXPECTED)
    assert ok, error
    assert info["received_count"] == len(EXPECTED)
    assert info["missing"] == []
    assert info["final_event_rendered"] is True


def test_global_sequence_gaps_do_not_fail() -> None:
    ok, error, info = assert_event_continuity(_good_trace(), STREAM_ID, EXPECTED)
    assert ok, error
    assert info["foreign_stream_events"] == 0


def test_missing_final_event_fails() -> None:
    trace = [event for event in _good_trace() if event.seq != 111]
    ok, _, info = assert_event_continuity(trace, STREAM_ID, EXPECTED)
    assert not ok
    assert 111 in info["missing"]


def test_final_event_received_without_row_fails() -> None:
    trace = [event for event in _good_trace()
             if not (event.name == "row.rendered" and event.seq == 111)]
    ok, _, info = assert_event_continuity(trace, STREAM_ID, EXPECTED)
    assert not ok
    assert info["final_event_rendered"] is False


def test_projection_is_required_and_must_match_the_run() -> None:
    trace = [event for event in _good_trace() if event.name != "render.projection"]
    ok, error, info = assert_event_continuity(trace, STREAM_ID, EXPECTED)
    assert not ok
    assert info["render_projection_complete"] is False
    assert "logical render projection" in (error or "")

    stale = _good_trace()[:-1] + [
        TraceEvent("render.projection", STREAM_ID, None, 1100, run_id="other",
                   projection=tuple(item["seq"] for item in EXPECTED)),
    ]
    assert not assert_event_continuity(stale, STREAM_ID, EXPECTED)[0]


def test_foreign_stream_and_later_events_fail() -> None:
    trace = _good_trace() + [
        TraceEvent("event.received", "hostb:stream-2", 999, 1300),
        TraceEvent("event.received", STREAM_ID, 120, 1400),
    ]
    ok, _, info = assert_event_continuity(trace, STREAM_ID, EXPECTED)
    assert not ok
    assert info["foreign_stream_events"] == 1
    assert info["later_than_final"] == [120]


def test_duplicate_projection_fails() -> None:
    trace = _good_trace()[:-1] + [
        TraceEvent("render.projection", STREAM_ID, None, 1100,
                   projection=(100, 101, 102, 110, 111, 111)),
    ]
    ok, error, info = assert_event_continuity(trace, STREAM_ID, EXPECTED)
    assert not ok
    assert info["duplicate_rendered"] == [111]
    assert "duplicate" in (error or "")


def test_incomplete_expected_set_is_inconclusive() -> None:
    ok, error, _ = assert_event_continuity(
        _good_trace(), STREAM_ID, EXPECTED, expected_complete=False,
    )
    assert not ok
    assert "INCONCLUSIVE" in (error or "")


def test_late_render_is_reported_but_not_rejected() -> None:
    ok, error, info = assert_event_continuity(
        _good_trace(render_offset=5.0), STREAM_ID, EXPECTED, render_target_ms=2000,
    )
    assert ok, error
    assert info["final_event_render_within_target"] is False
