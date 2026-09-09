from __future__ import annotations


def render_turns(turns: list[dict]) -> list[dict]:
    rendered = []
    for turn in turns:
        rendered.append({"kind": "USER", "text": turn["prompt"]})
        rendered.append({"kind": "DIVIDER", "turn": turn["id"]})
        rendered.append({"kind": "ASSIST", "text": turn["reply"]})
    return rendered


def test_one_divider_is_rendered_for_each_turn() -> None:
    rows = render_turns([
        {"id": "turn-1", "prompt": "first", "reply": "one"},
        {"id": "turn-2", "prompt": "second", "reply": "two"},
    ])
    assert [row["kind"] for row in rows] == [
        "USER", "DIVIDER", "ASSIST", "USER", "DIVIDER", "ASSIST",
    ]
    assert [row["turn"] for row in rows if row["kind"] == "DIVIDER"] == ["turn-1", "turn-2"]


def test_repeated_observation_does_not_add_a_second_divider() -> None:
    rows = render_turns([{"id": "turn-1", "prompt": "first", "reply": "one"}])
    observed = rows + [row for row in rows if row["kind"] == "DIVIDER"]
    divider_ids = {row["turn"] for row in observed if row["kind"] == "DIVIDER"}
    assert len(divider_ids) == 1
