"""Taps must land on what iOS hit-tests, not just on an on-screen frame (spec Amendment 2).

`fixtures/member-sheet-scrolled-ax.json` is the native accessibility dump captured when `run_b_member_detail` failed
(SHA256 d55553d1… before transfer), with only the `pid` fields removed. The same window's screenshot shows the map
focus sheet's visible top at about 517 pt: its rows above that are scrolled out of the sheet's ScrollView, while the
tree still lists them at their scrolled frames over the map.
"""
import copy
import json
import subprocess
from pathlib import Path

import pytest
import run

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "member-sheet-scrolled-ax.json"
SHEET_TOP = 517  # visible top of the member sheet in the captured screenshot (points)
ROW = "lane-members-row-spec_example__span_01"


class Sheet:
    """Two-state model of the captured screen: rows scroll with drags that start inside the sheet; a point above the
    sheet top hit-tests to the map, never to a clipped row."""

    def __init__(self, tmp_path, monkeypatch, hit_ok=True):
        self.elements = copy.deepcopy(json.loads(FIXTURE.read_text(encoding="utf-8")))
        self.taps, self.swipes, self.hits = [], [], []
        ui = run.Ui("SIM", "idb", lambda *_a: None, tmp_path, "com.example.pentacle")
        ui.elements = lambda: self.elements
        ui.read_foreground = lambda: "com.example.pentacle"
        ui._idb = self.idb
        self.hit_ok = hit_ok
        monkeypatch.setattr(run.time, "sleep", lambda _: None)
        self.ui = ui

    def rows(self):
        return [e for e in self.elements if run.Ui.ident(e).startswith("lane-members-row-")]

    def at(self, x, y):
        if y < SHEET_TOP:
            return {"AXUniqueId": None, "AXLabel": "Pentacle", "type": "Application"}
        for e in self.rows():
            f = e["frame"]
            if f["x"] <= x <= f["x"] + f["width"] and f["y"] <= y <= f["y"] + f["height"]:
                return e
        return {"AXUniqueId": None, "AXLabel": "Pentacle", "type": "Application"}

    def idb(self, *args):
        if args[:2] == ("ui", "tap"):
            self.taps.append((float(args[2]), float(args[3])))
        elif args[:2] == ("ui", "swipe"):
            x1, y1, x2, y2 = map(float, args[2:6])
            self.swipes.append((x1, y1, x2, y2))
            if y1 >= SHEET_TOP:
                for e in self.rows():
                    e["frame"]["y"] += y2 - y1
        elif args[:2] == ("ui", "describe-point"):
            if not self.hit_ok:
                return subprocess.CompletedProcess(args, 1, "", "describe-point failed")
            x, y = float(args[-2]), float(args[-1])
            self.hits.append((x, y))
            return subprocess.CompletedProcess(args, 0, json.dumps(self.at(x, y)), "")
        return subprocess.CompletedProcess(args, 0, "", "")


def test_clipped_sheet_row_is_scrolled_into_the_sheet_before_the_tap(tmp_path, monkeypatch):
    sheet = Sheet(tmp_path, monkeypatch)
    sheet.ui.tap(ROW)
    assert len(sheet.taps) == 1
    x, y = sheet.taps[0]
    assert y >= SHEET_TOP, f"tap at y={y} lands above the sheet, on the map"
    assert run.Ui.ident(sheet.at(x, y)) == ROW
    assert sheet.swipes and all(s[1] >= SHEET_TOP for s in sheet.swipes)  # drags start inside the sheet


def test_hit_testable_target_is_tapped_without_dragging(tmp_path, monkeypatch):
    sheet = Sheet(tmp_path, monkeypatch)
    target = "lane-members-row-spec_example__span_06"
    sheet.ui.tap(target)
    assert sheet.swipes == [] and len(sheet.taps) == 1
    assert run.Ui.ident(sheet.at(*sheet.taps[0])) == target


def test_clipped_target_without_a_visible_sibling_fails_closed(tmp_path, monkeypatch):
    sheet = Sheet(tmp_path, monkeypatch)
    sheet.elements = [e for e in sheet.elements
                      if not run.Ui.ident(e).startswith("lane-members-row-") or run.Ui.ident(e) == ROW]
    with pytest.raises(run.SetupFail):
        sheet.ui.tap(ROW)
    assert sheet.taps == []


def test_unreadable_hit_test_fails_closed(tmp_path, monkeypatch):
    sheet = Sheet(tmp_path, monkeypatch, hit_ok=False)
    with pytest.raises(run.SetupFail):
        sheet.ui.tap("lane-members-row-spec_example__span_06")
    assert sheet.taps == []


def test_hit_test_is_traced(tmp_path, monkeypatch):
    events = []
    sheet = Sheet(tmp_path, monkeypatch)
    sheet.ui.trace = lambda name, data: events.append((name, data))
    sheet.ui.tap(ROW)
    hits = [data for name, data in events if name == "hit_test"]
    assert hits and hits[0]["target"] == ROW and hits[0]["hit"] != ROW and hits[-1]["hit"] == ROW
