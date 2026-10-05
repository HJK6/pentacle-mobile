from __future__ import annotations
import io
from pathlib import Path
import signal
import subprocess
from types import SimpleNamespace

import pytest
import recorder_preflight as recorder

UDID = "12345678-1234-1234-1234-123456789abc"
DEVICE_SET = "/synthetic/private simulator set"


@pytest.fixture(autouse=True)
def private_device_set(monkeypatch):
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", DEVICE_SET)


class Process:
    def __init__(self, argv, *, mode="healthy", **_kwargs):
        self.argv, self.mode, self.signals = argv, mode, []
        self.path = Path(argv[-1])
        self.status = 16 if mode == "busy" else 1 if mode == "error" else 0 if mode == "early_exit" else None
        self.stderr = io.StringIO("Host recording is already in progress\n" if mode == "busy" else "generic recorder failure\n" if mode == "error" else "Recording started\n")
    def poll(self):
        return self.status
    def send_signal(self, value):
        self.signals.append(value)
        if self.mode not in {"stuck", "orphan"}:
            self.path.write_bytes(b"synthetic captured bytes")
            self.status = 0
    def wait(self, timeout):
        if self.status is None:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        return self.status
    def kill(self):
        self.signals.append(signal.SIGKILL)
        if self.mode != "orphan":
            self.status = -9


def factory(mode, owned):
    def create(udid, path):
        def popen(argv, **kwargs):
            process = Process(argv, mode=mode, **kwargs)
            owned.append(process)
            return process
        return recorder.VideoRecorder(udid, path, popen=popen)
    return create


def test_real_probe_boundary_binds_udid_gracefully_finalizes_and_removes_video():
    owned = []
    evidence = recorder.probe(UDID, "initial", recorder_factory=factory("healthy", owned), sample_sleep=lambda _: None)
    assert evidence["contract_passed"] is True
    assert evidence["video_finalized"] is True and evidence["video_bytes"] > 0
    assert len(evidence["video_sha256"]) == 64
    assert evidence["video_retained"] is False
    assert owned[0].argv[:7] == ["xcrun", "simctl", "--set", DEVICE_SET, "io", UDID, "recordVideo"]
    assert owned[0].signals == [signal.SIGINT]
    assert not owned[0].path.exists() and not owned[0].path.parent.exists()


def test_private_device_set_recorder_reproduces_certified_preflight_dispatch():
    """The fixture device exists only in the private set, as in the real gate."""
    owned = []
    def create(udid, path):
        def popen(argv, **kwargs):
            scoped = argv[:4] == ["xcrun", "simctl", "--set", DEVICE_SET]
            process = Process(argv, mode="healthy" if scoped else "error", **kwargs)
            if not scoped:
                process.status = 148
                process.stderr = io.StringIO(f"Invalid device: {UDID}\n")
            owned.append(process)
            return process
        return recorder.VideoRecorder(udid, path, popen=popen)
    evidence = recorder.probe(UDID, "initial", recorder_factory=create, sample_sleep=lambda _: None)
    assert evidence["contract_passed"] is True, evidence.get("video_unavailable_reason")
    assert evidence["video_finalized"] is True and evidence["video_alive_after_teardown"] is False
    assert owned[0].argv[:7] == ["xcrun", "simctl", "--set", DEVICE_SET, "io", UDID, "recordVideo"]
    assert owned[0].signals == [signal.SIGINT]
    assert not owned[0].path.exists()


@pytest.mark.parametrize("mode", ["error", "stuck", "orphan", "early_exit"])
def test_failed_forced_or_unreaped_recorders_never_pass(mode):
    owned = []
    evidence = recorder.probe(UDID, "initial", recorder_factory=factory(mode, owned), sample_sleep=lambda _: None)
    assert evidence["contract_passed"] is False
    assert evidence["host_recording_busy"] is False
    if mode in {"stuck", "orphan"}:
        assert evidence["video_forced_kill"] is True
        assert evidence["video_alive_after_teardown"] is (mode == "orphan")


def test_exact_busy_retries_once_and_commands_preserve_udid_and_timeouts():
    owned, calls, phases = [], [], []
    def probe(udid, phase):
        phases.append(phase)
        return recorder.probe(udid, phase, recorder_factory=factory("busy" if len(phases) == 1 else "healthy", owned), sample_sleep=lambda _: None)
    def command(argv, **kwargs):
        calls.append((argv, kwargs["timeout"]))
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")
    result = recorder.preflight(UDID, probe_fn=probe, command=command)
    assert result["setup_verdict"] == "PASS" and result["outcome"] == "remediated"
    assert phases == ["initial", "post_remediation"]
    assert all(argv[:4] == ["xcrun", "simctl", "--set", DEVICE_SET] for argv, _ in calls)
    assert [(argv[4], argv[5], timeout) for argv, timeout in calls] == [("shutdown", UDID, 60), ("boot", UDID, 60), ("bootstatus", UDID, 120)]
    assert calls[-1][0][-1] == "-b"


def test_busy_retry_is_bounded_and_generic_failure_does_not_remediate():
    for mode, expected_probes in [("busy", 2), ("error", 1)]:
        phases = []
        def probe(udid, phase):
            phases.append(phase)
            return recorder.probe(udid, phase, recorder_factory=factory(mode, []), sample_sleep=lambda _: None)
        result = recorder.preflight(UDID, probe_fn=probe, command=lambda *_a, **_k: SimpleNamespace(returncode=0, stdout="", stderr=""))
        assert result["setup_verdict"] == "SETUP_FAIL"
        assert len(phases) == expected_probes


def test_wrong_or_unbound_simulator_never_starts_a_probe(monkeypatch):
    def forbidden(*_args):
        pytest.fail("must reject before starting a recorder")
    assert recorder.preflight("booted", probe_fn=forbidden)["setup_verdict"] == "SETUP_FAIL"
    monkeypatch.setenv("PENTACLE_GATE_BOUND_SIMULATOR_UDID", "87654321-4321-4321-4321-cba987654321")
    assert recorder.preflight(UDID, probe_fn=forbidden)["setup_verdict"] == "SETUP_FAIL"


def test_remediation_timeout_fails_without_a_retry():
    def timed_out(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
    result = recorder.preflight(UDID, probe_fn=lambda udid, phase: recorder.probe(udid, phase, recorder_factory=factory("busy", [])), command=timed_out)
    assert result["setup_verdict"] == "SETUP_FAIL"
    assert len(result["ownership_probes"]) == 1


@pytest.mark.parametrize("root", [None, "", "relative/device-set"])
def test_recorder_missing_or_invalid_private_set_rejects_before_probe(monkeypatch, root):
    if root is None:
        monkeypatch.delenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", raising=False)
    else:
        monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", root)
    def forbidden(*_args, **_kwargs):
        pytest.fail("invalid namespace must not probe, remediate or guess a device set")
    result = recorder.preflight(UDID, probe_fn=forbidden, command=forbidden)
    assert result["setup_verdict"] == "SETUP_FAIL"
    assert "PENTACLE_SCENARIO_DEVICE_SET_ROOT" in result["failure_reason"]
    assert result["ownership_probes"] == [] and result["remediation"]["attempted"] is False
