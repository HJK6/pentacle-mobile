from __future__ import annotations

import json

from e2e.scenarios import mock_chat_row_swipe_snap as scenario


def test_endpoint_oracle_accepts_only_discrete_positions() -> None:
    assert scenario.endpoint_failure(200, 200, "closed") is None
    assert scenario.endpoint_failure(200, 72, "open") is None
    assert scenario.endpoint_failure(200, 140, "closed")
    assert scenario.endpoint_failure(200, 140, "open")


def test_close_swipe_starts_on_the_visible_translated_row() -> None:
    assert scenario.close_swipe_start_x(12, -116, 350) == 82


def test_fixture_seeds_a_scrollable_chat_list(tmp_path) -> None:
    fixture = tmp_path / "swipe.json"
    scenario._write_fixture(fixture)
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    assert len(payload["snapshot"]["sessions"]) >= 12
    assert payload["snapshot"]["sessions"][0]["stream_id"] == scenario.M.STREAM_ID


def test_scenario_declares_the_real_gesture_surface() -> None:
    assert scenario.actions({}) == ["autoaccept_biometric", "all_chats_regression"]
    assert scenario.ACTION_WIDTH == 64
    assert scenario.OPEN_WIDTH == 128


def test_row_surface_matches_production_accessibility_ids() -> None:
    assert scenario._row_surface("mock-host:swipe-row-14") == (
        "chat-row-mock-host-swipe-row-14",
        "chat-row-rename-mock-host-swipe-row-14",
        "chat-row-delete-mock-host-swipe-row-14",
    )
