#!/usr/bin/env python3
"""Bound-simulator recorder ownership probe; no recorder or video is left behind."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time


class VideoRecorder:
    def __init__(self, udid: str, path: Path, *, popen=subprocess.Popen):
        self.udid, self.path, self.popen = udid, path, popen
        self.process = None
        self.stderr = []
        self.ready = threading.Event()
        self.started_at = self.ready_at = self.finished_at = None
        self.forced_kill = False
        self.stop_requested = False

    def _read(self):
        for line in self.process.stderr:
            self.stderr.append(line)
            if "Recording started" in line:
                self.ready_at = time.time()
                self.ready.set()

    def start(self):
        self.started_at = time.time()
        self.process = self.popen(
            ["xcrun", "simctl", "io", self.udid, "recordVideo", "--codec=h264", str(self.path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        deadline = time.monotonic() + 5
        while not self.ready.is_set() and time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.reader.join(timeout=0.1)
                break
            self.ready.wait(min(0.05, max(0, deadline - time.monotonic())))
        return self.ready.is_set() and self.process.poll() is None

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.stop_requested = True
                self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.forced_kill = True
                self.process.kill()
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            self.reader.join(timeout=0.1)
        finalized = False
        if self.stop_requested and self.ready.is_set() and self.process is not None and self.process.poll() == 0 and not self.forced_kill:
            deadline = time.monotonic() + 5
            while time.monotonic() <= deadline:
                if self.path.is_file() and self.path.stat().st_size > 0:
                    finalized = True
                    break
                time.sleep(0.05)
        self.finished_at = time.time()
        size = self.path.stat().st_size if finalized else 0
        reason = None if finalized else "".join(self.stderr).strip() or "recorder did not finalize a nonempty video"
        return {
            "video_mechanism": "simctl recordVideo", "frame_count": None,
            "video_ready": self.ready.is_set(), "video_started_at": self.started_at,
            "video_ready_at": self.ready_at,
            "video_ready_wait_s": (self.ready_at or self.finished_at) - self.started_at,
            "video_finished_at": self.finished_at,
            "video_returncode": self.process.poll() if self.process is not None else None,
            "video_finalized": finalized, "video_forced_kill": self.forced_kill,
            "video_alive_after_teardown": self.process is not None and self.process.poll() is None,
            "video_unavailable_reason": reason, "video_bytes": size,
            "video_sha256": hashlib.sha256(self.path.read_bytes()).hexdigest() if finalized else None,
        }


def probe(udid, phase, *, recorder_factory=VideoRecorder, sample_sleep=time.sleep):
    with tempfile.TemporaryDirectory(prefix="pentacle-recorder-probe-") as directory:
        video = Path(directory) / "probe.mp4"
        recorder = recorder_factory(udid, video)
        error = None
        ready = False
        try:
            ready = recorder.start()
            if ready:
                sample_sleep(0.5)
        except Exception as exc:
            error = str(exc)
        evidence = recorder.stop() if recorder.process is not None else {
            "video_started_at": recorder.started_at, "video_finished_at": time.time(),
            "video_ready": False, "video_returncode": None,
        }
        busy = evidence.get("video_returncode") == 16 and "Host recording is already in progress" in str(evidence.get("video_unavailable_reason"))
        passed = ready and evidence.get("video_finalized") is True and evidence.get("video_ready") is True and evidence.get("video_returncode") == 0 and evidence.get("video_alive_after_teardown") is False and evidence.get("video_forced_kill") is False and error is None
        evidence.update(phase=phase, contract_passed=passed, host_recording_busy=busy, video_retained=False)
        if error:
            evidence["probe_error"] = error
        video.unlink(missing_ok=True)
        return evidence


def preflight(udid: str, *, probe_fn=probe, command=subprocess.run):
    started = time.time()
    evidence = {"schema_version": 1, "simulator_udid": udid, "started_at": started,
                "setup_verdict": "SETUP_FAIL", "outcome": "failed", "stale_ownership_detected": False,
                "ownership_probes": [], "remediation": {"attempted": False, "attempts": 0, "status": "not_needed", "commands": []}}
    try:
        if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", udid):
            raise ValueError("an exact simulator UDID is required")
        bound = os.environ.get("PENTACLE_GATE_BOUND_SIMULATOR_UDID")
        if bound and bound != udid:
            raise ValueError("simulator identity differs from bound UDID")
        initial = probe_fn(udid, "initial")
        evidence["ownership_probes"].append(initial)
        if initial["contract_passed"]:
            evidence.update(setup_verdict="PASS", outcome="clear")
        elif initial["host_recording_busy"]:
            evidence["stale_ownership_detected"] = True
            remediation = evidence["remediation"]
            remediation.update(attempted=True, attempts=1, status="failed")
            for label, timeout, suffix in [("shutdown", 60, []), ("boot", 60, []), ("bootstatus", 120, ["-b"])]:
                before = time.time()
                result = command(["xcrun", "simctl", label, udid, *suffix], capture_output=True, text=True, timeout=timeout, check=False)
                after = time.time()
                remediation["commands"].append({"label": label, "started_at": before, "finished_at": after,
                    "duration_s": after - before, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
                if result.returncode != 0:
                    raise RuntimeError(f"recorder remediation {label} failed")
            remediation["status"] = "passed"
            retried = probe_fn(udid, "post_remediation")
            evidence["ownership_probes"].append(retried)
            if not retried["contract_passed"]:
                raise RuntimeError("recorder retry did not pass")
            evidence.update(setup_verdict="PASS", outcome="remediated")
        else:
            raise RuntimeError(initial.get("probe_error") or initial.get("video_unavailable_reason") or "recorder ownership probe failed")
    except Exception as exc:
        evidence["failure_reason"] = str(exc)
    evidence["finished_at"] = time.time()
    evidence["duration_s"] = evidence["finished_at"] - started
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udid", required=True)
    args = parser.parse_args(argv)
    evidence = preflight(args.udid)
    print(json.dumps(evidence))
    return 0 if evidence["setup_verdict"] == "PASS" else 4


if __name__ == "__main__":
    raise SystemExit(main())
