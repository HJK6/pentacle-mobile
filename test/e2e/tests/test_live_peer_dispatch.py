from __future__ import annotations

import json
from pathlib import Path

import pytest


def matches_delivery(event: dict, sender: str, message_id: str, body: str) -> bool:
    text = event.get("text")
    expected = f"[from {sender}] [message:{message_id}]\n{body}"
    return event.get("kind") == "USER" and text == expected


def write_receipt(path: Path, result: dict) -> None:
    path.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")


def receipt_allows_correlation(receipt: dict, message_id: str, target: str) -> bool:
    return (
        receipt.get("type") == "send.result"
        and receipt.get("to_stream_id") == target
        and receipt.get("message_id") == message_id
        and receipt.get("delivery") == "committed"
        and receipt.get("action_committed") is True
        and receipt.get("confirmation_pending") is True
        and receipt.get("do_not_resubmit") is True
    )


def test_message_envelope_keeps_exact_delivery_identity() -> None:
    sender, message_id, body = "hostc:stream-1", "message-1", "preview"
    event = {"kind": "USER", "text": f"[from {sender}] [message:{message_id}]\n{body}"}
    assert matches_delivery(event, sender, message_id, body)
    assert not matches_delivery(event, "hostc:other", message_id, body)
    assert not matches_delivery(event, sender, "message-2", body)
    assert not matches_delivery(event, sender, message_id, body + " changed")


@pytest.mark.parametrize("delivery,accepted", [
    ("committed", True),
    ("pending", False),
    ("rejected", False),
])
def test_receipt_is_written_once_for_each_delivery_state(tmp_path: Path, delivery: str, accepted: bool) -> None:
    path = tmp_path / "receipt.json"
    write_receipt(path, {
        "type": "send.result",
        "to_stream_id": "hostc:stream-1",
        "message_id": "message-1",
        "delivery": delivery,
        "action_committed": delivery == "committed",
        "confirmation_pending": delivery == "committed",
        "do_not_resubmit": delivery == "committed",
    })
    receipt = json.loads(path.read_text(encoding="utf-8"))
    assert receipt_allows_correlation(receipt, "message-1", "hostc:stream-1") is accepted


def test_pending_receipt_never_correlates_to_another_stream() -> None:
    receipt = {
        "type": "send.result",
        "to_stream_id": "hostc:stream-1",
        "message_id": "message-1",
        "delivery": "committed",
        "action_committed": True,
        "confirmation_pending": True,
        "do_not_resubmit": True,
    }
    assert not receipt_allows_correlation(receipt, "message-1", "hostb:stream-2")
