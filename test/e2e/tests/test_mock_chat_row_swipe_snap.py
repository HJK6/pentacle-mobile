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
    assert scenario.actions({}) == ["autoaccept_biometric", "open_existing_chat"]
    assert callable(scenario.wait_seeded_chat_rows)
    assert scenario.ACTION_WIDTH == 64
    assert scenario.OPEN_WIDTH == 128


def test_row_surface_matches_production_accessibility_ids() -> None:
    assert scenario._row_surface("mock-host:swipe-row-14") == (
        "chat-row-mock-host-swipe-row-14",
        "chat-row-rename-mock-host-swipe-row-14",
        "chat-row-delete-mock-host-swipe-row-14",
    )


def test_swipe_readiness_census_and_missing_row_fail_closed(monkeypatch):
    ids = [scenario._row_surface(stream_id)[0] for stream_id in scenario._candidate_stream_ids()]
    frame = {'x': 0, 'y': 0, 'width': 300, 'height': 20}
    states = iter([{key: frame for key in ids[:12]}, {key: frame for key in ids[6:]}, {ids[0]: frame}])
    calls = []
    monkeypatch.setattr(scenario, '_visible_chat_rows', lambda *_: next(states))
    monkeypatch.setattr(scenario, '_census_scroll', lambda _u, direction: calls.append(direction) or True)
    assert scenario.wait_seeded_chat_rows('owned') == {ids[0]: frame}
    assert calls == ['down', 'up']
    monkeypatch.setattr(scenario, '_visible_chat_rows', lambda *_: {key: frame for key in ids[:-1]})
    monkeypatch.setattr(scenario, '_census_scroll', lambda *_: True)
    assert scenario.wait_seeded_chat_rows('owned') == {}


def test_census_requires_successful_return_to_top(monkeypatch):
    ids = [scenario._row_surface(s)[0] for s in scenario._candidate_stream_ids()]
    frame = {'x': 0, 'y': 0, 'width': 20, 'height': 20}
    states = iter([{key: frame for key in ids[:12]}, {key: frame for key in ids[6:]}, {ids[-1]: frame}])
    monkeypatch.setattr(scenario, '_visible_chat_rows', lambda *_: next(states))
    monkeypatch.setattr(scenario, '_census_scroll', lambda *_: True)
    monkeypatch.setattr(scenario.time, 'sleep', lambda *_: None)
    assert scenario.wait_seeded_chat_rows('owned') == {}


def test_back_navigation_requires_two_matching_hit_tests(monkeypatch):
    frame = {'x': 0, 'y': 0, 'width': 10, 'height': 10}
    monkeypatch.setattr(scenario, '_elements', lambda *_: [{'AXLabel': 'Back to chats', 'frame': frame}])
    calls = []
    def command(_udid, *args):
        calls.append(args)
        return {'AXLabel': 'Back to chats'} if args[0] == 'describe-point' else None
    monkeypatch.setattr(scenario, '_ax', command)
    monkeypatch.setattr(scenario.time, 'sleep', lambda *_: None)
    scenario.open_chats_from_session('owned')
    assert [args[0] for args in calls] == ['describe-point', 'describe-point', 'tap']
