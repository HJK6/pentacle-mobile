from __future__ import annotations

import hashlib


FRAME = {"x": 16, "y": 120, "width": 320, "height": 40}


def comment_body(run_id: str) -> str:
    return str(int(hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:12], 16))


def find_accessible_frame(elements: list[dict], identifier: str, *, require_enabled: bool = False):
    for element in elements:
        if element.get("AXIdentifier") == identifier:
            if require_enabled and element.get("AXEnabled") is False:
                continue
            return element.get("frame"), None
    for element in elements:
        if element.get("AXUniqueId") == identifier:
            if require_enabled and element.get("AXEnabled") is False:
                continue
            return element.get("frame"), None
    return None, f"missing accessibility target {identifier}"


def test_comment_body_is_deterministic_and_ascii() -> None:
    body = comment_body("run-1")
    assert body == comment_body("run-1")
    assert body != comment_body("run-2")
    assert body.isascii() and body.isdecimal()


def test_identifier_is_preferred_to_unique_id() -> None:
    frame, error = find_accessible_frame([
        {"AXIdentifier": "primary", "AXUniqueId": "fallback", "frame": FRAME},
    ], "primary")
    assert frame == FRAME
    assert error is None


def test_unique_id_is_a_safe_fallback() -> None:
    frame, error = find_accessible_frame([
        {"AXIdentifier": None, "AXUniqueId": "target", "frame": FRAME},
    ], "target")
    assert frame == FRAME
    assert error is None


def test_disabled_target_is_not_selected_when_enabled_is_required() -> None:
    frame, error = find_accessible_frame([
        {"AXIdentifier": "target", "AXEnabled": False, "frame": FRAME},
    ], "target", require_enabled=True)
    assert frame is None
    assert error == "missing accessibility target target"
