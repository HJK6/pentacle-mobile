from __future__ import annotations


def relaunch_contract_error(
    target_stream: str,
    sender_stream: str,
    provider: str,
    host: str,
    actions: list[str],
    params: dict,
) -> str | None:
    if params.get("stream_id") != target_stream:
        return "target stream mismatch"
    if params.get("sender_stream") != sender_stream:
        return "sender stream mismatch"
    if params.get("provider") != provider:
        return "provider mismatch"
    if params.get("host") != host:
        return "host mismatch"
    if actions != ["ready", "open", "send"]:
        return "unexpected action sequence"
    return None


def test_relaunch_is_bound_to_the_supplied_stream_and_config() -> None:
    params = {
        "stream_id": "hostc:stream-1",
        "sender_stream": "hostc:stream-2",
        "provider": "codex",
        "host": "hostc",
    }
    assert relaunch_contract_error(
        "hostc:stream-1", "hostc:stream-2", "codex", "hostc",
        ["ready", "open", "send"], params,
    ) is None


def test_relaunch_rejects_wrong_stream_provider_or_host() -> None:
    base = {
        "stream_id": "hostc:stream-1",
        "sender_stream": "hostc:stream-2",
        "provider": "codex",
        "host": "hostc",
    }
    for field, value in [
        ("stream_id", "hostc:other"),
        ("provider", "sample"),
        ("host", "hosta"),
    ]:
        assert relaunch_contract_error(
            "hostc:stream-1", "hostc:stream-2", "codex", "hostc",
            ["ready", "open", "send"], {**base, field: value},
        )


def test_relaunch_rejects_an_unexpected_extra_action() -> None:
    params = {
        "stream_id": "hostc:stream-1",
        "sender_stream": "hostc:stream-2",
        "provider": "codex",
        "host": "hostc",
    }
    assert relaunch_contract_error(
        "hostc:stream-1", "hostc:stream-2", "codex", "hostc",
        ["ready", "open", "send", "open"], params,
    )
