from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    name: str
    at: float
    data: dict


def reconcile_after_disconnect(events: list[Event]) -> tuple[str, str | None]:
    inserted = False
    disconnected = False
    reconciled = False
    rendered_state: str | None = None
    for event in events:
        if event.name == "compose.optimistic_insert":
            inserted = True
        elif event.name == "connection.closed":
            disconnected = True
        elif event.name == "compose.reconciled":
            reconciled = inserted and disconnected
        elif event.name == "row.rendered":
            rendered_state = event.data.get("send_state")

    if not inserted:
        return "FAIL", "missing optimistic row"
    if not disconnected:
        return "FAIL", "test did not cover a disconnect"
    if not reconciled:
        return "FAIL", "pending message was not reconciled after reconnect"
    if rendered_state != "sent":
        return "FAIL", "rendered row did not reach sent state"
    return "PASS", None


def _events(final_name: str = "compose.reconciled", final_state: str = "sent") -> list[Event]:
    return [
        Event("screen.mounted", 1.0, {"stream_id": "hostc:sample"}),
        Event("compose.optimistic_insert", 2.0, {"message_id": "optimistic-1"}),
        Event("connection.closed", 3.0, {}),
        Event("connection.open", 4.0, {}),
        Event(final_name, 5.0, {"message_id": "optimistic-1"}),
        Event("row.rendered", 6.0, {"message_id": "optimistic-1", "send_state": final_state}),
    ]


def test_pending_message_reconciles_after_a_connection_drop() -> None:
    assert reconcile_after_disconnect(_events()) == ("PASS", None)


def test_failed_reconciliation_is_visible() -> None:
    verdict, error = reconcile_after_disconnect(_events("compose.failed", "failed"))
    assert verdict == "FAIL"
    assert "reconciled" in (error or "")


def test_a_sending_row_does_not_count_as_reconciled() -> None:
    verdict, error = reconcile_after_disconnect(_events(final_state="sending"))
    assert verdict == "FAIL"
    assert "sent state" in (error or "")


def test_missing_optimistic_insert_fails_closed() -> None:
    verdict, error = reconcile_after_disconnect([
        Event("connection.closed", 1.0, {}),
        Event("compose.reconciled", 2.0, {}),
        Event("row.rendered", 3.0, {"send_state": "sent"}),
    ])
    assert verdict == "FAIL"
    assert error == "missing optimistic row"
