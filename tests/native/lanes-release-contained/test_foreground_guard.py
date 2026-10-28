"""Synthetic foreground controls; no claim these are captured video frames."""
import subprocess
from pathlib import Path

import pytest
import run


def make_ui(tmp_path, monkeypatch, foregrounds):
    calls = []
    ui = run.Ui("SIM", "idb", lambda *args: None, tmp_path)
    ui.bundle = "com.example.pentacle"
    values = iter(foregrounds)
    ui.read_foreground = lambda: next(values)
    ui.find = lambda *_args, **_kwargs: {"AXUniqueId": "target", "frame": {"x": 10, "y": 10, "width": 44, "height": 44}}
    ui.reveal = lambda element: element
    ui._idb = lambda *args: calls.append(args) or subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(run.time, "sleep", lambda _: None)
    return ui, calls


@pytest.mark.parametrize("foreground", [None, "com.apple.Preferences"])
@pytest.mark.parametrize("method", ["tap", "tap_element"])
def test_app_tap_is_blocked_before_input_on_unsafe_foreground(tmp_path, monkeypatch, foreground, method):
    ui, calls = make_ui(tmp_path, monkeypatch, [foreground])
    with pytest.raises(run.SetupFail) as exc:
        if method == "tap":
            ui.tap("target")
        else:
            ui.tap_element(ui.find("target"), "target")
    assert calls == []
    assert exc.value.classification == "HARNESS_ERROR"
    assert exc.value.video_timestamp == "unavailable"
    assert exc.value.timestamp_utc.endswith("Z")


def test_navigation_tap_checks_foreground_after_input(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, ["com.example.pentacle", "com.example.pentacle", "com.apple.Preferences"])
    with pytest.raises(run.SetupFail) as exc:
        ui.tap("target")
    assert len(calls) == 1 and exc.value.classification == "HARNESS_ERROR"


def test_exact_system_alert_exempts_precheck_but_checks_return(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, ["com.example.pentacle"])
    button = {"AXLabel": "Open", "type": "Button", "frame": {"x": 10, "y": 10, "width": 44, "height": 44}}
    screens = iter([[{"AXLabel": "Open in “Pentacle”?", "type": "StaticText"}, button], []])
    ui.elements = lambda: next(screens)
    ui.dump = lambda *_args: Path(tmp_path) / "dump"
    assert ui.clear_system_alerts() == ["Open in “Pentacle”?"]
    assert len(calls) == 1


def test_foreground_parser_rejects_ambiguous_and_malformed():
    roots = [{"role": "AXApplication", "pid": 42}]
    line = "42 0 UIKitApplication:com.example.pentacle[abc]"
    assert run.foreground_bundle(roots, line) == "com.example.pentacle"
    assert run.foreground_bundle(roots + roots, line) is None
    assert run.foreground_bundle(roots, line + "\n" + line) is None
    assert run.foreground_bundle([{"role": "AXApplication"}], line) is None


def test_accepted_system_alert_checks_return_and_fails_closed(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, [None])
    button = {"AXLabel": "Open", "type": "Button", "frame": {"x": 10, "y": 10, "width": 44, "height": 44}}
    ui.elements = lambda: [{"AXLabel": "Open in “Pentacle”?", "type": "StaticText"}, button]
    ui.dump = lambda *_args: Path(tmp_path) / "dump"
    with pytest.raises(run.SystemUIInterception) as exc:
        ui.clear_system_alerts()
    assert len(calls) == 1 and exc.value.foreground == "unavailable"


def test_interception_is_reported_as_setup_not_product_failure(tmp_path, capsys):
    import json
    import test_plan
    err = run.SystemUIInterception("com.apple.Preferences")
    scenario, _calls = test_plan._stubbed(tmp_path, "run_b_list", err)
    assert scenario.execute() == 4
    result = json.loads((scenario.evidence / "result.json").read_text())
    assert result["verdict"] == "SETUP_FAIL"
    assert result["interception"] == {
        "classification": "HARNESS_ERROR", "reason_code": "system_ui_interception",
        "foreground": "com.apple.Preferences", "timestamp_utc": err.timestamp_utc,
        "video_timestamp": "unavailable",
    }


def test_foreground_read_failure_is_unavailable(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, [])
    def broken(): raise TypeError("malformed AX")
    ui.elements = broken
    ui.read_foreground = run.Ui.read_foreground.__get__(ui)
    with pytest.raises(run.SystemUIInterception) as exc:
        ui.tap("target")
    assert exc.value.foreground == "unavailable" and calls == []


def test_app_tap_requires_two_matching_foreground_checks(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, ['com.example.pentacle', 'com.example.pentacle', 'com.example.pentacle'])
    ui.tap('target')
    assert len(calls) == 1


def test_ui_binds_bundle_and_traces_both_checks(tmp_path, monkeypatch):
    events = []
    ui = run.Ui("SIM", "idb", lambda name, data: events.append((name, data)), tmp_path, "com.example.pentacle")
    ui.read_foreground = lambda: "com.example.pentacle"
    ui.find = lambda *_args, **_kwargs: {"AXUniqueId": "target", "frame": {"x": 10, "y": 10, "width": 44, "height": 44}}
    ui.reveal = lambda item: item
    ui._idb = lambda *args: subprocess.CompletedProcess(args, 0, "", "")
    monkeypatch.setattr(run.time, "sleep", lambda _: None)
    ui.tap("target")
    checks = [data for name, data in events if name == "foreground_check"]
    assert len(checks) == 3 and all(c["matched"] and c["at_utc"] for c in checks)


def test_foreground_is_checked_before_lookup_can_report_product_failure(tmp_path, monkeypatch):
    ui, calls = make_ui(tmp_path, monkeypatch, [None])
    def missing(*_args, **_kwargs): raise run.AssertFail('target missing')
    ui.find = missing
    with pytest.raises(run.SystemUIInterception):
        ui.tap('target')
    assert calls == []
