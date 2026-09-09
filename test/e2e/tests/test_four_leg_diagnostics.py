from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    name: str
    stream_id: str
    sequence: int | None
    at: float


@dataclass(frozen=True)
class Summary:
    correlations: list[dict]
    leg_counts: dict[str, int]
    observer_present: bool
    note: str | None = None


def compute_diagnostics(events: list[Event], stream_id: str) -> Summary:
    selected = [event for event in events if event.stream_id == stream_id]
    leg_for = {
        "service:event": "service",
        "transport:received": "transport",
        "state:applied": "state",
        "view:row": "view",
    }
    counts = {"service": 0, "transport": 0, "state": 0, "view": 0}
    correlations: dict[tuple[str, int], dict] = {}
    for event in selected:
        leg = leg_for.get(event.name)
        if leg:
            counts[leg] += 1
        if event.sequence is not None and leg:
            key = (event.stream_id, event.sequence)
            correlations.setdefault(key, {"key": f"{event.stream_id}:{event.sequence}", "legs": []})
            correlations[key]["legs"].append(leg)
    return Summary(
        correlations=list(correlations.values()),
        leg_counts=counts,
        observer_present=any(event.name == "service:event" for event in selected),
        note=None if selected else "event log empty or missing",
    )


STREAM_ID = "hostc:sample"


def test_empty_trace_emits_empty_diagnostic() -> None:
    summary = compute_diagnostics([], STREAM_ID)
    assert summary.correlations == []
    assert summary.leg_counts == {"service": 0, "transport": 0, "state": 0, "view": 0}
    assert summary.observer_present is False


def test_four_legs_correlate_via_sequence() -> None:
    summary = compute_diagnostics([
        Event("service:event", STREAM_ID, 42, 1.0),
        Event("transport:received", STREAM_ID, 42, 1.1),
        Event("state:applied", STREAM_ID, 42, 1.2),
        Event("view:row", STREAM_ID, 42, 1.3),
    ], STREAM_ID)
    assert summary.leg_counts == {"service": 1, "transport": 1, "state": 1, "view": 1}
    assert summary.correlations == [{
        "key": "hostc:sample:42",
        "legs": ["service", "transport", "state", "view"],
    }]


def test_stream_hint_filters_other_streams() -> None:
    summary = compute_diagnostics([
        Event("transport:received", "hostb:other", 1, 0.0),
        Event("transport:received", STREAM_ID, 9, 0.1),
    ], STREAM_ID)
    assert summary.leg_counts["transport"] == 1
    assert summary.correlations[0]["key"] == "hostc:sample:9"


def test_missing_observer_is_reported_without_a_trace() -> None:
    summary = compute_diagnostics([
        Event("view:row", STREAM_ID, 42, 1.0),
    ], STREAM_ID)
    assert summary.observer_present is False
    assert summary.note is None
