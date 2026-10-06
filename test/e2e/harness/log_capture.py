"""Owned native log stream. Parse telemetry while retaining the native PID envelope."""
from __future__ import annotations
import codecs
import json
import os
from pathlib import Path
import queue
import signal
import selectors
import subprocess
import threading

from . import scenario_simctl_command
from .telemetry_events import TelemetryEvent, parse_telemetry_line


class LogStream:
    def __init__(self, udid: str, raw_path: Path, *, bundle_id="com.example.pentacle.harness", popen=subprocess.Popen, config=None):
        self.udid, self.raw_path, self.popen = udid, raw_path, popen
        self.config = config
        self.bundle_id = bundle_id
        self.events, self.lines = [], []
        self.pending = queue.Queue()
        self.process = None
        self.lock = threading.Lock()
        self.reader_stop = threading.Event()
        self.reader_error = None

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
        predicate = 'process == "PentacleHarness" OR eventMessage CONTAINS ' + json.dumps(self.bundle_id)
        command = scenario_simctl_command("spawn", self.udid, "log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", predicate, config=self.config)
        self.output = self.raw_path.open("w", encoding="utf-8")
        self.process = self.popen(command,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        def consume():
            decoder = codecs.getincrementaldecoder("utf-8")()
            pending = ""
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(self.process.stdout, selectors.EVENT_READ)
                    while True:
                        if not selector.select(timeout=0 if self.reader_stop.is_set() else .1):
                            if self.reader_stop.is_set():
                                break
                            continue
                        chunk = os.read(self.process.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        text = decoder.decode(chunk)
                        self.output.write(text)
                        self.output.flush()
                        pending += text
                        while "\n" in pending:
                            line, pending = pending.split("\n", 1)
                            self.feed_line(line + "\n")
                tail = decoder.decode(b"", final=True)
                if tail:
                    self.output.write(tail)
                    self.output.flush()
                if pending or tail:
                    self.feed_line(pending + tail)
            except Exception as exc:
                self.reader_error = exc
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
        failures = []
        try:
            if self.process and self.process.poll() is None:
                self.process.send_signal(signal.SIGTERM)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
        except Exception as exc:
            failures.append(str(exc))
        finally:
            # A terminated simctl may leave another writer holding this pipe.
            # Stop our reader without waiting for that writer to produce EOF.
            self.reader_stop.set()
            if hasattr(self, "reader"):
                self.reader.join(timeout=2)
                if self.reader.is_alive() or self.process.poll() is None:
                    failures.append("native log capture did not close")
                else:
                    self.process.stdout.close()
            if hasattr(self, "output") and not (hasattr(self, "reader") and self.reader.is_alive()):
                self.output.close()
            if self.reader_error:
                failures.append(f"native log reader failed: {self.reader_error}")
        if failures:
            raise RuntimeError("; ".join(failures))


__all__ = ["LogStream", "TelemetryEvent"]
