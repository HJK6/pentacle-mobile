"""Exercise the fixture selected by the real standalone scenario."""

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from e2e.scenarios import nexus_agents_history_questions as scenario
from e2e.tools.scripted_replay import ScriptValidationError, load_script


def selected_fixture():
    return Path(scenario.params({})["scripted_daemon_fixture_path"])


def test_selected_fixture_loads_without_losing_history_or_free_text():
    fixture = selected_fixture()
    script = load_script(fixture)
    assert script.frames
    assert script.frames[0].wait_for_client
    assert script.frames[0].event["stream_id"] == script.stream["stream_id"]
    assert script.frames[0].event["text"].strip()
    parent = script.snapshot["sessions"][0]
    assert parent["agents"][0]["stream_id"] == scenario.CHILD_STREAM_ID
    history = script.snapshot["thread_history"][f'{script.stream["stream_id"]}|{scenario.CHILD_STREAM_ID}']
    assert history["pages"][0]["rows"][0]["text"] == scenario.HISTORY_TEXT
    question = script.notifications[0].notification["question"]
    assert question["question_id"] == "history-question"
    assert question["response_mode"] == "free_text"


@pytest.mark.parametrize("invalid, error", [
    ("empty_frames", "frames must be a non-empty array"),
    ("missing_frame_kind", "event.kind"),
    ("missing_dedup", "question.dedup_key"),
    ("empty_options", "question.options must be a non-empty array"),
])
def test_malformed_selected_fixture_still_fails_closed(tmp_path, invalid, error):
    payload = copy.deepcopy(json.loads(selected_fixture().read_text()))
    if invalid == "empty_frames":
        payload["frames"] = []
    elif invalid == "missing_frame_kind":
        payload["frames"][0]["event"].pop("kind")
    elif invalid == "missing_dedup":
        payload["notifications"][0]["notification"]["question"].pop("dedup_key")
    else:
        payload["notifications"][0]["notification"]["question"]["options"] = []
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ScriptValidationError, match=error.replace(".", r"\.")):
        load_script(path)


def test_actions_pin_disable_pentacle_auth_for_mock_registration():
    """Both cold-launch branches must request disable_pentacle_auth so the app
    takes the __auth_disabled__ hello the mock daemon registers. Without it the
    mock connection depends on ambient simulator credential state and can fail to
    register (missing chat:ws_open; client_registered:false). Regression guard
    for the M1 ws-registration RED (2026-10-28)."""
    assert scenario.actions({"M1_BROAD": "1"}) == [
        "autoaccept_biometric", "disable_pentacle_auth", "open_existing_chat",
    ]
    assert scenario.actions({}) == [
        "autoaccept_biometric", "disable_pentacle_auth", "open_existing_chat",
        "resolve_notification",
    ]
