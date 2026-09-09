"""pytest config for test/e2e/tests/."""

from __future__ import annotations

import gc
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from harness.fd_guard import assert_no_fd_growth, open_fd_count  # noqa: E402


@pytest.fixture(autouse=True)
def no_process_fd_growth() -> None:
    before = open_fd_count()
    yield
    gc.collect()
    assert_no_fd_growth(before, open_fd_count())
