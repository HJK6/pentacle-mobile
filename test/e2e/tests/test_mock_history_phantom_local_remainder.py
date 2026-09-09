from __future__ import annotations


def build_history(hidden_count: int = 4, visible_count: int = 2) -> dict:
    events = [
        {"kind": "SYSTEM", "text": f"hidden-{index}"}
        for index in range(hidden_count)
    ]
    events.extend(
        {"kind": kind, "text": f"visible-{index}"}
        for index, kind in enumerate(["USER", "ASSIST"] * visible_count)
    )
    return {"history": {"events": events}, "snapshot": {"events": []}}


def test_history_keeps_hidden_rows_out_of_the_visible_snapshot() -> None:
    payload = build_history()
    events = payload["history"]["events"]
    assert len(events) == 8
    assert all(event["kind"] == "SYSTEM" for event in events[:4])
    assert all(event["kind"] in {"USER", "ASSIST"} for event in events[4:])
    assert payload["snapshot"]["events"] == []
