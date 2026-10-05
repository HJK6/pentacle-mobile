from __future__ import annotations
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from e2e.harness.log_capture import LogStream
from e2e.scenarios import report_viewer_horizontal_scroll as scroll
from e2e.scenarios import report_viewer_comments_keyboard as comments


def test_native_log_envelope_preserves_pid_and_never_invents_it(tmp_path):
    stream = LogStream("synthetic-udid", tmp_path / "native.log")
    payload = {"message": "harness:harness_armed", "data": {"scenario_run_id": "owned-run"}}
    stream.feed_line(json.dumps({"processID": 91, "eventMessage": "[TELEMETRY] " + json.dumps(payload)}))
    stream.feed_line("[TELEMETRY] " + json.dumps(payload))
    stream.feed_line('[TELEMETRY] {"message": "truncated"<…>')
    events = stream.all_events()
    assert len(events) == 2 and events[0].native_pid == "91" and events[1].native_pid is None
    assert json.loads(events[0].raw)["processID"] == 91
    assert events[0].data == {"scenario_run_id": "owned-run"}


def test_accessibility_identifier_precedes_alias_and_disabled_targets_are_rejected():
    frame = {"x": 1, "y": 2, "width": 10, "height": 20}
    preferred = {"x": 3, "y": 4, "width": 10, "height": 20}
    elements = [{"AXUniqueId": "target", "frame": frame}, {"AXIdentifier": "target", "frame": preferred}]
    assert scroll.accessible_frame(elements, "target") == preferred
    assert scroll.accessible_frame([{ "AXIdentifier": "target", "AXEnabled": False, "frame": frame}], "target", True) is None
    assert comments.comment_body("run-a").isdecimal()
    assert comments.comment_body("run-a") != comments.comment_body("run-b")


def test_accessibility_poll_uses_the_bound_udid_and_requires_observed_targets(monkeypatch):
    calls = []
    frame = {"x": 1, "y": 2, "width": 100, "height": 20}
    def describe(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout=json.dumps([{"AXIdentifier": "target", "frame": frame}]), stderr="")
    monkeypatch.setattr(scroll.subprocess, "run", describe)
    assert scroll._poll_element_frames("exact-udid", {"target"}) == {"target": frame}
    assert calls[0] == ["idb", "ui", "describe-all", "--udid", "exact-udid", "--json"]
    monkeypatch.setattr(scroll.time, "sleep", lambda _: None)
    assert scroll._poll_element_frames("exact-udid", {"missing"}, timeout_s=0) == {}


def test_accessibility_poll_accepts_real_idb_jsonl_and_rejects_truncation(monkeypatch):
    frame = {"x": 1, "y": 2, "width": 100, "height": 20}
    lines = '\n'.join(json.dumps({"AXIdentifier": identifier, "frame": frame}) for identifier in ['target', 'other'])
    monkeypatch.setattr(scroll.subprocess, "run", lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=lines, stderr=""))
    assert scroll._poll_element_frames("exact-udid", {"target"}) == {"target": frame}
    lines += '\n{"truncated"'
    assert scroll._poll_element_frames("exact-udid", {"target"}, timeout_s=0) == {}
