from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HistoryOpenResult:
    transcript_count: int
    first_row_ms: float
    complete: bool


def open_history(event_count: int, first_row_ms: float, limit: int = 25) -> HistoryOpenResult:
    return HistoryOpenResult(
        transcript_count=min(event_count, limit),
        first_row_ms=first_row_ms,
        complete=event_count <= limit,
    )


def test_open_uses_a_bounded_page_for_a_long_history() -> None:
    result = open_history(522, 480.0)
    assert result.transcript_count == 25
    assert result.complete is False


def test_small_history_is_complete() -> None:
    result = open_history(12, 480.0)
    assert result == HistoryOpenResult(12, 480.0, True)


def test_slow_first_row_is_visible_to_the_timing_check() -> None:
    result = open_history(12, 3200.0)
    assert result.first_row_ms > 3000.0
