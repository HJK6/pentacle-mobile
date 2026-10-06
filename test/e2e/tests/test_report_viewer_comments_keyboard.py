from __future__ import annotations

import hashlib
import json
import subprocess
from types import SimpleNamespace

import pytest


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


def test_actual_comment_scenario_uses_native_marker_for_coordinate_tap(monkeypatch) -> None:
    from e2e.scenarios import report_viewer_comments_keyboard as scenario
    run_id, udid = "selector-contract", "OWNED-UDID"
    # Shape from the pre-tap idb receipt: the accessible, pointerless marker
    # exposes AXUniqueId; the underlying Pressable's React testID is absent.
    native_tree = [{"AXUniqueId": f"report-block-comment-target--{run_id}",
                    "enabled": True, "type": "GenericElement",
                    "frame": {"x": 16, "y": 426.00000762939453, "width": 370, "height": 43}}]
    ready = SimpleNamespace(message="harness:report_viewer_ready", received_at=0,
                            data={"scenario_run_id": run_id})
    stream = SimpleNamespace(all_events=lambda: [ready])
    calls = []
    class FirstTap(BaseException):
        pass
    def boundary(argv, **_kwargs):
        calls.append(argv)
        if argv == ["idb", "ui", "describe-all", "--udid", udid, "--json"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(native_tree), "")
        assert argv == ["idb", "ui", "tap", "201", "447", "--udid", udid]
        raise FirstTap()
    monkeypatch.setattr(subprocess, "run", boundary)
    with pytest.raises(FirstTap):
        scenario.run({"scenario_run_id": run_id, "SIMULATOR_UDID": udid,
                      "trace": lambda *_: None}, stream)
    assert len(calls) == 2  # No input, text, Send, fake keyboard or scenario PASS.
