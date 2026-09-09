import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent))

from e2e.scenarios import _mock_transcript_history as history  # noqa: E402


def test_compact_window_uses_last_seq_for_latest_reachability() -> None:
    assert history.compact_window_retains_latest({"first_seq": 5, "last_seq": history.LATEST_SEQ})
    assert not history.compact_window_retains_latest({"first_seq": history.LATEST_SEQ, "last_seq": 5})


def test_anchor_identity_survives_expected_content_offset_compensation() -> None:
    before = {"anchor_seq": 592, "anchor_index": 8, "offset": 480}
    after = {"anchor_seq": 592, "anchor_index": 9, "offset": 578}
    assert history.anchor_movement_failure(before, after) is None


def test_anchor_identity_change_is_a_failure() -> None:
    assert history.anchor_movement_failure({"anchor_seq": 593}, {"anchor_seq": 595}) == "anchor row changed 593->595"
