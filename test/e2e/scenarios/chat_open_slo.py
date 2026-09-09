from __future__ import annotations

import json
import math
import os
import time
from collections import Counter
from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import Verdict


name = "chat_open_slo"
NOMINAL_CORPUS_KIND = "nominal"
STRESS_CORPUS_KIND = "stress"
DEFAULT_CORPUS_KIND = NOMINAL_CORPUS_KIND
NOMINAL_STREAM_COUNT = 20
STRESS_STREAM_COUNT = 64
EVENTS_PER_STREAM = 600
# Compatibility names are retained for callers that use the stress corpus.
STREAM_COUNT = STRESS_STREAM_COUNT
EVENTS_PER_FOCUSED_STREAM = EVENTS_PER_STREAM
SAMPLE_COUNT = 20
COLD_OPEN_STREAM_COUNT = SAMPLE_COUNT
COLD_OPEN_PROBE_NAME = "distinct_stream_cold"
COLD_OPEN_SAMPLING_SEMANTICS = "20_distinct_stream_cold_opens_first_visit_per_stream"
WARM_REOPEN_PROBE_NAME = "same_stream_warm_reopen"
WARM_REOPEN_SCOPE = "out_of_scope_future_probe"
OPEN_SERIALIZATION_MODE = "serialized_non_overlapping"
OPEN_COMPLETION_BOUNDARY = "first_authoritative_row_mount_or_ack"
INCOMPLETE_SAMPLE_POLICY = "record_and_count_against_denominator_continue"
TOTAL_EVENT_COST_MAX = 24000
SLO_THRESHOLDS_MS = {
    "tap_router_ms": 50.0,
    "tap_shell_ms": 250.0,
    "tap_rows_ms": 1500.0,
}
PER_OPEN_TIMEOUT_MS = int(3 * SLO_THRESHOLDS_MS["tap_rows_ms"])
SERIALIZED_RUN_TIMEOUT_S = math.ceil(SAMPLE_COUNT * PER_OPEN_TIMEOUT_MS / 1000 + 30)
EVALUATION_NAME = f"{name}__{COLD_OPEN_PROBE_NAME}__serialized"

CORPORA = {
    NOMINAL_CORPUS_KIND: {
        "stream_count": NOMINAL_STREAM_COUNT,
        "events_per_stream": EVENTS_PER_STREAM,
    },
    STRESS_CORPUS_KIND: {
        "stream_count": STRESS_STREAM_COUNT,
        "events_per_stream": EVENTS_PER_STREAM,
    },
}


def corpus_kind(config: dict | None = None) -> str:
    config = config or {}
    raw = next(
        (
            config.get(key)
            for key in (
                "corpus_kind",
                "chat_open_slo_corpus",
                "corpus",
                "PENTACLE_CHAT_OPEN_SLO_CORPUS",
                "CHAT_OPEN_SLO_CORPUS",
            )
            if str(config.get(key) or "").strip()
        ),
        os.environ.get("PENTACLE_CHAT_OPEN_SLO_CORPUS")
        or os.environ.get("CHAT_OPEN_SLO_CORPUS")
        or DEFAULT_CORPUS_KIND,
    )
    value = str(raw).strip().lower()
    if value not in CORPORA:
        raise ValueError(f"chat_open_slo corpus must be one of {sorted(CORPORA)}, got {raw!r}")
    return value


def corpus_spec(config: dict | None = None) -> dict[str, int | str]:
    kind = corpus_kind(config)
    return {"kind": kind, **CORPORA[kind]}


def _stream_id(index: int) -> str:
    return f"{M.HOST}:chat-open-slo-{index:02d}"


def ordered_cold_open_stream_ids(config: dict | None = None) -> list[str]:
    config = config or {}
    raw = config.get("stream_ids") or config.get("chat_open_slo_stream_ids")
    if isinstance(raw, str) and raw.strip():
        stream_ids = [item.strip() for item in raw.split(",") if item.strip()]
    elif isinstance(raw, (list, tuple)):
        stream_ids = [str(item).strip() for item in raw if str(item).strip()]
    else:
        stream_ids = [_stream_id(index) for index in range(COLD_OPEN_STREAM_COUNT)]
    if len(stream_ids) != COLD_OPEN_STREAM_COUNT or len(set(stream_ids)) != COLD_OPEN_STREAM_COUNT:
        raise ValueError(
            f"{COLD_OPEN_PROBE_NAME} requires {COLD_OPEN_STREAM_COUNT} distinct ordered stream_ids"
        )
    return stream_ids


def _session(stream_id: str, index: int, *, events_per_stream: int = EVENTS_PER_STREAM) -> dict:
    session_name = f"chat-open-slo-{index:02d}"
    return {
        "stream_id": stream_id,
        "host": M.HOST,
        "provider": M.PROVIDER,
        "session_name": session_name,
        "title": session_name,
        "last_text": f"{session_name} transcript history row {events_per_stream:04d}",
        "last_event_at": "2026-08-28T03:09:59.000Z",
        "online": True,
    }


def write_fixture(
    config: dict,
    *,
    stream_count: int | None = None,
    events_per_stream: int | None = None,
) -> Path:
    selected = corpus_spec(config)
    stream_count = int(selected["stream_count"] if stream_count is None else stream_count)
    events_per_stream = int(selected["events_per_stream"] if events_per_stream is None else events_per_stream)
    if stream_count < 1 or events_per_stream < 1:
        raise ValueError("chat_open_slo fixture dimensions must be positive")
    run_id = str(config.get("scenario_run_id") or config.get("PENTACLE_RUN_ID") or "example-run")
    path = Path("/tmp") / f"example-{name}-{run_id}.json"
    sessions = []
    history_streams = []
    for index in range(stream_count):
        stream_id = _stream_id(index)
        session_name = f"chat-open-slo-{index:02d}"
        sessions.append(_session(stream_id, index, events_per_stream=events_per_stream))
        history_streams.append({
            "stream_id": stream_id,
            "events": [
                H.history_event(seq, stream_id=stream_id, session_name=session_name)
                for seq in range(1, events_per_stream + 1)
            ],
        })
    # The fixture includes one benign frame so adapters that expect a non-empty
    # frame list can consume it. Paint timings are measured from synthetic
    # harness events, not from a live connection.
    live_frame = H.event(
        events_per_stream + 1,
        at_ms=30000,
        stream_id=_stream_id(0),
        session_name=f"chat-open-slo-{0:02d}",
    )
    live_frame["wait_for_client"] = True
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": sessions[0],
        "snapshot": {"sessions": sessions, "events": []},
        "history": {"streams": history_streams},
        "frames": [live_frame],
        "upload": {},
        "send_echo": {},
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "composite_chat_load_probe"]


def params(config: dict) -> dict[str, str]:
    selected = corpus_spec(config)
    open_stream_ids = ordered_cold_open_stream_ids(config)
    fixture = write_fixture(
        {**config, "corpus_kind": selected["kind"]},
        stream_count=int(selected["stream_count"]),
        events_per_stream=int(selected["events_per_stream"]),
    )
    payload = M.params_for_fixture(config, fixture.name)
    # The corpus contains one history list per stream so a public adapter can
    # exercise distinct cold opens without sharing state between samples.
    _tools_dir = Path(__file__).resolve().parents[1] / "tools"
    payload.update({
        "stream_id": open_stream_ids[0],
        "stream_ids": ",".join(open_stream_ids),
        "active_stream_ids": ",".join(open_stream_ids),
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "fixture_adapter": "synthetic",
        "repeat_count": str(SAMPLE_COUNT),
        "list_dwell_ms": "120",
        "mount_timeout_ms": str(PER_OPEN_TIMEOUT_MS),
        "slo_wait_timeout_s": str(SERIALIZED_RUN_TIMEOUT_S),
        "corpus_kind": str(selected["kind"]),
        "stream_count": str(selected["stream_count"]),
        "events_per_stream": str(selected["events_per_stream"]),
        "history_event_count": str(selected["events_per_stream"]),
        "chat_open_slo_stream_count": str(selected["stream_count"]),
        "chat_open_slo_events_per_stream": str(selected["events_per_stream"]),
        "chat_open_slo_open_probe": COLD_OPEN_PROBE_NAME,
        "chat_open_slo_sampling_semantics": COLD_OPEN_SAMPLING_SEMANTICS,
        "chat_open_slo_warm_reopen_probe": WARM_REOPEN_SCOPE,
        "chat_open_slo_open_serialization": OPEN_SERIALIZATION_MODE,
        "chat_open_slo_open_completion_boundary": OPEN_COMPLETION_BOUNDARY,
        "chat_open_slo_per_open_timeout_ms": str(PER_OPEN_TIMEOUT_MS),
        "chat_open_slo_incomplete_sample_policy": INCOMPLETE_SAMPLE_POLICY,
    })
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    try:
        corpus_spec(config)
        ordered_cold_open_stream_ids(config)
    except ValueError as exc:
        return str(exc)
    return M.preflight(config, repo_root)


def percentile95(values: list[float]) -> float:
    if not values:
        raise ValueError("p95 requires at least one sample")
    ordered = sorted(float(value) for value in values)
    return ordered[math.ceil(len(ordered) * 0.95) - 1]


def summarize_samples(samples: list[dict[str, float]]) -> dict:
    metrics: dict[str, dict[str, float]] = {}
    for key in SLO_THRESHOLDS_MS:
        values = [sample[key] for sample in samples]
        metrics[key] = {"p95": percentile95(values), "max": max(values)} if values else {"p95": 0.0, "max": 0.0}
    return {"sample_count": len(samples), "metrics": metrics}


def threshold_failures(summary: dict) -> list[str]:
    failures = []
    for key, threshold in SLO_THRESHOLDS_MS.items():
        metric = summary["metrics"][key]
        if metric["p95"] > threshold:
            failures.append(f"{key} p95 {metric['p95']:.1f}ms exceeds {threshold:.1f}ms")
        if metric["max"] > threshold * 2:
            failures.append(f"{key} max {metric['max']:.1f}ms exceeds {threshold * 2:.1f}ms")
    return failures


def _number(data: dict, *keys: str) -> float | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _paint_phase_records(events: list) -> list[dict]:
    by_correlation: dict[str, dict[str, float]] = {}
    phase_keys = {
        "tap": "tap",
        "router-dispatch-return": "router",
        "shell-layout-commit": "shell",
        "first-authoritative-row-mount": "rows",
    }
    for event in events:
        if event.message != "harness:ui_trace" or event.data.get("kind") != "chat_open_paint":
            continue
        correlation_id = str(event.data.get("correlationId") or event.data.get("correlation_id") or "")
        phase = phase_keys.get(str(event.data.get("phase") or ""))
        timestamp = _number(event.data, "monotonicMs", "monotonic_ms")
        if not correlation_id or phase is None or timestamp is None:
            continue
        record = by_correlation.setdefault(correlation_id, {
            "correlationId": correlation_id,
            "phases": {},
        })
        record["phases"][phase] = timestamp
        stream_id = _non_empty_string(event.data.get("streamId")) or _non_empty_string(
            event.data.get("stream_id")
        )
        if stream_id:
            record["streamId"] = stream_id

    records = []
    for record in by_correlation.values():
        phases = record["phases"]
        if {"tap", "router", "shell", "rows"}.issubset(phases):
            record["metrics"] = {
                "tap_router_ms": phases["router"] - phases["tap"],
                "tap_shell_ms": phases["shell"] - phases["tap"],
                "tap_rows_ms": phases["rows"] - phases["tap"],
            }
        records.append(record)
    return records


def samples_from_paint_signals(events: list) -> list[dict[str, float]]:
    return [
        record["metrics"]
        for record in _paint_phase_records(events)
        if "metrics" in record
    ]


def _paint_metric_sample(record: dict) -> dict[str, float] | None:
    metrics = record.get("metrics")
    if not isinstance(metrics, dict):
        return None
    if not all(key in metrics for key in SLO_THRESHOLDS_MS):
        return None
    return {
        "tap_router_ms": float(metrics["tap_router_ms"]),
        "tap_shell_ms": float(metrics["tap_shell_ms"]),
        "tap_rows_ms": float(metrics["tap_rows_ms"]),
    }


_COST_SAMPLE_REASONS = frozenset({"open_settle", "interval"})


def _is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _parse_bucket_cost_sample(event: object) -> dict | None:
    if getattr(event, "message", None) != "harness:ui_trace":
        return None
    data = getattr(event, "data", None)
    if not isinstance(data, dict) or data.get("kind") != "bucket_cost_sample":
        return None

    weighted_cost = data.get("weightedCost")
    monotonic_ms = data.get("monotonicMs")
    if not _is_integer(weighted_cost) or weighted_cost < 0 or not _is_number(monotonic_ms):
        return None
    if "rssBytes" not in data:
        return None
    rss_bytes = data["rssBytes"]
    if rss_bytes is not None and (not _is_integer(rss_bytes) or rss_bytes <= 0):
        return None

    sample_reason = data.get("sampleReason")
    if not isinstance(sample_reason, str) or sample_reason not in _COST_SAMPLE_REASONS:
        return None

    sample = {
        "weightedCost": weighted_cost,
        "rssBytes": rss_bytes,
        "monotonicMs": monotonic_ms,
        "sampleReason": sample_reason,
    }
    stream_id = _non_empty_string(data.get("stream_id")) or _non_empty_string(data.get("streamId"))
    if stream_id is not None:
        sample["streamId"] = stream_id
    if sample_reason == "open_settle":
        correlation_id = _non_empty_string(data.get("correlationId"))
        if correlation_id is None or stream_id is None:
            return None
        sample["correlationId"] = correlation_id
    elif data.get("correlationId") not in (None, ""):
        # An interval sample cannot be attributed to a single open.
        return None
    return sample


def parse_bucket_cost_samples(events: list) -> list[dict]:
    """Parse only the locked ``bucket_cost_sample`` telemetry envelope.

    ``rssBytes: null`` is retained as an observed unsupported value. Missing
    or zero RSS is invalid, because the producer contract distinguishes null
    from a real process-RSS measurement.
    """
    samples = []
    for event in events:
        sample = _parse_bucket_cost_sample(event)
        if sample is not None:
            samples.append(sample)
    return samples


def _ordered_cost_samples(samples: list[dict]) -> list[dict]:
    return sorted(samples, key=lambda sample: float(sample["monotonicMs"]))


def _eviction_indicators(samples: list[dict]) -> tuple[int, dict]:
    ordered = _ordered_cost_samples(samples)
    drops = [
        previous["weightedCost"] - current["weightedCost"]
        for previous, current in zip(ordered, ordered[1:])
        if current["weightedCost"] < previous["weightedCost"]
    ]
    churn = len(drops)
    indicators = {
        "weighted_cost_decrease_count": churn,
        "weighted_cost_decrease_total": sum(drops),
        "possible_eviction": churn > 0,
        "ceiling_observed": any(
            sample["weightedCost"] >= TOTAL_EVENT_COST_MAX for sample in ordered
        ),
    }
    return churn, indicators


def summarize_bucket_cost_samples(samples: list[dict]) -> dict:
    """Return cost/RSS peaks and the two contract-defined sample series."""
    open_settle = [sample for sample in samples if sample["sampleReason"] == "open_settle"]
    interval = [sample for sample in samples if sample["sampleReason"] == "interval"]
    rss_values = [sample["rssBytes"] for sample in samples if sample["rssBytes"] is not None]
    eviction_churn, eviction_indicators = _eviction_indicators(samples)
    return {
        "sample_count": len(samples),
        "open_settle_sample_count": len(open_settle),
        "interval_sample_count": len(interval),
        "peak_weighted_cost": max((sample["weightedCost"] for sample in samples), default=None),
        "peak_rss_bytes": max(rss_values, default=None),
        "open_settle_series": [dict(sample) for sample in open_settle],
        "interval_series": [dict(sample) for sample in interval],
        "eviction_churn": eviction_churn,
        "eviction_indicators": eviction_indicators,
    }


# Keep the naming parallel to samples_from_paint_signals for callers that use
# the shorter helper name in fixture-level tests.
def samples_from_bucket_cost(events: list) -> list[dict]:
    return parse_bucket_cost_samples(events)


def _event_stream_id(event: object) -> str | None:
    data = getattr(event, "data", None)
    if not isinstance(data, dict):
        return None
    return _non_empty_string(data.get("stream_id")) or _non_empty_string(data.get("streamId"))


def _declared_iteration(event: object) -> int | None:
    data = getattr(event, "data", None)
    value = data.get("iteration") if isinstance(data, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def baseline_proxy_samples(
    events: list,
    *,
    excluded_stream_ids: set[str] | None = None,
) -> list[dict[str, float]]:
    """Fallback timing proxy that never pairs events across distinct opens."""
    excluded_stream_ids = excluded_stream_ids or set()
    starts = sorted(
        (
            event for event in events
            if event.message == "harness:ui_trace"
            and event.data.get("kind") == "composite_open_start"
        ),
        key=lambda event: event.received_at,
    )
    mounts = sorted(
        (
            event for event in events
            if event.message == "harness:session_screen_mount"
            or (
                event.message == "harness:ui_trace"
                and event.data.get("kind") == "session_screen_mount"
            )
        ),
        key=lambda event: event.received_at,
    )
    settled = sorted(
        (
            event for event in events
            if event.message == "harness:transcript_ready_settled"
            and event.data.get("branch") != "harness_timeout"
        ),
        key=lambda event: event.received_at,
    )
    used_mounts: set[int] = set()
    used_settled: set[int] = set()
    samples = []
    for start in starts:
        stream_id = _event_stream_id(start)
        if stream_id in excluded_stream_ids:
            continue
        mount_index = next(
            (
                index for index, mount in enumerate(mounts)
                if index not in used_mounts
                and mount.received_at >= start.received_at
                and (not stream_id or _event_stream_id(mount) == stream_id)
            ),
            None,
        )
        if mount_index is None:
            continue
        mount = mounts[mount_index]
        settled_index = next(
            (
                index for index, ready in enumerate(settled)
                if index not in used_settled
                and ready.received_at >= mount.received_at
                and (not stream_id or _event_stream_id(ready) == stream_id)
            ),
            None,
        )
        if settled_index is None:
            continue
        used_mounts.add(mount_index)
        used_settled.add(settled_index)
        ready = settled[settled_index]
        shell_ms = max(0.0, (mount.received_at - start.received_at) * 1000.0)
        samples.append({
            "tap_router_ms": shell_ms,
            "tap_shell_ms": shell_ms,
            "tap_rows_ms": max(0.0, (ready.received_at - start.received_at) * 1000.0),
        })
    return samples


def _serialized_open_trace(events: list, config: dict | None = None) -> tuple[list[dict], list[str]]:
    """Describe the intentional non-overlapping open sequence and its samples."""
    starts = sorted(
        (
            event for event in events
            if event.message == "harness:ui_trace"
            and event.data.get("kind") == "composite_open_start"
        ),
        key=lambda event: event.received_at,
    )
    settled = sorted(
        (
            event for event in events
            if event.message == "harness:ui_trace"
            and event.data.get("kind") == "composite_open_settled"
        ),
        key=lambda event: event.received_at,
    )
    if not starts and not settled:
        return [], ["missing serialized open lifecycle telemetry"]

    expected_stream_ids = ordered_cold_open_stream_ids(config)
    starts_by_iteration = {}
    for event in starts:
        iteration = _declared_iteration(event)
        if iteration is not None:
            starts_by_iteration.setdefault(iteration, event)
    settled_by_iteration = {}
    for event in settled:
        iteration = _declared_iteration(event)
        if iteration is not None:
            settled_by_iteration.setdefault(iteration, event)
    paint_records = _paint_phase_records(events)
    paint_by_stream_id = {
        record.get("streamId"): record
        for record in paint_records
        if record.get("streamId")
    }
    records: list[dict] = []
    for index, expected_stream_id in enumerate(expected_stream_ids):
        start = starts_by_iteration.get(index)
        settle = settled_by_iteration.get(index)
        stream_id = _event_stream_id(start) or _event_stream_id(settle)
        paint = paint_by_stream_id.get(stream_id)
        phases = dict(paint.get("phases", {})) if paint else {}
        mounted = bool(settle and settle.data.get("mounted") is True)
        metrics = _paint_metric_sample(paint) if paint else None
        if settle is None:
            status = "INCOMPLETE"
            reason = "open_wait_timeout"
        elif start is None or not mounted:
            status = "INCOMPLETE"
            reason = "open_wait_timeout"
        elif metrics is None:
            status = "INCOMPLETE"
            reason = "missing_authoritative_paint_phase"
        else:
            status = "COMPLETE"
            reason = "first_authoritative_row_mount_or_ack"
        record = {
            "iteration": index,
            "stream_id": stream_id,
            "started": start is not None,
            "settled": settle is not None and mounted,
            "status": status,
            "reason": reason,
            "partial_phases": sorted(phases),
            "phases": phases,
        }
        if paint and paint.get("correlationId"):
            record["correlation_id"] = paint["correlationId"]
        if status == "INCOMPLETE" and reason == "open_wait_timeout":
            record["timeout_ms"] = PER_OPEN_TIMEOUT_MS
        if metrics is not None:
            record["metrics"] = metrics
        records.append(record)

    failures: list[str] = []
    for iteration in range(len(expected_stream_ids)):
        if iteration not in starts_by_iteration:
            failures.append(f"serialized open start iteration {iteration} is missing")

    for label, observed in (("start", starts), ("settled", settled)):
        prior_iteration = None
        seen_iterations: dict[int, int] = {}
        seen_stream_ids: dict[str, int] = {}
        for position, event in enumerate(observed):
            iteration = _declared_iteration(event)
            stream_id = _event_stream_id(event)
            if iteration is None:
                failures.append(f"serialized open {label} {position} is missing iteration")
                continue
            if iteration >= len(expected_stream_ids):
                failures.append(f"serialized open {label} iteration {iteration} is unexpected")
                continue
            if prior_iteration is not None and iteration < prior_iteration:
                failures.append(f"serialized open {label} iterations are out of order")
            prior_iteration = iteration
            if iteration in seen_iterations:
                failures.append(f"serialized open {label} iteration {iteration} is duplicated")
            else:
                seen_iterations[iteration] = position
            if stream_id is None:
                failures.append(f"serialized open {label} {position} is missing stream_id")
                continue
            expected_stream_id = expected_stream_ids[iteration]
            if stream_id != expected_stream_id:
                failures.append(
                    f"serialized open {label} iteration {iteration} targets {stream_id!r}, "
                    f"expected {expected_stream_id!r}"
                )
            if stream_id is not None:
                if stream_id in seen_stream_ids:
                    failures.append(
                        f"serialized open {label} stream_id {stream_id!r} is duplicated"
                    )
                else:
                    seen_stream_ids[stream_id] = iteration

    for iteration in sorted(set(starts_by_iteration) & set(settled_by_iteration)):
        if settled_by_iteration[iteration].received_at < starts_by_iteration[iteration].received_at:
            failures.append(f"serialized open iteration {iteration} settled before start")
        start_stream_id = _event_stream_id(starts_by_iteration[iteration])
        settled_stream_id = _event_stream_id(settled_by_iteration[iteration])
        if start_stream_id != settled_stream_id:
            failures.append(
                f"serialized open iteration {iteration} changed stream_id between start and settled"
            )

    for index, start in enumerate(starts[:-1]):
        iteration = _declared_iteration(start)
        if iteration is None:
            continue
        next_start = starts[index + 1]
        prior_settle = settled_by_iteration.get(iteration)
        if prior_settle is None:
            failures.append(f"serialized open {iteration} has no completion before next open")
        elif next_start.received_at < prior_settle.received_at:
            failures.append(f"serialized opens overlap at iteration {iteration}")
    return records, failures


def serialized_open_records(events: list, config: dict | None = None) -> list[dict]:
    return _serialized_open_trace(events, config)[0]


def serialization_failures(events: list, config: dict | None = None) -> list[str]:
    return _serialized_open_trace(events, config)[1]


def serialized_open_sequence_complete(events: list, config: dict | None = None) -> bool:
    starts = [
        event for event in events
        if event.message == "harness:ui_trace"
        and event.data.get("kind") == "composite_open_start"
    ]
    settled = [
        event for event in events
        if event.message == "harness:ui_trace"
        and event.data.get("kind") == "composite_open_settled"
    ]
    if not starts and not settled:
        return False
    expected = _expected_open_count(config or {})
    start_iterations = {
        iteration
        for event in starts
        if (iteration := _declared_iteration(event)) is not None
    }
    settled_iterations = {
        iteration
        for event in settled
        if (iteration := _declared_iteration(event)) is not None
    }
    return all(index in start_iterations and index in settled_iterations for index in range(expected))


def _enforce_thresholds(config: dict) -> bool:
    raw = str(config.get("enforce_chat_open_slo") or os.environ.get("PENTACLE_ENFORCE_CHAT_OPEN_SLO") or "").lower()
    return raw in {"1", "true", "yes"}


def _expected_open_count(config: dict) -> int:
    raw = config.get("repeat_count")
    try:
        value = int(raw) if raw is not None else SAMPLE_COUNT
    except (TypeError, ValueError):
        value = SAMPLE_COUNT
    return value if value > 0 else SAMPLE_COUNT


def _settled_open_count(events: list) -> int:
    return sum(
        1
        for event in events
        if event.message == "harness:transcript_ready_settled"
        and event.data.get("branch") != "harness_timeout"
    )


def _load_completed(events: list) -> bool:
    return any(
        event.message == "harness:ui_trace"
        and event.data.get("kind") == "composite_load_done"
        for event in events
    )


def _cost_coverage_failures(
    config: dict,
    events: list,
    cost_samples: list[dict],
    cost_summary: dict,
    open_records: list[dict],
    complete_sample_count: int,
) -> list[str]:
    failures = []
    if cost_summary["sample_count"] == 0:
        failures.append("missing bucket_cost_sample telemetry")
    if cost_summary["interval_sample_count"] == 0:
        failures.append("missing interval bucket_cost_sample telemetry")

    settled_events = _settled_open_count(events)
    if cost_summary["open_settle_sample_count"] < settled_events:
        failures.append(
            "missing open_settle bucket_cost_sample telemetry for observed settled opens"
        )

    if corpus_kind(config) == NOMINAL_CORPUS_KIND and complete_sample_count == SAMPLE_COUNT:
        if cost_summary["open_settle_sample_count"] != SAMPLE_COUNT:
            failures.append(
                f"expected {SAMPLE_COUNT} open_settle cost samples, "
                f"observed {cost_summary['open_settle_sample_count']}"
            )

    expected_identities = []
    for record in open_records:
        if record.get("settled") is not True:
            continue
        iteration = record.get("iteration")
        correlation_id = record.get("correlation_id")
        stream_id = record.get("stream_id")
        if not isinstance(correlation_id, str) or not correlation_id:
            failures.append(f"serialized open iteration {iteration} is missing correlation_id for cost coverage")
            continue
        if not isinstance(stream_id, str) or not stream_id:
            failures.append(f"serialized open iteration {iteration} is missing stream_id for cost coverage")
            continue
        expected_identities.append((correlation_id, stream_id))

    observed_identities = [
        (sample["correlationId"], sample["streamId"])
        for sample in cost_samples
        if sample["sampleReason"] == "open_settle"
    ]
    expected_counts = Counter(expected_identities)
    observed_counts = Counter(observed_identities)
    duplicate_expected = sorted(identity for identity, count in expected_counts.items() if count > 1)
    duplicate_observed = sorted(identity for identity, count in observed_counts.items() if count > 1)
    expected_correlations = Counter(correlation_id for correlation_id, _ in expected_identities)
    observed_correlations = Counter(correlation_id for correlation_id, _ in observed_identities)
    expected_stream_ids = Counter(stream_id for _, stream_id in expected_identities)
    observed_stream_ids = Counter(stream_id for _, stream_id in observed_identities)
    duplicate_expected_correlations = sorted(
        correlation_id for correlation_id, count in expected_correlations.items() if count > 1
    )
    duplicate_observed_correlations = sorted(
        correlation_id for correlation_id, count in observed_correlations.items() if count > 1
    )
    duplicate_expected_stream_ids = sorted(
        stream_id for stream_id, count in expected_stream_ids.items() if count > 1
    )
    duplicate_observed_stream_ids = sorted(
        stream_id for stream_id, count in observed_stream_ids.items() if count > 1
    )
    if duplicate_expected:
        failures.append(f"duplicate settled-open identity in lifecycle trace: {duplicate_expected!r}")
    if duplicate_observed:
        failures.append(f"duplicate open_settle bucket_cost_sample identity: {duplicate_observed!r}")
    if duplicate_expected_correlations:
        failures.append(
            f"duplicate settled-open correlation_id in lifecycle trace: {duplicate_expected_correlations!r}"
        )
    if duplicate_observed_correlations:
        failures.append(
            f"duplicate open_settle bucket_cost_sample correlationId: {duplicate_observed_correlations!r}"
        )
    if duplicate_expected_stream_ids:
        failures.append(f"duplicate settled-open stream_id in lifecycle trace: {duplicate_expected_stream_ids!r}")
    if duplicate_observed_stream_ids:
        failures.append(f"duplicate open_settle bucket_cost_sample streamId: {duplicate_observed_stream_ids!r}")
    if expected_counts != observed_counts:
        missing = sorted((expected_counts - observed_counts).elements())
        unexpected = sorted((observed_counts - expected_counts).elements())
        coverage = ["open_settle bucket_cost_sample identity coverage is not one-to-one"]
        if missing:
            coverage.append(f"missing={missing!r}")
        if unexpected:
            coverage.append(f"unexpected={unexpected!r}")
        failures.append("; ".join(coverage))
    return failures


def evaluate_events(
    config: dict,
    events: list,
    *,
    paint_samples: list[dict[str, float]] | None = None,
    cost_samples: list[dict] | None = None,
) -> Verdict:
    """Evaluate intentional serialized cold opens, keeping certification nominal-only.

    Serialization defines the measured user journey: each per-open latency is
    non-overlapping, so a later open cannot overwrite the prior open's pending
    navigation intent. It is part of the probe contract, not a recovery for an
    app limitation.
    The paint probe selection deliberately retains the existing exact-signal
    then baseline-proxy ordering. Cost samples are a separate telemetry
    surface, so a stress run can report useful pressure evidence without
    turning its incomplete/slow opens into an SLO certification result.
    """
    selected = corpus_spec(config)
    open_stream_ids = ordered_cold_open_stream_ids(config)
    open_records, serialization_failures = _serialized_open_trace(events, config)
    incomplete_samples = [
        record for record in open_records
        if record.get("status") == "INCOMPLETE"
    ]
    if paint_samples is None:
        incomplete_stream_ids = {
            record["stream_id"] for record in incomplete_samples if record.get("stream_id")
        }
        incomplete_iterations = {
            record["iteration"] for record in incomplete_samples
            if isinstance(record.get("iteration"), int)
        }
        exact_samples = [
            sample
            for position, record in enumerate(_paint_phase_records(events))
            if position not in incomplete_iterations
            if record.get("streamId")
            and record.get("streamId") not in incomplete_stream_ids
            and (sample := _paint_metric_sample(record)) is not None
        ]
        if len(exact_samples) >= SAMPLE_COUNT or (open_records and exact_samples):
            paint_samples = exact_samples[:SAMPLE_COUNT]
            sample_source = "g2-paint-signals"
        else:
            paint_samples = baseline_proxy_samples(
                events,
                excluded_stream_ids=incomplete_stream_ids,
            )[:SAMPLE_COUNT]
            sample_source = "baseline-proxy"
    else:
        paint_samples = list(paint_samples)[:SAMPLE_COUNT]
        sample_source = "g2-paint-signals"

    if cost_samples is None:
        cost_samples = parse_bucket_cost_samples(events)
    else:
        cost_samples = list(cost_samples)
    cost_summary = summarize_bucket_cost_samples(cost_samples)
    cost_coverage_failures = _cost_coverage_failures(
        config,
        events,
        cost_samples,
        cost_summary,
        open_records,
        len(paint_samples),
    )
    settled_record_count = sum(record.get("settled") is True for record in open_records)
    settled_count = max(_settled_open_count(events), settled_record_count)
    settle_rate = min(1.0, settled_count / _expected_open_count(config))
    paint_summary = summarize_samples(paint_samples)
    complete_sample_count = len(paint_samples)
    sample_denominator = _expected_open_count(config)
    missing_sample_count = max(
        0,
        sample_denominator - complete_sample_count - len(incomplete_samples),
    )
    for index in range(missing_sample_count):
        iteration = len(open_records) + index
        incomplete_samples.append({
            "iteration": iteration,
            "stream_id": open_stream_ids[iteration % len(open_stream_ids)],
            "status": "INCOMPLETE",
            "reason": "missing_complete_sample",
            "partial_phases": [],
            "phases": {},
        })

    extras = {
        "classification": "PRODUCT",
        "evaluation_name": EVALUATION_NAME,
        "open_probe": COLD_OPEN_PROBE_NAME,
        "sampling_semantics": COLD_OPEN_SAMPLING_SEMANTICS,
        "open_serialization": OPEN_SERIALIZATION_MODE,
        "open_completion_boundary": OPEN_COMPLETION_BOUNDARY,
        "per_open_timeout_ms": PER_OPEN_TIMEOUT_MS,
        "incomplete_sample_policy": INCOMPLETE_SAMPLE_POLICY,
        "open_stream_count": len(open_stream_ids),
        "open_stream_ids": open_stream_ids,
        "warm_reopen_probe": WARM_REOPEN_PROBE_NAME,
        "warm_reopen_scope": WARM_REOPEN_SCOPE,
        "corpus": {
            "kind": selected["kind"],
            "streams": selected["stream_count"],
            "events_per_stream": selected["events_per_stream"],
        },
        "corpus_kind": selected["kind"],
        "stream_count": selected["stream_count"],
        "events_per_stream": selected["events_per_stream"],
        "open_samples": SAMPLE_COUNT,
        "sample_denominator": sample_denominator,
        "complete_sample_count": complete_sample_count,
        "incomplete_sample_count": len(incomplete_samples),
        "incomplete_samples": incomplete_samples,
        "sample_accounting": {
            "denominator": sample_denominator,
            "complete": complete_sample_count,
            "incomplete": len(incomplete_samples),
            "policy": INCOMPLETE_SAMPLE_POLICY,
        },
        "paint_sample_count": complete_sample_count,
        "sample_source": sample_source,
        "metrics": paint_summary["metrics"],
        "settle_rate": settle_rate,
        "serialization_failures": serialization_failures,
        "open_sequence": {
            "mode": OPEN_SERIALIZATION_MODE,
            "completion_boundary": OPEN_COMPLETION_BOUNDARY,
            "per_open_timeout_ms": PER_OPEN_TIMEOUT_MS,
            "observed_open_count": len(open_records),
            "failures": serialization_failures,
        },
        "cost_coverage_failures": cost_coverage_failures,
        **cost_summary,
    }

    if selected["kind"] == NOMINAL_CORPUS_KIND:
        failures = threshold_failures(paint_summary)
        if not paint_samples:
            failures = ["no measured chat-open samples"]
        exact_sample_count = complete_sample_count == SAMPLE_COUNT
        if not exact_sample_count:
            failures.insert(0, f"expected {SAMPLE_COUNT} samples, observed {complete_sample_count}")
        if incomplete_samples:
            failures.insert(0, f"{len(incomplete_samples)} serialized open samples INCOMPLETE")
        if serialization_failures:
            failures[0:0] = serialization_failures
        certification_failures = list(failures)
        certification_failures.extend(cost_coverage_failures)
        certification_verdict = "PASS" if exact_sample_count and not certification_failures else "FAIL"
        enforce_thresholds = _enforce_thresholds(config)
        scenario_failed = (
            not exact_sample_count
            or bool(incomplete_samples)
            or bool(serialization_failures)
            or bool(cost_coverage_failures)
            or bool(certification_failures)
        )
        extras.update({
            "evaluation_mode": "certification",
            "enforce_thresholds": enforce_thresholds,
            "slo_pass": not certification_failures,
            "threshold_failures": failures,
            "certification": {
                "verdict": certification_verdict,
            "complete_sample_count": complete_sample_count,
            "incomplete_sample_count": len(incomplete_samples),
            "metrics": paint_summary["metrics"],
                "threshold_failures": certification_failures,
            },
        })
        return Verdict(
            name=EVALUATION_NAME,
            verdict="FAIL" if scenario_failed else "PASS",
            error="; ".join(failures) if scenario_failed else None,
            extras=extras,
        ).finish()

    extras.update({
        "evaluation_mode": "characterization",
        "stress_characterization": {
            "settle_rate": settle_rate,
            "complete_sample_count": complete_sample_count,
            "incomplete_sample_count": len(incomplete_samples),
            "eviction_indicators": cost_summary["eviction_indicators"],
            "eviction_churn": cost_summary["eviction_churn"],
            "peak_weighted_cost": cost_summary["peak_weighted_cost"],
            "peak_rss_bytes": cost_summary["peak_rss_bytes"],
        },
    })
    stress_verdict = "FAIL" if cost_coverage_failures else "PASS"
    return Verdict(name=EVALUATION_NAME, verdict=stress_verdict, extras=extras).finish()


def run(config: dict, stream, cap=None) -> Verdict:
    deadline = time.monotonic() + float(
        config.get("slo_wait_timeout_s") or SERIALIZED_RUN_TIMEOUT_S
    )
    paint_complete_at: float | None = None
    capture_complete_at: float | None = None
    cost_capture_grace_s = float(config.get("slo_cost_capture_grace_s") or 2.0)
    while time.monotonic() < deadline:
        events = stream.all_events()
        exact_samples = samples_from_paint_signals(events)
        samples = exact_samples if len(exact_samples) >= SAMPLE_COUNT else baseline_proxy_samples(events)
        cost_samples = parse_bucket_cost_samples(events)
        if len(samples) >= SAMPLE_COUNT and paint_complete_at is None:
            paint_complete_at = time.monotonic()
        if _load_completed(events) and capture_complete_at is None:
            capture_complete_at = time.monotonic()
        sequence_complete = serialized_open_sequence_complete(events, config)
        cost_capture_complete = (
            paint_complete_at is not None
            and (
                len([
                    sample for sample in cost_samples
                    if sample["sampleReason"] == "open_settle"
                ]) >= SAMPLE_COUNT
                or time.monotonic() - paint_complete_at >= cost_capture_grace_s
            )
        )
        load_capture_complete = (
            capture_complete_at is not None
            and time.monotonic() - capture_complete_at >= cost_capture_grace_s
        )
        if sequence_complete and (cost_capture_complete or load_capture_complete):
            break
        stream.next_event(timeout_s=min(0.5, max(0.0, deadline - time.monotonic())))

    verdict = evaluate_events(config, stream.all_events())
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
