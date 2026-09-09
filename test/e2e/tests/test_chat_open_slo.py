from __future__ import annotations

import math
from dataclasses import dataclass


PHASES = ("tap", "route_done", "layout_done", "first_row")
TARGETS_MS = {"route_ms": 100.0, "layout_ms": 500.0, "rows_ms": 3000.0}


@dataclass(frozen=True)
class TimingResult:
    verdict: str
    details: dict


def _nearest_rank(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def summarize_samples(samples: list[dict[str, float]]) -> dict:
    metrics = {}
    for name in TARGETS_MS:
        values = [float(sample[name]) for sample in samples if name in sample]
        metrics[name] = {
            "p95": _nearest_rank(values, 0.95) if values else None,
            "max": max(values) if values else None,
        }
    return {"sample_count": len(samples), "metrics": metrics}


def threshold_failures(summary: dict) -> list[str]:
    failures = []
    for name, target in TARGETS_MS.items():
        maximum = summary["metrics"][name]["max"]
        if maximum is not None and maximum > target:
            failures.append(f"{name} max {maximum}ms exceeds {target}ms")
    return failures


def samples_from_phase_events(events: list[dict]) -> list[dict]:
    grouped: dict[str, dict[str, float]] = {}
    for event in events:
        if event.get("kind") != "paint":
            continue
        correlation = event.get("correlation")
        phase = event.get("phase")
        timestamp = event.get("monotonic_ms")
        if not isinstance(correlation, str) or phase not in PHASES:
            continue
        if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            continue
        grouped.setdefault(correlation, {})[phase] = float(timestamp)

    samples = []
    for phase_times in grouped.values():
        if not all(phase in phase_times for phase in PHASES):
            continue
        samples.append({
            "route_ms": phase_times["route_done"] - phase_times["tap"],
            "layout_ms": phase_times["layout_done"] - phase_times["tap"],
            "rows_ms": phase_times["first_row"] - phase_times["tap"],
        })
    return samples


def summarize_cost_samples(samples: list[dict]) -> dict:
    valid = [
        sample for sample in samples
        if isinstance(sample.get("weighted_cost"), (int, float))
        and isinstance(sample.get("reason"), str)
    ]
    settled = [sample for sample in valid if sample["reason"] == "settled"]
    intervals = [sample for sample in valid if sample["reason"] == "interval"]
    rss_values = [
        sample["rss_bytes"] for sample in valid
        if isinstance(sample.get("rss_bytes"), (int, float))
    ]
    return {
        "sample_count": len(valid),
        "settled_count": len(settled),
        "interval_count": len(intervals),
        "peak_weighted_cost": max((sample["weighted_cost"] for sample in valid), default=None),
        "peak_rss_bytes": max(rss_values, default=None),
    }


def sequence_failures(events: list[dict], stream_ids: list[str]) -> list[str]:
    starts: dict[int, dict] = {}
    settled: dict[int, dict] = {}
    for event in events:
        if event.get("kind") == "open_start":
            starts[event.get("index")] = event
        elif event.get("kind") == "open_settled":
            settled[event.get("index")] = event

    failures = []
    previous_settle = float("-inf")
    for index, stream_id in enumerate(stream_ids):
        start = starts.get(index)
        finish = settled.get(index)
        if not start or not finish:
            failures.append(f"open {index} is incomplete")
            continue
        if start.get("stream_id") != stream_id or finish.get("stream_id") != stream_id:
            failures.append(f"open {index} targets the wrong stream")
        if finish["at"] < start["at"]:
            failures.append(f"open {index} settles before it starts")
        if start["at"] < previous_settle:
            failures.append(f"open {index} overlaps the previous open")
        if finish["at"] < previous_settle:
            failures.append("settled opens are out of order")
        previous_settle = finish["at"]
    return failures


def evaluate(events: list[dict], costs: list[dict], stream_ids: list[str]) -> TimingResult:
    paint_samples = samples_from_phase_events(events)
    timing = summarize_samples(paint_samples)
    cost_summary = summarize_cost_samples(costs)
    failures = threshold_failures(timing) + sequence_failures(events, stream_ids)
    if cost_summary["settled_count"] != len(stream_ids):
        failures.append(
            f"expected {len(stream_ids)} settled cost samples, observed "
            f"{cost_summary['settled_count']}"
        )
    return TimingResult("PASS" if not failures else "FAIL", {
        "timing": timing,
        "costs": cost_summary,
        "failures": failures,
    })


def _fixture(stream_count: int = 4) -> tuple[list[dict], list[dict], list[str]]:
    stream_ids = [f"hostc:sample-{index:02d}" for index in range(stream_count)]
    events = []
    costs = []
    for index, stream_id in enumerate(stream_ids):
        start = index * 10.0
        events.append({"kind": "open_start", "index": index, "stream_id": stream_id, "at": start})
        for phase, offset in zip(PHASES, (0.0, 10.0, 20.0, 80.0)):
            events.append({
                "kind": "paint",
                "correlation": f"open-{index}",
                "stream_id": stream_id,
                "phase": phase,
                "monotonic_ms": start * 1000 + offset,
            })
        events.append({
            "kind": "open_settled",
            "index": index,
            "stream_id": stream_id,
            "at": start + 1.0,
        })
        costs.append({
            "weighted_cost": 100 + index,
            "rss_bytes": None,
            "reason": "settled",
            "stream_id": stream_id,
        })
    return events, costs, stream_ids


def test_synthetic_fixture_has_nominal_and_stress_dimensions() -> None:
    events, costs, stream_ids = _fixture(4)
    assert len(stream_ids) == 4
    assert len([event for event in events if event["kind"] == "open_start"]) == 4
    assert len(costs) == 4


def test_summary_uses_nearest_rank_p95_and_records_maxima() -> None:
    samples = [{"route_ms": 10.0, "layout_ms": 20.0, "rows_ms": 30.0} for _ in range(19)]
    samples.append({"route_ms": 101.0, "layout_ms": 501.0, "rows_ms": 3001.0})
    summary = summarize_samples(samples)
    assert summary["metrics"]["route_ms"] == {"p95": 10.0, "max": 101.0}
    assert "route_ms max 101.0ms exceeds 100.0ms" in threshold_failures(summary)
    assert "layout_ms max 501.0ms exceeds 500.0ms" in threshold_failures(summary)
    assert "rows_ms max 3001.0ms exceeds 3000.0ms" in threshold_failures(summary)


def test_exact_phase_signals_preserve_correlation() -> None:
    events = [
        {"kind": "paint", "correlation": "open-1", "phase": "tap", "monotonic_ms": 100},
        {"kind": "paint", "correlation": "open-1", "phase": "route_done", "monotonic_ms": 110},
        {"kind": "paint", "correlation": "open-1", "phase": "layout_done", "monotonic_ms": 180},
        {"kind": "paint", "correlation": "open-1", "phase": "first_row", "monotonic_ms": 900},
    ]
    assert samples_from_phase_events(events) == [{
        "route_ms": 10.0,
        "layout_ms": 80.0,
        "rows_ms": 800.0,
    }]


def test_cost_summary_accepts_settled_and_interval_samples() -> None:
    summary = summarize_cost_samples([
        {"weighted_cost": 120, "rss_bytes": None, "reason": "interval"},
        {"weighted_cost": 480, "rss_bytes": 2048, "reason": "settled"},
        {"weighted_cost": 320, "rss_bytes": 4096, "reason": "interval"},
    ])
    assert summary == {
        "sample_count": 3,
        "settled_count": 1,
        "interval_count": 2,
        "peak_weighted_cost": 480,
        "peak_rss_bytes": 4096,
    }


def test_complete_sequence_passes_and_missing_costs_fail_closed() -> None:
    events, costs, stream_ids = _fixture(4)
    assert evaluate(events, costs, stream_ids).verdict == "PASS"
    result = evaluate(events, costs[:2], stream_ids)
    assert result.verdict == "FAIL"
    assert any("settled cost samples" in failure for failure in result.details["failures"])


def test_overlapping_opens_and_missing_phases_are_reported() -> None:
    events, costs, stream_ids = _fixture(2)
    events[2]["at"] = 100.0
    events = [event for event in events if not (
        event.get("kind") == "paint"
        and event.get("correlation") == "open-1"
        and event.get("phase") == "first_row"
    )]
    result = evaluate(events, costs, stream_ids)
    assert result.verdict == "FAIL"
    assert any("overlaps" in failure for failure in result.details["failures"])
    assert len(samples_from_phase_events(events)) == 1


def test_invalid_clock_values_do_not_create_samples() -> None:
    event = {"kind": "paint", "correlation": "open-1", "phase": "tap", "monotonic_ms": math.nan}
    assert samples_from_phase_events([event]) == []
