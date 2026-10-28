"""Offline controls: Settings PID/root from retained run 91dc3689; other states synthetic."""
import json
import subprocess
import pytest
from e2e.scenarios import _m1_native_ui as native
from e2e.scenarios import nexus_agents_history_questions as scenario

APP = 'com.example.pentacle.harness'


def test_foreground_maps_unique_ax_pid_to_launchctl_bundle():
    settings = [{'role': 'AXApplication', 'AXLabel': 'Settings', 'pid': 69340}]
    jobs = 'PID\tStatus\tLabel\n69340\t0\tUIKitApplication:com.apple.Preferences[005d][rb-legacy]\n'
    assert native.foreground_bundle(settings, jobs) == 'com.apple.Preferences'
    assert native.foreground_bundle(settings, '') is None
    assert native.foreground_bundle(settings + settings, jobs) is None
    assert native.foreground_bundle(settings, jobs + jobs) is None


def test_navigation_classification_preserves_product_failure():
    with pytest.raises(native.SystemUIInterception) as error:
        native.check_navigation(APP, 'com.apple.Preferences', False, 17.6)
    assert error.value.foreground == 'com.apple.Preferences'
    assert error.value.video_timestamp_s == 17.6
    with pytest.raises(native.SystemUIInterception):
        native.check_navigation(APP, None, False, 18.0)
    with pytest.raises(AssertionError):
        native.check_navigation(APP, APP, False, 19.0)
    native.check_navigation(APP, APP, True, 20.0)


def test_broad_result_classifies_interception_and_preserves_assertions(monkeypatch):
    from e2e.scenarios import _m1_mock_control as control
    class Control:
        def __init__(self, *_): pass
        def close(self): pass
    monkeypatch.setattr(scenario.M, 'await_mock_session_open', lambda *a, **k: None)
    monkeypatch.setattr(native, 'NativeUI', lambda _: object())
    monkeypatch.setattr(control, 'MockControl', Control)
    monkeypatch.setattr(scenario, '_NativeTrace', lambda _: object())
    def fail(*_): raise native.SystemUIInterception('com.apple.Preferences', 17.6)
    monkeypatch.setattr(scenario, 'drive_history_navigation', fail)
    result = scenario.run_broad({'M1_MOCK_WS_URL': 'ws://127.0.0.1:1'}, None).to_dict()
    assert result['verdict'] == 'SETUP_FAIL'
    assert result['extras']['reason_code'] == 'system_ui_interception'
    assert result['extras']['frontmost_bundle_id'] == 'com.apple.Preferences'
    assert result['extras']['video_timestamp_s'] == 17.6
    def assertion(*_): raise AssertionError('missing')
    monkeypatch.setattr(scenario, 'drive_history_navigation', assertion)
    assert scenario.run_broad({'M1_MOCK_WS_URL': 'ws://127.0.0.1:1'}, None).verdict == 'FAIL'


def test_tap_checks_frontground_and_never_retries(monkeypatch):
    ui = native.NativeUI({'SIMULATOR_UDID': 'test', 'trace': lambda *_: None,
                          'PENTACLE_BUNDLE_ID': APP, '_video_started_at': 100.0})
    calls = []
    ui.wait = lambda *a, **k: {'frame': {'x': 0, 'y': 0, 'width': 10, 'height': 10}}
    ui._command = lambda *args: calls.append(args) or ''
    ui.read_foreground = lambda: 'com.apple.Preferences'
    monkeypatch.setattr(native.time, 'time', lambda: 117.6)
    with pytest.raises(native.SystemUIInterception):
        ui.tap(label='Close session status')
    assert [c[0] for c in calls].count('tap') == 1


def test_setup_failure_serializes_and_exits_four(tmp_path, capsys):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[1] / 'run_scenario.py'
    spec = importlib.util.spec_from_file_location('m1_guard_runner', path)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    env = tmp_path / 'case.env'
    env.write_text('M1_BROAD=1\n')
    def execute(name, config, runs, stem):
        result = {'name': name, 'verdict': 'SETUP_FAIL', 'extras': {
            'reason_code': 'system_ui_interception', 'frontmost_bundle_id': 'com.apple.Preferences', 'video_timestamp_s': 17.6}}
        return {'scenario': name, 'verdict': 'SETUP_FAIL', 'result': result}, {'closed_count': 0}
    assert runner.main(['nexus_agents_history_questions', '--env-file', str(env), '--runs-dir', str(tmp_path / 'runs')], execute=execute) == 4
    out = json.loads(capsys.readouterr().out)
    result = json.loads(Path(out['result']).read_text())['result']
    assert result['extras']['reason_code'] == 'system_ui_interception'
    assert result['extras']['video_timestamp_s'] == 17.6


def test_missing_destination_is_failure_when_app_stays_foreground(monkeypatch):
    ui = native.NativeUI({'SIMULATOR_UDID': 'test', 'trace': lambda *_: None,
                          'PENTACLE_BUNDLE_ID': APP, '_video_started_at': 100.0})
    ui.read_foreground = lambda: APP
    ui.elements = lambda: [{'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 100, 'height': 100}}]
    ticks = iter([0, 0, 2])
    monkeypatch.setattr(native.time, 'monotonic', lambda: next(ticks))
    monkeypatch.setattr(native.time, 'sleep', lambda *_: None)
    with pytest.raises(RuntimeError, match='missing'):
        ui.wait(identifier='expected-destination', timeout=1)


def test_changed_foreground_is_not_swallowed_while_waiting(monkeypatch):
    ui = native.NativeUI({'SIMULATOR_UDID': 'test', 'trace': lambda *_: None,
                          'PENTACLE_BUNDLE_ID': APP, '_video_started_at': 100.0})
    ui.read_foreground = lambda: 'com.apple.Preferences'
    with pytest.raises(native.SystemUIInterception):
        ui.wait_hit('expected destination', timeout=1)
