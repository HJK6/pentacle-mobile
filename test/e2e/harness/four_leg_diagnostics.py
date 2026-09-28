"""Four-leg observability diagnostics for the E2E harness runner.

Stage 7a of spec_pentacle_mobile_harness_observability_extension_2026_05_16.

Computes a per-scenario "four-leg" correlation summary from the in-memory
telemetry trace:

  Leg 1: daemon — chat.event_sent (from harness_observer sidecar log)
  Leg 2: app:ws — chat:event_received
  Leg 3: app:reducer — chat:event_rendered (selector)
  Leg 4: app:render — harness:row_rendered (lifecycle=mount)

This is **diagnostics-only**. Scenario PASS/FAIL is not affected by this
module; it attaches a structured artifact to the runner's verdict
payload so post-hoc inspection of any F1-F4 / F5-F8 run produces an
"X observed events, Y reached the selector, Z mounted as rows" tally
without re-running the scenario.

Per spec §"Correlation schema":
  - Daemon-originated transcript events join key `stream_id:daemon_seq`.
  - Optimistic user rows join key `stream_id:optimistic:<optimistic_id>`.
  - Component lifecycle events (WorkingDock etc.) are tracked but not
    cross-leg-correlated by this module; they appear in legs 3+4 only.
  - Fallback / uncorrelated rows are reported via `uncorrelated_fallback`.

Leg 1 is loaded from an optional sidecar JSONL produced by the daemon
observer at `runs/<stem>.observer.jsonl`. If absent, Leg 1 columns are
recorded as `None` and the diagnostic still emits the three-leg view.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .telemetry_events import TelemetryEvent


LEG_NAMES = ("daemon", "app:ws", "app:reducer", "app:render")
LEG_EVENT_NAMES = {
    "app:ws": "chat:event_received",
    "app:reducer": "chat:event_rendered",
    "app:render": "harness:row_rendered",
}


@dataclass
class ObserverRow:
    """Subset of harness_observer.ObserverLogRow needed for correlation."""
    timestamp_observer_monotonic: float
    kind: str
    stream_id: str | None
    daemon_seq: int | None


@dataclass
class LegCorrelation:
    """Per-event row across the four legs."""
    event_key: str
    leg_daemon: float | None = None
    leg_ws: float | None = None
    leg_reducer: float | None = None
    leg_render: float | None = None
    text_prefix: str | None = None
    daemon_seq: int | None = None

    def to_dict(self) -> dict:
        return {
            "event_key": self.event_key,
            "daemon_seq": self.daemon_seq,
            "text_prefix": self.text_prefix,
            "timestamps": {
                "daemon": self.leg_daemon,
                "app:ws": self.leg_ws,
                "app:reducer": self.leg_reducer,
                "app:render": self.leg_render,
            },
            "drop_classification": self._drop_classification(),
        }

    def _drop_classification(self) -> str | None:
        legs = [self.leg_daemon, self.leg_ws, self.leg_reducer, self.leg_render]
        # If no legs fired, the event_key is uncorrelated.
        if all(v is None for v in legs):
            return "uncorrelated"
        # First non-None marks the upstream-most leg present.
        for idx, value in enumerate(legs):
            if value is not None:
                upstream = idx
                break
        # Walk forward; the first None after upstream is the drop.
        for idx in range(upstream, len(legs)):
            if legs[idx] is None:
                return f"{LEG_NAMES[idx]} missing"
        return None


@dataclass
class DiagnosticSummary:
    stream_id: str | None
    leg_counts: dict[str, int] = field(default_factory=dict)
    correlations: list[LegCorrelation] = field(default_factory=list)
    observer_present: bool = False
    observer_path: str | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        leg_drops: dict[str, int] = {}
        for cor in self.correlations:
            classification = cor._drop_classification()
            if classification:
                leg_drops[classification] = leg_drops.get(classification, 0) + 1
        return {
            "stream_id": self.stream_id,
            "leg_counts": self.leg_counts,
            "leg_drops": leg_drops,
            "correlation_count": len(self.correlations),
            "observer_present": self.observer_present,
            "observer_path": self.observer_path,
            "note": self.note,
            "correlations": [c.to_dict() for c in self.correlations[:50]],
        }


def _load_observer_rows(path: Path) -> list[ObserverRow]:
    rows: list[ObserverRow] = []
    if not path.is_file():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            raw = raw.strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = str(payload.get("kind") or "")
            if kind not in ("chat.event", "working.state"):
                continue
            rows.append(
                ObserverRow(
                    timestamp_observer_monotonic=float(
                        payload.get("timestamp_observer_monotonic") or 0.0
                    ),
                    kind=kind,
                    stream_id=payload.get("stream_id") if isinstance(payload.get("stream_id"), str) else None,
                    daemon_seq=payload.get("daemon_seq") if isinstance(payload.get("daemon_seq"), int) else None,
                )
            )
    return rows


def _event_key_for(stream_id: str | None, daemon_seq: int | None, optimistic_id: str | None) -> str:
    if stream_id and daemon_seq is not None:
        return f"{stream_id}:{daemon_seq}"
    if stream_id and optimistic_id:
        return f"{stream_id}:optimistic:{optimistic_id}"
    return "uncorrelated_fallback"


def _event_daemon_seq(data: dict) -> int | None:
    for key in ("daemon_seq", "seq"):
        value = data.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
    return None


def _key_from_event(event: TelemetryEvent) -> str | None:
    data = event.data or {}
    stream_id = data.get("stream_id") if isinstance(data.get("stream_id"), str) else None
    if not stream_id:
        return None
    daemon_seq = _event_daemon_seq(data)
    optimistic_id = data.get("optimistic_id") if isinstance(data.get("optimistic_id"), str) else None
    if daemon_seq is None and not optimistic_id:
        return None
    return _event_key_for(stream_id, daemon_seq, optimistic_id)


def compute_diagnostics(
    events: Iterable[TelemetryEvent],
    *,
    stream_id_hint: str | None = None,
    observer_path: Path | None = None,
) -> DiagnosticSummary:
    """Compute the four-leg diagnostic summary for a scenario run.

    `events` is the in-memory telemetry trace from the device/simulator
    log stream. `stream_id_hint` scopes correlation to a single stream
    when set; when None, all streams in the trace are considered (and
    multi-stream traces may produce noisier diagnostics).

    `observer_path` is the JSONL sidecar log produced by the daemon-side
    harness_observer. When absent, Leg 1 columns remain None.
    """
    events_list = list(events)
    leg_counts: dict[str, int] = {leg: 0 for leg in LEG_NAMES}

    # Build correlation table keyed by event_key.
    table: dict[str, LegCorrelation] = {}

    # Leg 1: daemon (observer sidecar)
    observer_rows: list[ObserverRow] = []
    if observer_path is not None:
        observer_rows = _load_observer_rows(observer_path)
    for row in observer_rows:
        if row.kind != "chat.event":
            continue
        if stream_id_hint and row.stream_id != stream_id_hint:
            continue
        key = _event_key_for(row.stream_id, row.daemon_seq, None)
        if key == "uncorrelated_fallback":
            continue
        cor = table.setdefault(key, LegCorrelation(event_key=key, daemon_seq=row.daemon_seq))
        if cor.leg_daemon is None:
            cor.leg_daemon = row.timestamp_observer_monotonic
            leg_counts["daemon"] += 1

    # Legs 2-4: app-side
    for event in events_list:
        if event.message not in LEG_EVENT_NAMES.values():
            continue
        data = event.data or {}
        if stream_id_hint and data.get("stream_id") != stream_id_hint:
            continue
        # row_rendered with lifecycle != mount is not a Leg-4 mount signal;
        # skip BEFORE creating a correlation entry so unmount-only rows
        # don't leak into the diagnostic as dangling correlations.
        if event.message == "harness:row_rendered" and str(data.get("lifecycle") or "") != "mount":
            continue
        key = _key_from_event(event)
        if not key:
            continue
        cor = table.setdefault(key, LegCorrelation(event_key=key))
        daemon_seq = _event_daemon_seq(data)
        if daemon_seq is not None and cor.daemon_seq is None:
            cor.daemon_seq = daemon_seq
        text_prefix = data.get("text_prefix")
        if isinstance(text_prefix, str) and cor.text_prefix is None:
            cor.text_prefix = text_prefix[:40]
        if event.message == "chat:event_received":
            if cor.leg_ws is None:
                cor.leg_ws = event.received_at
                leg_counts["app:ws"] += 1
        elif event.message == "chat:event_rendered":
            if cor.leg_reducer is None:
                cor.leg_reducer = event.received_at
                leg_counts["app:reducer"] += 1
        elif event.message == "harness:row_rendered":
            if cor.leg_render is None:
                cor.leg_render = event.received_at
                leg_counts["app:render"] += 1

    correlations = sorted(
        table.values(),
        key=lambda c: (c.leg_daemon or c.leg_ws or c.leg_reducer or c.leg_render or 0.0),
    )

    note = None
    if observer_path is not None and not observer_rows:
        note = f"observer log empty or missing at {observer_path}"
    elif observer_path is None:
        note = "Leg 1 (daemon observer) sidecar not present — diagnostics show Legs 2-4 only"

    return DiagnosticSummary(
        stream_id=stream_id_hint,
        leg_counts=leg_counts,
        correlations=correlations,
        observer_present=bool(observer_rows),
        observer_path=str(observer_path) if observer_path else None,
        note=note,
    )
