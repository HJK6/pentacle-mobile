from __future__ import annotations


def build_peer_message(sender: str, message_id: str, first: str, final: str) -> str:
    return f"[from {sender}] [message:{message_id}]\n{first}\n{final}"


def test_peer_message_keeps_one_multiline_envelope_in_order() -> None:
    message = build_peer_message(
        "hostc:stream-1", "message-1", "first line", "final line",
    )
    assert message.startswith("[from hostc:stream-1] [message:message-1]\n")
    assert message.index("first line") < message.index("final line")
    assert message.count("[message:") == 1
