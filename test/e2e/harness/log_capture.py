"""Owned native log stream. Parse telemetry while retaining the native PID envelope."""
from __future__ import annotations
import json
from pathlib import Path
import queue
import signal
import subprocess
import threading

from .telemetry_events import TelemetryEvent, parse_telemetry_line


class LogStream:
    def __init__(self, udid: str, raw_path: Path, *, bundle_id="com.example.pentacle.harness", popen=subprocess.Popen):
        self.udid, self.raw_path, self.popen = udid, raw_path, popen
        self.bundle_id = bundle_id
        self.events, self.lines = [], []
        self.pending = queue.Queue()
        self.process = None
        self.lock = threading.Lock()

    def feed_line(self, line):
        with self.lock:
            self.lines.append(line)
        try:
            envelope = json.loads(line)
        except (ValueError, TypeError):
            envelope = None
        message = envelope.get("eventMessage", "") if isinstance(envelope, dict) else line
        event = parse_telemetry_line(message)
        if event:
            pid = envelope.get("processID") if isinstance(envelope, dict) else None
            event.native_pid = str(pid) if isinstance(pid, int) and pid > 0 else None
            event.raw = line.rstrip("\n")
            with self.lock:
                self.events.append(event)
            self.pending.put(event)

    def start(self):
        self.output = self.raw_path.open("w", encoding="utf-8")
        predicate = 'process == "PentacleHarness" OR eventMessage CONTAINS ' + json.dumps(self.bundle_id)
        self.process = self.popen(["xcrun", "simctl", "spawn", self.udid, "log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", predicate],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        def consume():
            for line in self.process.stdout:
                self.output.write(line)
                self.output.flush()
                self.feed_line(line)
        self.reader = threading.Thread(target=consume, daemon=True)
        self.reader.start()
        return self

    def all_events(self):
        with self.lock:
            return list(self.events)

    def next_event(self, timeout_s=0):
        try:
            return self.pending.get(timeout=max(0, timeout_s))
        except queue.Empty:
            return None

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self.process:
            self.reader.join(timeout=2)
            if self.reader.is_alive() or self.process.poll() is None:
                raise RuntimeError("native log capture did not close")
        if hasattr(self, "output"):
            self.output.close()


__all__ = ["LogStream", "TelemetryEvent"]
