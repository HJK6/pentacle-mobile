"""Stage 7a — four_leg_diagnostics smoke coverage."""
from __future__ import annotations

import json
from pathlib import Path

from e2e.harness.four_leg_diagnostics import compute_diagnostics
from e2e.harness.telemetry_events import TelemetryEvent


STREAM_ID = "merlin:claude-merlin-test"


def _evt(message: str, data: dict, t: float) -> TelemetryEvent:
    return TelemetryEvent(
        subsystem=message.split(":", 1)[0],
        message=message,
        bug_ref="test",
        data=data,
        received_at=t,
        raw="",
    )


def test_empty_trace_emits_empty_diagnostic():
    summary = compute_diagnostics([], stream_id_hint=STREAM_ID)
    assert summary.correlations == []
    assert summary.leg_counts == {"daemon": 0, "app:ws": 0, "app:reducer": 0, "app:render": 0}
    assert summary.observer_present is False


def test_three_legs_correlate_via_daemon_seq():
    """A clean event_received -> event_rendered -> row_rendered triple with
    matching daemon_seq correlates into one row across legs 2-4."""
    events = [
        _evt("chat:event_received", {"stream_id": STREAM_ID, "daemon_seq": 42}, 1.0),
        _evt("chat:event_rendered", {"stream_id": STREAM_ID, "daemon_seq": 42}, 1.1),
        _evt(
            "harness:row_rendered",
            {"stream_id": STREAM_ID, "daemon_seq": 42, "lifecycle": "mount", "row_id": "r42"},
            1.2,
        ),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID)
    assert summary.leg_counts == {"daemon": 0, "app:ws": 1, "app:reducer": 1, "app:render": 1}
    assert len(summary.correlations) == 1
    cor = summary.correlations[0]
    assert cor.event_key == f"{STREAM_ID}:42"
    assert cor.leg_daemon is None
    assert cor.leg_ws == 1.0
    assert cor.leg_reducer == 1.1
    assert cor.leg_render == 1.2
    # Drop classification only reports gaps DOWNSTREAM of the upstream-most
    # observed leg; with the observer absent the daemon-leg gap is not
    # reported as a drop (we can't tell daemon-missing-by-design from
    # daemon-missing-by-bug without the observer).
    assert cor._drop_classification() is None


def test_ws_leg_correlates_via_seq_alias():
    events = [
        _evt("chat:event_received", {"stream_id": STREAM_ID, "seq": 42}, 1.0),
        _evt("chat:event_rendered", {"stream_id": STREAM_ID, "daemon_seq": 42}, 1.1),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID)
    assert summary.leg_counts["app:ws"] == 1
    assert len(summary.correlations) == 1
    cor = summary.correlations[0]
    assert cor.event_key == f"{STREAM_ID}:42"
    assert cor.leg_ws == 1.0
    assert cor.leg_reducer == 1.1


def test_render_missing_classification():
    """Selector fires but row_rendered never does — Bug C signature."""
    events = [
        _evt("chat:event_received", {"stream_id": STREAM_ID, "daemon_seq": 7}, 0.5),
        _evt("chat:event_rendered", {"stream_id": STREAM_ID, "daemon_seq": 7}, 0.6),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID)
    assert summary.leg_counts["app:render"] == 0
    cor = summary.correlations[0]
    # upstream-most leg is app:ws; the first downstream gap is app:render.
    assert cor._drop_classification() == "app:render missing"
    assert cor.leg_render is None


def test_row_rendered_unmount_ignored():
    """row_rendered with lifecycle=unmount must not count toward Leg 4."""
    events = [
        _evt(
            "harness:row_rendered",
            {"stream_id": STREAM_ID, "daemon_seq": 5, "lifecycle": "unmount", "row_id": "r5"},
            2.0,
        ),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID)
    assert summary.leg_counts["app:render"] == 0
    assert summary.correlations == []


def test_observer_log_loaded(tmp_path: Path):
    """Sidecar JSONL with chat.event rows populates Leg 1."""
    observer_log = tmp_path / "scenario.observer.jsonl"
    observer_log.write_text(
        "\n".join(
            json.dumps(
                {
                    "timestamp_observer_monotonic": 0.42,
                    "kind": "chat.event",
                    "stream_id": STREAM_ID,
                    "daemon_seq": 42,
                    "raw_payload": {},
                }
            )
            for _ in range(1)
        )
        + "\n"
    )
    events = [
        _evt("chat:event_received", {"stream_id": STREAM_ID, "daemon_seq": 42}, 1.0),
        _evt("chat:event_rendered", {"stream_id": STREAM_ID, "daemon_seq": 42}, 1.1),
        _evt(
            "harness:row_rendered",
            {"stream_id": STREAM_ID, "daemon_seq": 42, "lifecycle": "mount", "row_id": "r42"},
            1.2,
        ),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID, observer_path=observer_log)
    assert summary.observer_present is True
    assert summary.leg_counts == {"daemon": 1, "app:ws": 1, "app:reducer": 1, "app:render": 1}
    cor = summary.correlations[0]
    assert cor.leg_daemon == 0.42
    assert cor._drop_classification() is None  # all four legs fired


def test_observer_log_missing_returns_note(tmp_path: Path):
    """Pointing at a missing observer log keeps Leg 1 absent + emits a note."""
    summary = compute_diagnostics(
        [],
        stream_id_hint=STREAM_ID,
        observer_path=tmp_path / "missing.observer.jsonl",
    )
    assert summary.observer_present is False
    assert summary.note and "observer log empty or missing" in summary.note


def test_stream_hint_filters_other_streams():
    events = [
        _evt("chat:event_received", {"stream_id": "other:1", "daemon_seq": 1}, 0.0),
        _evt("chat:event_received", {"stream_id": STREAM_ID, "daemon_seq": 9}, 0.1),
    ]
    summary = compute_diagnostics(events, stream_id_hint=STREAM_ID)
    assert summary.leg_counts["app:ws"] == 1
    assert summary.correlations[0].event_key == f"{STREAM_ID}:9"
