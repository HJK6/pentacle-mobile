from __future__ import annotations
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import pytest
import run_scenario as runner
from e2e.harness.telemetry_events import TelemetryEvent


def rehearsal(directory, *, explicit, monkeypatch):
    root = Path(directory)
    env_file = root / ".pentacle-test.env"
    env_file.write_text('PENTACLE_BUNDLE_ID=com.example.synthetic.harness\nSYNTHETIC_VALUE="with input"\n')
    output = root / "runs"
    observed = []
    def boundary(name, config, runs_dir, stem):
        observed.append((name, config, runs_dir, stem))
        return {"scenario": name, "verdict": "PASS", "all_events": []}, {"attempted": 0, "closed": [], "closed_count": 0, "orphans": [], "orphan_count": 0}
    monkeypatch.delenv("PENTACLE_BUNDLE_ID", raising=False)
    args = ["report_viewer_horizontal_scroll", "--runs-dir", str(output)]
    if explicit:
        args += ["--env-file", str(env_file)]
    else:
        monkeypatch.setattr(Path, "home", lambda: root)
    assert runner.main(args, execute=boundary) == 0
    name, config, runs_dir, stem = observed[0]
    assert name == "report_viewer_horizontal_scroll" and runs_dir == output
    assert config["env_file"] == str(env_file)
    assert config["PENTACLE_BUNDLE_ID"] == "com.example.synthetic.harness"
    assert config["SYNTHETIC_VALUE"] == "with input"
    assert json.loads((output / (stem + ".json")).read_text())["verdict"] == "PASS"
    assert len(list(output.glob("*.json"))) == 2
    return env_file, output


def test_scenario_env_file_success_and_cleanup(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        env_file, output = rehearsal(directory, explicit=True, monkeypatch=monkeypatch)
    assert not env_file.exists() and not output.exists() and not Path(directory).exists()


def test_scenario_env_file_default_success_and_cleanup(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        env_file, output = rehearsal(directory, explicit=False, monkeypatch=monkeypatch)
    assert not env_file.exists() and not output.exists() and not Path(directory).exists()


@pytest.mark.parametrize("content", [None, "malformed input", "VALUE='unclosed", "VALUE=a\nVALUE=b"])
def test_scenario_env_file_missing_or_malformed_fails_before_native_dispatch(tmp_path, content):
    env_file = tmp_path / ".pentacle-test.env"
    if content is not None:
        env_file.write_text(content)
    def forbidden(*_args):
        pytest.fail("malformed input must not dispatch native work")
    output = tmp_path / "runs"
    assert runner.main(["report_viewer_horizontal_scroll", "--runs-dir", str(output), "--env-file", str(env_file)], execute=forbidden) == 4
    results = [p for p in output.glob("*.json") if not p.name.endswith(".teardown.json")]
    assert len(results) == 1
    assert json.loads(results[0].read_text())["verdict"] == "SETUP_FAIL"


def test_native_identity_resolver_requires_the_exact_bundle_and_successful_census():
    result = SimpleNamespace(returncode=0, stdout="PID Status Label\n91 0 UIKitApplication:com.example.harness[abc]\n92 0 UIKitApplication:com.example.harness.other[abc]\n", stderr="")
    assert runner.resolve_pids(result, "com.example.harness") == ["91"]
    with pytest.raises(RuntimeError, match="census failed"):
        runner.resolve_pids(SimpleNamespace(returncode=1), "com.example.harness")


def test_crash_proof_requires_the_exact_launched_pid_and_native_signal():
    assert runner.crash_signal(["process 91 exited cleanly", "process 191 SIGABRT"], "91") is None
    proof = runner.crash_signal(["UIKitApplication:synthetic[91] Service exited due to SIGABRT"], "91")
    assert proof["pid"] == "91" and proof["signal"] == "SIGABRT"


@pytest.mark.parametrize("sentinel", ["clean", "crash_only", "liveness_loss"])
@pytest.mark.parametrize("armed_pid,expected", [("91", "PASS"), ("77", "SETUP_FAIL")])
def test_native_dispatch_binds_actual_launch_and_census_and_cleans_its_resources(tmp_path, monkeypatch, armed_pid, expected, sentinel):
    state = {"launched": False, "log_closed": False, "recorder_closed": False}
    bundle = "com.example.synthetic.harness"
    udid = "12345678-1234-1234-1234-123456789abc"
    device_set = "/synthetic/private simulator set"
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", device_set)
    if armed_pid == "91" and sentinel != "clean":
        expected = "FAIL"  # The reporter consumes these owned-exit cases as expected RED.
    def event(message, **data):
        item = TelemetryEvent("harness", message, "", data, 1, "supplied native record")
        item.native_pid = armed_pid
        return item
    events = [event("harness:harness_armed", scenario_run_id="owned", scenario="report_viewer_runtime_sentinel"),
              event("harness:runtime_sentinel_ready", scenario_run_id="owned", sentinel=sentinel)]
    class Logs:
        def __init__(self, _udid, raw_path, **_kwargs):
            raw_path.write_text("supplied fixture log\n")
            self.lines = []
        def start(self): return self
        def all_events(self): return events
        def next_event(self, **_kwargs): return None
        def close(self): state["log_closed"] = True
    class Video:
        def __init__(self, _udid, path, **_kwargs): self.path, self.process = path, object()
        def start(self): self.path.write_bytes(b"supplied fixture video"); return True
        def stop(self):
            state["recorder_closed"] = True
            return {"video_ready": True, "video_finalized": True, "video_alive_after_teardown": False, "video_forced_kill": False, "video_returncode": 0}
    calls = []
    def native(argv, **_kwargs):
        calls.append(argv)
        assert argv[:4] == ["xcrun", "simctl", "--set", device_set]
        args = argv[4:]
        if args[:4] == ["spawn", udid, "kill", "-ABRT"] or args[:4] == ["spawn", udid, "kill", "-TERM"]:
            assert args[-1] == "91"
            state["launched"] = False
            output = ""
        elif args[:2] == ["spawn", udid]:
            output = f"91 0 UIKitApplication:{bundle}[fixture]\n" if state["launched"] else ""
        elif args[0] == "launch":
            assert args[1:3] == [udid, bundle]
            state["launched"] = True
            output = bundle + ": 91\n"
        elif args[0] == "terminate":
            assert args[1:] == [udid, bundle]
            state["launched"] = False
            output = ""
        elif args[0] == "io":
            Path(argv[-1]).write_bytes(b"supplied screenshot")
            output = ""
        else: pytest.fail(f"unexpected native boundary: {argv}")
        return SimpleNamespace(returncode=0, stdout=output, stderr="")
    monkeypatch.setattr(runner, "LogStream", Logs)
    monkeypatch.setattr(runner, "VideoRecorder", Video)
    monkeypatch.setattr(runner.subprocess, "run", native)
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    config = {"PENTACLE_GATE_BOUND_SIMULATOR_UDID": udid, "PENTACLE_GATE_BOUND_BUNDLE_ID": bundle, "PENTACLE_SCENARIO_DEVICE_SET_ROOT": device_set, "scenario_run_id": "owned", "runtime_sentinel": sentinel}
    payload, proof = runner.execute_native("report_viewer_runtime_sentinel", config, tmp_path, "owned")
    assert payload["verdict"] == expected
    assert state == {"launched": False, "log_closed": True, "recorder_closed": True}
    assert proof == {"attempted": 1, "closed": [f"native:{udid}:91"], "closed_count": 1, "orphans": [], "orphan_count": 0}
    if armed_pid == "91":
        identity = payload["result"]["extras"]["runtime_monitor"]["process_identity"]
        assert identity["launch_pid"] == identity["armed_telemetry_pid"] == "91"
        assert any(argv[4] == "io" for argv in calls)
        if sentinel != "clean":
            assert any(argv[4:7] == ["spawn", udid, "kill"] for argv in calls)


@pytest.mark.parametrize("root", [None, "", "relative/device-set", "/synthetic/foreign/device-set"])
def test_native_dispatch_invalid_or_mismatched_private_set_never_starts(tmp_path, monkeypatch, root):
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", "/synthetic/private simulator set")
    def forbidden(*_args, **_kwargs):
        pytest.fail("invalid or foreign namespace must not start native resources")
    monkeypatch.setattr(runner, "LogStream", forbidden)
    monkeypatch.setattr(runner, "VideoRecorder", forbidden)
    monkeypatch.setattr(runner.subprocess, "run", forbidden)
    config = {"PENTACLE_GATE_BOUND_SIMULATOR_UDID": "12345678-1234-1234-1234-123456789abc",
              "PENTACLE_GATE_BOUND_BUNDLE_ID": "com.example.synthetic.harness",
              "PENTACLE_SCENARIO_DEVICE_SET_ROOT": root,
              "scenario_run_id": "owned", "runtime_sentinel": "clean"}
    with pytest.raises(ValueError, match="PENTACLE_SCENARIO_DEVICE_SET_ROOT"):
        runner.execute_native("report_viewer_runtime_sentinel", config, tmp_path, "owned")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("running_pid", ["91", "99"])
def test_native_dispatch_refuses_an_existing_foreign_or_reused_pid(tmp_path, monkeypatch, running_pid):
    device_set = "/synthetic/private simulator set"
    udid = "12345678-1234-1234-1234-123456789abc"
    bundle = "com.example.synthetic.harness"
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", device_set)
    calls = []
    def native(argv, **_kwargs):
        calls.append(argv)
        assert argv == ["xcrun", "simctl", "--set", device_set, "spawn", udid, "launchctl", "list"]
        return SimpleNamespace(returncode=0, stdout=f"{running_pid} 0 UIKitApplication:{bundle}[foreign-or-reused]\n", stderr="")
    def forbidden(*_args, **_kwargs):
        pytest.fail("an existing PID must not be adopted, signaled or started as a case")
    class DormantLogs:
        def __init__(self, *_args, **_kwargs): pass
        start = forbidden
        def close(self): pass
        def all_events(self): return []
    class DormantVideo:
        process = None
        def __init__(self, *_args, **_kwargs): pass
        start = forbidden
    monkeypatch.setattr(runner.subprocess, "run", native)
    monkeypatch.setattr(runner, "LogStream", DormantLogs)
    monkeypatch.setattr(runner, "VideoRecorder", DormantVideo)
    config = {"PENTACLE_GATE_BOUND_SIMULATOR_UDID": udid, "PENTACLE_GATE_BOUND_BUNDLE_ID": bundle,
              "PENTACLE_SCENARIO_DEVICE_SET_ROOT": device_set, "scenario_run_id": "owned", "runtime_sentinel": "clean"}
    payload, proof = runner.execute_native("report_viewer_runtime_sentinel", config, tmp_path, "foreign")
    assert payload["verdict"] == "SETUP_FAIL"
    assert payload["result"]["error"] == "bound harness bundle already has a running process"
    assert len(calls) == 1 and proof["attempted"] == 0 and proof["closed_count"] == 0
