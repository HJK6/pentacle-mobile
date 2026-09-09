"""Per-test process file-descriptor leak guard."""

from __future__ import annotations

import os
from pathlib import Path


def open_fd_count() -> int:
    root = Path("/dev/fd") if Path("/dev/fd").is_dir() else Path("/proc/self/fd")
    return sum(name.isdigit() for name in os.listdir(root))


def assert_no_fd_growth(before: int, after: int) -> None:
    if after > before:
        raise AssertionError(f"open file descriptor count grew across test: {before} -> {after}")
