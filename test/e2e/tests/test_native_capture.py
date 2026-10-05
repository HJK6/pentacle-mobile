from __future__ import annotations
import io
import json
from pathlib import Path
import signal
from types import SimpleNamespace
import pytest
from e2e.harness.log_capture import LogStream
from e2e.scenarios import report_viewer_horizontal_scroll as scroll
from e2e.scenarios import report_viewer_comments_keyboard as comments


def test_native_log_stream_uses_the_exact_private_device_set_and_closes(tmp_path, monkeypatch):
    device_set = "/synthetic/private simulator set"
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", device_set)
    calls = []
    class Process:
        def __init__(self):
            self.stdout = io.StringIO("")
            self.status = None
            self.signals = []
        def poll(self): return self.status
        def send_signal(self, value): self.signals.append(value); self.status = 0
        def wait(self, timeout): return self.status
    process = Process()
    def popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return process
    stream = LogStream("synthetic-udid", tmp_path / "native.log", popen=popen)
    stream.start()
    stream.close()
    assert calls[0][0][:7] == ["xcrun", "simctl", "--set", device_set, "spawn", "synthetic-udid", "log"]
    assert process.signals == [signal.SIGTERM]
    assert stream.output.closed and not stream.reader.is_alive()


@pytest.mark.parametrize("root", [None, "", "relative/device-set"])
def test_native_log_invalid_private_set_never_starts_or_creates_log(tmp_path, monkeypatch, root):
    if root is None:
        monkeypatch.delenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", raising=False)
    else:
        monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", root)
    def forbidden(*_args, **_kwargs):
        pytest.fail("invalid namespace must not start log capture")
    path = tmp_path / "native.log"
    stream = LogStream("synthetic-udid", path, popen=forbidden)
    try:
        with pytest.raises(ValueError, match="PENTACLE_SCENARIO_DEVICE_SET_ROOT"):
            stream.start()
    finally:
        stream.close()
    assert not path.exists()


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
