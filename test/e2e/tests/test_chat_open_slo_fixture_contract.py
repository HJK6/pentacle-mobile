from __future__ import annotations


def build_fixture(run_id: str) -> dict:
    return {
        "schema_version": 1,
        "run_id": run_id,
        "frames": [{
            "id": "frame-1",
            "type": "chat.event",
            "event": {
                "kind": "SYSTEM",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "daemon_seq": 1,
                "text": "fixture ready",
            },
        }],
    }


def test_fixture_frames_are_non_empty() -> None:
    payload = build_fixture("contract-nonempty")
    assert isinstance(payload["frames"], list)
    assert payload["frames"]


def test_fixture_frames_follow_the_public_event_shape() -> None:
    payload = build_fixture("contract-shape")
    seen_ids: set[str] = set()
    for index, frame in enumerate(payload["frames"]):
        assert isinstance(frame, dict), f"frames[{index}] must be an object"
        frame_id = frame.get("id")
        assert isinstance(frame_id, str) and frame_id
        assert frame_id not in seen_ids
        seen_ids.add(frame_id)
        assert frame.get("type") == "chat.event"
        event = frame.get("event")
        assert isinstance(event, dict)
        assert isinstance(event.get("kind"), str) and event["kind"]
        assert isinstance(event.get("timestamp"), str) and event["timestamp"]
        assert isinstance(event.get("daemon_seq"), int)
        assert isinstance(event.get("text"), str)
