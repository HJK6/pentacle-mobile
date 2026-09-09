from __future__ import annotations

import pytest

from harness.fd_guard import assert_no_fd_growth


def test_fd_guard_accepts_stable_or_lower_counts() -> None:
    assert_no_fd_growth(12, 12)
    assert_no_fd_growth(12, 11)


def test_fd_guard_rejects_reintroduced_growth() -> None:
    with pytest.raises(AssertionError, match="12 -> 13"):
        assert_no_fd_growth(12, 13)
