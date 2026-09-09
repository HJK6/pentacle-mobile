"""Self-checks for the public strict-order assertion library.

The cases use synthetic traces to cover ordered steps, groups, negative watches,
count bounds, predicates, terminators, and repeated cycles.
"""
from __future__ import annotations

import _assertions as A


def _ev(name: str, **data) -> dict:
    return {"name": name, "data": data, "timestamp": 0.0}


def test_passing_synthetic_trace_passes():
    steps = [
        A.strict("harness:harness_armed"),
        A.strict("chat:ws_open"),
        A.strict("harness:session_screen_mount", where=lambda d: d.get("stream_id") == "X"),
    ]
    trace = [
        _ev("harness:harness_armed"),
        _ev("chat:ws_open"),
        _ev("harness:session_screen_mount", stream_id="X"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)
    assert result.strict_pass_count == 3
    assert result.strict_total == 3


def test_out_of_strict_order_fails():
    steps = [
        A.strict("A_event"),
        A.strict("B_event"),
    ]
    # B precedes A in the trace, so A_event will only match AFTER cursor
    # advances past B... but the strict cursor for A starts at 0, finds A
    # at index 1, then B's cursor is at 2 — but B is at index 0, before
    # cursor. We expect FAIL.
    trace = [
        _ev("B_event"),
        _ev("A_event"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert not result.passed, A.format_failure_report(result)
    assert result.out_of_order, "expected out_of_order to be non-empty"


def test_off_by_count_fails():
    # Expect exactly 1, supply 2 — the strict-count enforcement rejects this.
    steps = [A.strict("X", count=1)]
    trace = [_ev("X"), _ev("X")]
    result = A.TelemetryAssertion(steps).check(trace)
    assert not result.passed, A.format_failure_report(result)
    # Either out_of_order or missing — both signal a count violation.
    assert result.out_of_order or result.missing


def test_within_group_reorder_passes():
    steps = [
        A.strict("start"),
        A.group("g1", "alpha"),
        A.group("g1", "beta"),
        A.strict("end"),
    ]
    # alpha and beta swap order — group should allow this.
    trace = [
        _ev("start"),
        _ev("beta"),
        _ev("alpha"),
        _ev("end"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)
    assert result.group_pass_count == 2
    assert result.group_total == 2


def test_negative_watch_violation_fails():
    steps = [
        A.strict("ok_event"),
        A.neg("bad_event"),
    ]
    trace = [
        _ev("ok_event"),
        _ev("bad_event"),  # this should trip the NEG
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert not result.passed
    assert result.neg_violations, "expected neg_violations to be populated"


def test_where_predicate_filters_count():
    # Expect exactly 1 chat:event_rendered with stream_id == 'X'.
    # Trace has two chat:event_rendered, one for X, one for Y.
    steps = [
        A.strict(
            "chat:event_rendered",
            count=1,
            where=lambda d: d.get("stream_id") == "X",
        ),
    ]
    trace = [
        _ev("chat:event_rendered", stream_id="X"),
        _ev("chat:event_rendered", stream_id="Y"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)


def test_gte_count_lower_bound_passes():
    steps = [A.strict("X", count=A.gte(2))]
    trace = [_ev("X"), _ev("X"), _ev("X")]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)


def test_terminator_xor_passes_with_option_a():
    steps = [
        A.strict("anchor"),
        A.terminator(
            option_a=("reconciled", None),
            option_b=("failed", None),
        ),
    ]
    trace = [
        _ev("anchor"),
        _ev("reconciled"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)
    assert result.terminator_outcome == "A"


def test_terminator_xor_fails_when_both_appear():
    steps = [
        A.strict("anchor"),
        A.terminator(
            option_a=("reconciled", None),
            option_b=("failed", None),
        ),
    ]
    trace = [
        _ev("anchor"),
        _ev("reconciled"),
        _ev("failed"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert not result.passed
    assert result.missing  # XOR violation reports via missing/diagnostic


def test_multi_cycle_same_predicate_passes():
    """flow multi-cycle regression: two cycles of optimistic_insert /
    optimistic_reconciled with the same stream_id predicate, each step
    declared count=1. Strict-count must be windowed to [cursor, next-strict)
    so each cycle's events fall in their own window — not summed.
    """
    P = lambda d: d.get("stream_id") == "S1"
    steps = [
        A.strict(
            "chat.compose.optimistic_insert",
            count=1,
            where=P,
            label="11 optimistic_insert_1",
        ),
        A.strict(
            "chat.compose.optimistic_reconciled",
            count=1,
            where=P,
            label="15 reconciled_1",
        ),
        A.strict(
            "chat.compose.optimistic_insert",
            count=1,
            where=P,
            label="17 optimistic_insert_2",
        ),
        A.strict(
            "chat.compose.optimistic_reconciled",
            count=1,
            where=P,
            label="20 reconciled_2",
        ),
    ]
    trace = [
        _ev("chat.compose.optimistic_insert", stream_id="S1", optimistic_id="a"),
        _ev("chat.compose.optimistic_reconciled", stream_id="S1", optimistic_id="a"),
        _ev("chat.compose.optimistic_insert", stream_id="S1", optimistic_id="b"),
        _ev("chat.compose.optimistic_reconciled", stream_id="S1", optimistic_id="b"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert result.passed, A.format_failure_report(result)
    assert result.strict_pass_count == 4
    assert result.strict_total == 4


def test_off_by_one_within_window_fails():
    """3 optimistic_insert events but only 2 STRICT steps with count=1 each.
    The first strict step's window covers events up to the next strict
    step's first match — so the second insert is the next-anchor and the
    first window contains exactly 1 (PASS for step 1). The second strict
    step's window then contains 2 inserts (the second and third) against
    an exact count of 1 — FAIL.
    """
    P = lambda d: d.get("stream_id") == "S1"
    steps = [
        A.strict("chat.compose.optimistic_insert", count=1, where=P, label="insert_1"),
        A.strict("chat.compose.optimistic_insert", count=1, where=P, label="insert_2"),
    ]
    trace = [
        _ev("chat.compose.optimistic_insert", stream_id="S1", optimistic_id="a"),
        _ev("chat.compose.optimistic_insert", stream_id="S1", optimistic_id="b"),
        _ev("chat.compose.optimistic_insert", stream_id="S1", optimistic_id="c"),
    ]
    result = A.TelemetryAssertion(steps).check(trace)
    assert not result.passed, A.format_failure_report(result)
    assert result.out_of_order or result.missing

