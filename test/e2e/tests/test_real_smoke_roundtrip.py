from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    name: str
    message_id: str | None = None


def roundtrip(events: list[Event], message_id: str) -> tuple[str, str | None]:
    inserted = any(event.name == "compose.inserted" and event.message_id == message_id for event in events)
    reconciled = any(event.name == "compose.reconciled" and event.message_id == message_id for event in events)
    rendered = any(event.name == "row.rendered" and event.message_id == message_id for event in events)
    if not inserted:
        return "FAIL", "message was not inserted"
    if not reconciled:
        return "FAIL", "message was not reconciled"
    if not rendered:
        return "FAIL", "message was not rendered"
    return "PASS", None


def test_roundtrip_accepts_a_matching_insert_reconcile_render_sequence() -> None:
    verdict = roundtrip([
        Event("screen.mounted"),
        Event("compose.inserted", "message-1"),
        Event("compose.reconciled", "message-1"),
        Event("row.rendered", "message-1"),
    ], "message-1")
    assert verdict == ("PASS", None)


def test_roundtrip_rejects_a_reconciliation_for_another_message() -> None:
    verdict = roundtrip([
        Event("compose.inserted", "message-1"),
        Event("compose.reconciled", "message-2"),
        Event("row.rendered", "message-1"),
    ], "message-1")
    assert verdict == ("FAIL", "message was not reconciled")
