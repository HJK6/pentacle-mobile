"""Compact list oracle, fresh daemon-order bracket and wire-evidence scrub (spec Amendment 1).

`fixtures/compact-list-ax.json` is the native accessibility dump captured at a contained window's open_lanes stop
(SHA256 ca1cd3fc… before transfer), with only the `pid` fields removed.
"""
import json
from pathlib import Path

import pytest
import run
import scratch_daemon as sd

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "compact-list-ax.json"
# Screen order of the captured list, and the stale probe_a order of the same window (two paused lanes swapped).
SCREEN = ["wl-4abf858209848e516dccde25", "wl-298430ea76b6dc262400bbec", "wl-511eb3bab0824f4a8f2babe9",
          "wl-52686f01256982fe40b17600", "wl-8169db2a19a3137b68cebda9"]
STALE = [SCREEN[0], SCREEN[1], SCREEN[3], SCREEN[2], SCREEN[4]]


def card(prefix, lane, y):
    return {"AXUniqueId": prefix + lane, "type": "Button", "frame": {"x": 10, "y": y, "width": 300, "height": 40}}


def list_screen(order):
    rows = []
    for i, lane in enumerate(order):
        rows.append(card(run.LIST_CARD, lane, 100 + 60 * i))
        rows.append({"AXUniqueId": "lane-card-members-pending-" + lane, "type": "StaticText",
                     "frame": {"x": 10, "y": 130 + 60 * i, "width": 300, "height": 20}})
    return rows


def lanes(order, state="paused"):
    return [{"lane_id": lane, "state": state} for lane in order]


def make_run(tmp_path, monkeypatch, screens, inventories):
    """A Run whose probes return `inventories` in turn; attempt k's screen read sees `screens[k]`."""
    state = {"probes": 0}
    r = run.Run.__new__(run.Run)
    r.result = {"checks": {}}
    r.ui = run.Ui("SIM", "idb", lambda *_a: None, tmp_path, "com.example.pentacle")
    r.ui.elements = lambda: screens[min(max((state["probes"] + 1) // 2 - 1, 0), len(screens) - 1)]
    r.ui.screenshot = lambda *_a: "shot"
    plan = iter(inventories)

    def probe(lane_id=None):
        state["probes"] += 1
        return {"inventory": {"lanes": next(plan)}, "show": None}
    r.probe = probe
    monkeypatch.setattr(run.time, "sleep", lambda _: None)
    return r, state


# The captured compact-list fixture documents the retired screen; the new grouped
# list is tested with synthetic accessibility rows until native capture exists.

def test_grouped_lane_order_uses_classes_and_preserves_order_within_a_group():
    rows = [
        {"lane_id": "paused", "state": "paused"},
        {"lane_id": "idle", "state": "active"},
        {"lane_id": "stalled", "state": "active", "goal_classes": "b-", "goal_counts": [0, 1, 0, 0]},
        {"lane_id": "moving", "state": "active", "goal_classes": "m-", "goal_counts": [1, 0, 0, 0]},
        {"lane_id": "legacy", "state": "active", "goals": [{"total": 2, "state": "in_progress"}]},
    ]
    assert run.grouped_lane_ids(rows) == ["moving", "legacy", "stalled", "idle", "paused"]


def test_list_bracket_uses_fresh_agreed_grouped_order(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(SCREEN)], [lanes(SCREEN), lanes(SCREEN)])
    r.run_a_list()
    assert r.result["checks"]["run_a_list"]["visible_lanes"] == SCREEN and state["probes"] == 2


def test_list_bracket_retries_changed_inventory_and_rejects_wrong_order(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(SCREEN)] * 2,
                        [lanes(STALE), lanes(SCREEN), lanes(SCREEN), lanes(SCREEN)])
    r.run_a_list()
    assert state["probes"] == 4
    r, state = make_run(tmp_path, monkeypatch, [list_screen(STALE)], [lanes(SCREEN)] * 6)
    with pytest.raises(run.AssertFail):
        r.run_a_list()
    assert state["probes"] == 6


def test_overflow_list_must_equal_agreed_grouped_order(tmp_path, monkeypatch):
    expected = sd.all_lane_ids() + sd.overflow_lane_ids()
    r, _ = make_run(tmp_path, monkeypatch, [[]], [lanes(expected)] * 6)
    r.result["overflow_phase"] = {"inventory_ids": expected}
    r.ui.collect_scrolling = lambda prefix, limit, max_swipes=12: [prefix + x for x in expected[1:] + expected[:1]]
    with pytest.raises(run.AssertFail):
        r.overflow_assert()
    r, _ = make_run(tmp_path, monkeypatch, [[]], [lanes(expected)] * 2)
    r.result["overflow_phase"] = {"inventory_ids": expected}
    r.ui.collect_scrolling = lambda prefix, limit, max_swipes=12: [prefix + x for x in expected]
    r.overflow_assert()
    assert r.result["overflow_phase"]["observed_ids"] == expected


# -- (j) wire evidence never keeps an enrollment code ---------------------------------------------------------

def test_hash_evidence_redacts_enrollment_codes_and_reports_truthfully(tmp_path):
    r = run.Run.__new__(run.Run)
    r.run_dir, r.evidence, r.scratch = tmp_path, tmp_path / "evidence", tmp_path / "absent-scratch"
    r.evidence.mkdir()
    (tmp_path / "proxy").mkdir()
    rows = [{"type": "welcome"}, {"type": "enroll", "code": "SYNTHETIC1"}, {"type": "error", "error_code": "x"}]
    (tmp_path / "proxy" / "throttle-wire.jsonl").write_text("".join(json.dumps(x) + "\n" for x in rows))
    r.result = {"enrollment": {"code_retained": False}}
    r.hash_evidence()
    for path in (tmp_path / "proxy" / "throttle-wire.jsonl", r.evidence / "throttle-wire.jsonl"):
        text = path.read_text()
        assert "SYNTHETIC1" not in text and '"<redacted>"' in text and '"error_code": "x"' in text
    assert r.result["wire_code_scan"] == {"rows_redacted": 1, "remaining": 0}
    assert r.result["enrollment"]["code_retained"] is False


# -- (k) proxy pin ----------------------------------------------------------------------------------------------

def test_runner_pins_the_code_free_proxy(tmp_path):
    assert sd.PROXY_SHA256 == "a702817e0cfe2210221f9da1f2c931853f7fb8bb0cd5ecf2460933f88d84b89c"
    assert any("enrollment codes" in str(value) for value in sd.PROXY_DELTAS.values())
    old = tmp_path / "throttle-proxy.py"
    old.write_text("# not the reviewed proxy\n")
    with pytest.raises(ValueError):
        sd.copy_proxy(old, tmp_path / "run")
