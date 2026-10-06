"""Exercise the actual scroll scenario with retained native-shape input.

The optional evidence paths are test inputs only. The recorded pre-swipe
monotonic phase was not retained; replay uses a labelled post-hoc cutoff.
No simulator command or new native success is produced by these controls.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from types import SimpleNamespace

import pytest

from e2e.harness import asserts
from e2e.harness.log_capture import LogStream
from e2e.harness.telemetry_events import TelemetryEvent


@pytest.fixture
def scenario():
    source = os.environ.get("PENTACLE_HORIZONTAL_SCENARIO_TEST_SOURCE")
    if not source:
        from e2e.scenarios import report_viewer_horizontal_scroll
        return report_viewer_horizontal_scroll
    name = "e2e.scenarios.horizontal_recorded_control"
    loader = importlib.machinery.SourceFileLoader(name, source)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class Clock:
    def __init__(self, start):
        self.start = self.value = start

    def monotonic(self):
        return self.value

    def sleep(self, duration):
        self.value += duration

    def time(self):
        return time.time()


def event(row):
    parsed = TelemetryEvent(**{key: row[key] for key in
        ["subsystem", "message", "bug_ref", "data", "received_at", "raw"]})
    parsed.native_pid = row.get("native_process_id")
    return parsed


def inputs():
    result_path = os.environ.get("PENTACLE_HORIZONTAL_RECORDED_RESULT")
    ui_path = os.environ.get("PENTACLE_HORIZONTAL_RECORDED_UI")
    assert bool(result_path) == bool(ui_path), "recorded result and UI must be supplied together"
    if result_path:
        payload = json.loads(Path(result_path).read_text())
        selected = payload["result"]["extras"]["scrolled"]
        run_id = selected["data"]["scenario_run_id"]
        rows = [row for row in payload["all_events"] if row["message"] in
            ["harness:report_viewer_ready", "report:table_metrics", "report:table_scrolled"]]
        trace = [json.loads(line) for line in Path(ui_path).read_text().splitlines() if line.strip()]
        describe = next(row for row in trace if row["action"] == "describe-all")
        swipe = next(row for row in trace if row["action"] == "swipe")
        pid = payload["result"]["extras"]["runtime_monitor"]["process_identity"]["launch_pid"]
        assert all(row["native_process_id"] == pid for row in rows)
        return run_id, rows, selected["received_at"] - .001, describe, swipe
    # Portable CI cohort derived from the retained first two offset samples.
    run_id, start = "recorded-scroll-contract", 100.0
    def row(message, data, at):
        return {"subsystem": "report", "message": message, "bug_ref": "", "data": data,
                "received_at": at, "raw": "portable native-shape control", "native_process_id": "431"}
    where = {"scenario_run_id": run_id, "block_id": f"wide-matrix--{run_id}"}
    rows = [row("harness:report_viewer_ready", {"scenario_run_id": run_id}, 99),
            row("report:table_metrics", {**where, "content_width": 715, "viewport_width": 370}, 99.1),
            row("report:table_scrolled", {**where, "offset_x": 10.333333333333334}, 100.001),
            row("report:table_scrolled", {**where, "offset_x": 20.666666666666668}, 100.024416958)]
    tree = [{"AXUniqueId": f"report-table-scroll-wide-matrix--{run_id}",
             "frame": {"x": 16, "y": 120, "width": 370, "height": 80}}]
    return run_id, rows, start, {"returncode": 0, "stdout": json.dumps(tree), "stderr": ""}, {"returncode": 0, "stdout": "", "stderr": ""}


def actual_case(monkeypatch, scenario, *, variant=None, queued=False):
    run_id, rows, start, describe, swipe = inputs()
    ready = [row for row in rows if row["message"] != "report:table_scrolled"]
    scroll = [row for row in rows if row["message"] == "report:table_scrolled"]
    if variant == "subthreshold-only":
        scroll = [{**row, "data": {**row["data"], "offset_x": min(20, row["data"]["offset_x"])}} for row in scroll]
    elif variant == "stale":
        scroll = [{**row, "received_at": start - 1} for row in scroll]
    elif variant in ["wrong-run", "wrong-block"]:
        key = "scenario_run_id" if variant == "wrong-run" else "block_id"
        scroll = [{**row, "data": {**row["data"], key: "foreign", "offset_x": 30}} for row in scroll]
    elif variant == "deadline-exhaustion":
        scroll = [{**scroll[0], "received_at": start + 10.001,
                   "data": {**scroll[0]["data"], "offset_x": 30}}]
        queued = True
    clock = Clock(start)
    monkeypatch.setattr(scenario, "time", clock)
    monkeypatch.setattr(asserts, "time", clock)
    stream = LogStream("OWNED-RECORDED-UDID", Path("unused-no-native-start"))
    stream.events = [event(row) for row in ready + ([] if queued else scroll)]
    pending = [event(row) for row in scroll] if queued else []
    waits, commands = [], []
    def next_event(timeout_s=0):
        assert 0 < timeout_s <= .5
        waits.append(timeout_s)
        end = clock.value + timeout_s
        if pending and pending[0].received_at <= end:
            value = pending.pop(0)
            clock.value = max(clock.value, value.received_at)
            stream.events.append(value)
            return value
        clock.value = end
        return None
    stream.next_event = next_event
    def boundary(argv, **kwargs):
        commands.append(argv)
        if argv == ["idb", "ui", "describe-all", "--udid", "OWNED-RECORDED-UDID", "--json"]:
            return subprocess.CompletedProcess(argv, describe["returncode"], describe["stdout"], describe["stderr"])
        assert argv[:3] == ["idb", "ui", "swipe"]
        assert argv[-4:] == ["--duration", "0.5", "--udid", "OWNED-RECORDED-UDID"]
        assert kwargs["timeout"] == 20
        return subprocess.CompletedProcess(argv, swipe["returncode"], swipe["stdout"], swipe["stderr"])
    monkeypatch.setattr(subprocess, "run", boundary)
    screenshots = []
    verdict = scenario.run({"scenario_run_id": run_id, "SIMULATOR_UDID": "OWNED-RECORDED-UDID",
                            "trace": lambda *_: None}, stream, SimpleNamespace(screenshot=screenshots.append))
    assert len(commands) == 2 and screenshots == ["scrolled"]
    return verdict, clock, waits


def test_actual_recorded_scroll_sequence_selects_qualifying_offset(monkeypatch, scenario):
    verdict, _, _ = actual_case(monkeypatch, scenario)
    assert verdict.verdict == "PASS"
    assert verdict.extras["scrolled"]["data"]["offset_x"] > 20


def test_actual_queued_scroll_sequence_selects_qualifying_offset(monkeypatch, scenario):
    verdict, clock, waits = actual_case(monkeypatch, scenario, queued=True)
    assert verdict.verdict == "PASS"
    assert clock.value - clock.start < 10 and waits


@pytest.mark.parametrize("variant", ["subthreshold-only", "stale", "wrong-run", "wrong-block", "deadline-exhaustion"])
def test_actual_scroll_negatives_preserve_single_deadline(monkeypatch, scenario, variant):
    verdict, clock, waits = actual_case(monkeypatch, scenario, variant=variant)
    assert verdict.verdict == "FAIL" and verdict.extras["scrolled"] is None
    assert verdict.error == "native gesture did not scroll the report table"
    assert clock.value - clock.start == pytest.approx(10)
    assert waits and sum(waits) == pytest.approx(10)
