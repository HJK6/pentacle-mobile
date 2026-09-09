from __future__ import annotations


PUBLIC_EVENTS = {
    "question.opened",
    "question.resolved",
    "chat.history_loaded",
    "chat.row_rendered",
}


def load_registry() -> set[str]:
    return set(PUBLIC_EVENTS)


def test_registry_includes_public_question_and_chat_events() -> None:
    registry = load_registry()
    assert {
        "question.opened",
        "question.resolved",
        "chat.history_loaded",
        "chat.row_rendered",
    } <= registry


def test_registry_is_deterministic_and_does_not_depend_on_machine_state() -> None:
    assert load_registry() == load_registry()
