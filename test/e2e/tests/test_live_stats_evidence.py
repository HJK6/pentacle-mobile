from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Stats:
    sampled_at: str
    cpu_load_1m: float
    memory_label: str
    disk_label: str
    uptime_label: str


def validate_stats(frame: Stats | None, visible_labels: list[str]) -> dict[str, object]:
    if frame is None:
        return {"ok": False, "error": "no matching stats sample"}
    required = ["LIVE", frame.memory_label, frame.disk_label,
                str(frame.cpu_load_1m), frame.uptime_label]
    missing = [label for label in required if label not in visible_labels]
    if missing:
        return {"ok": False, "error": f"missing visible values: {missing}"}
    return {"ok": True, "sampled_at": frame.sampled_at}


def test_stats_accept_a_matching_sample_and_visible_values() -> None:
    stats = Stats("2026-01-01T00:00:00.000Z", 1.2, "20%", "30%", "1d")
    result = validate_stats(stats, ["LIVE", "20%", "30%", "1.2", "1d"])
    assert result == {"ok": True, "sampled_at": stats.sampled_at}


def test_stats_require_all_visible_values() -> None:
    stats = Stats("2026-01-01T00:00:00.000Z", 1.2, "20%", "30%", "1d")
    result = validate_stats(stats, ["LIVE"])
    assert result["ok"] is False
    assert "20%" in str(result["error"])


def test_missing_sample_is_reported() -> None:
    assert validate_stats(None, ["LIVE"]) == {
        "ok": False,
        "error": "no matching stats sample",
    }
