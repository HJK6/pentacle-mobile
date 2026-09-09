from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    name: str
    stream_id: str
    kind: str | None = None
    lifecycle: str | None = None


def assert_reply_rendered(events: list[Event], stream_id: str) -> tuple[bool, str | None]:
    if any(
        event.name == "row.rendered"
        and event.stream_id == stream_id
        and event.kind == "ASSIST"
        and event.lifecycle == "mount"
        for event in events
    ):
        return True, None
    return False, "assistant reply row was not rendered"


def assert_landing(events: list[Event], stream_id: str) -> tuple[bool, str | None]:
    settled = any(event.name == "history.ready" and event.stream_id == stream_id for event in events)
    mounted = any(
        event.name == "row.rendered"
        and event.stream_id == stream_id
        and event.lifecycle == "mount"
        for event in events
    )
    if settled and mounted:
        return True, None
    return False, "landing was not corroborated by a mounted row"


STREAM_ID = "hostc:stream-1"


def test_missing_assistant_row_is_a_negative_proof() -> None:
    ok, error = assert_reply_rendered([
        Event("history.ready", STREAM_ID),
        Event("row.rendered", STREAM_ID, "USER", "mount"),
    ], STREAM_ID)
    assert not ok
    assert "assistant" in (error or "")


def test_assistant_mount_passes_the_reply_check() -> None:
    assert assert_reply_rendered([
        Event("row.rendered", STREAM_ID, "ASSIST", "mount"),
    ], STREAM_ID) == (True, None)


def test_landing_requires_a_mounted_row() -> None:
    ok, error = assert_landing([Event("history.ready", STREAM_ID)], STREAM_ID)
    assert not ok
    assert "corroborated" in (error or "")


def test_non_mount_row_does_not_corrobate_landing() -> None:
    assert assert_landing([
        Event("history.ready", STREAM_ID),
        Event("row.rendered", STREAM_ID, "ASSIST", "unmount"),
    ], STREAM_ID)[0] is False
