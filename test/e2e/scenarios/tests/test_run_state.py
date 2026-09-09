"""Unit tests for _run_state.

Cover:
  - happy path: save then load returns the same stream_id.
  - missing file -> load returns None.
  - atomic write: the tmp file lives in the same dir as the destination
    and is renamed to the final name (no foreign tmp left over).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import _run_state as RS


def test_save_then_load_round_trip(tmp_path: Path):
    state_dir = tmp_path / "state"
    RS.save_seeded_stream(
        run_id="r1", host="hostc", provider="claude", stream_id="abc",
        state_dir=str(state_dir),
    )
    assert RS.load_seeded_stream("r1", "hostc", "claude", state_dir=str(state_dir)) == "abc"


def test_load_missing_file_returns_none(tmp_path: Path):
    state_dir = tmp_path / "nope"
    assert RS.load_seeded_stream("r1", "hostc", "claude", state_dir=str(state_dir)) is None


def test_load_missing_host_returns_none(tmp_path: Path):
    state_dir = tmp_path / "state"
    RS.save_seeded_stream("r1", "hostc", "claude", "abc", state_dir=str(state_dir))
    assert RS.load_seeded_stream("r1", "hosta", "claude", state_dir=str(state_dir)) is None


def test_load_missing_provider_returns_none(tmp_path: Path):
    state_dir = tmp_path / "state"
    RS.save_seeded_stream("r1", "hostc", "claude", "abc", state_dir=str(state_dir))
    assert RS.load_seeded_stream("r1", "hostc", "codex", state_dir=str(state_dir)) is None


def test_save_merges_existing_entries(tmp_path: Path):
    state_dir = tmp_path / "state"
    RS.save_seeded_stream("r1", "hostc", "claude", "abc", state_dir=str(state_dir))
    RS.save_seeded_stream("r1", "hostc", "codex", "def", state_dir=str(state_dir))
    RS.save_seeded_stream("r1", "hosta", "claude", "ghi", state_dir=str(state_dir))
    assert RS.load_seeded_stream("r1", "hostc", "claude", state_dir=str(state_dir)) == "abc"
    assert RS.load_seeded_stream("r1", "hostc", "codex", state_dir=str(state_dir)) == "def"
    assert RS.load_seeded_stream("r1", "hosta", "claude", state_dir=str(state_dir)) == "ghi"


def test_atomic_write_uses_same_dir_tmp_then_rename(tmp_path: Path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    final_path = state_dir / RS.STATE_FILE

    rename_calls: list[tuple[str, str]] = []
    real_rename = os.rename

    def spy_rename(src, dst):
        rename_calls.append((str(src), str(dst)))
        real_rename(src, dst)

    monkeypatch.setattr(RS.os, "rename", spy_rename)
    RS.save_seeded_stream("r1", "hostc", "claude", "abc", state_dir=str(state_dir))
    # Final file exists and parses.
    assert final_path.exists()
    parsed = json.loads(final_path.read_text())
    assert parsed["hostc"]["claude"]["stream_id"] == "abc"
    # At least one rename happened, src lived in the same directory as dst.
    assert rename_calls, "expected os.rename to be called for the atomic write"
    src, dst = rename_calls[-1]
    assert Path(src).parent == Path(dst).parent == state_dir
    # No stray tmp files left over.
    leftover = [p for p in state_dir.iterdir() if p.name.endswith(".tmp")]
    assert not leftover, f"expected no leftover tmp files, found: {leftover}"


def test_state_path_default_dir():
    """state_path uses /tmp/example-mobile-state-<run_id> when state_dir is None."""
    p = RS.state_path("r42")
    assert str(p) == "/tmp/example-mobile-state-r42/seeded.json"


def test_state_path_explicit_dir():
    p = RS.state_path("r42", state_dir="/var/foo")
    assert str(p) == "/var/foo/seeded.json"

