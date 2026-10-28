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


# -- (f) captured compact list --------------------------------------------------------------------------------

def test_captured_compact_list_renders_every_lane(tmp_path, monkeypatch):
    elements = json.loads(FIXTURE.read_text(encoding="utf-8"))
    r = run.Run.__new__(run.Run)
    r.ui = run.Ui("SIM", "idb", lambda *_a: None, tmp_path, "com.example.pentacle")
    r.ui.elements = lambda: elements
    r.ui.tap = lambda *_a, **_k: None
    clock = iter(range(0, 10_000, 5))
    monkeypatch.setattr(run.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(run.time, "sleep", lambda _: None)
    r.show_view("list")
    visible = r.visible_order(run.LIST_CARD)
    assert visible == SCREEN
    assert sorted(visible) == sorted(sd.v1_lane_ids())
    assert not any(run.Ui.ident(e).startswith("lane-card-log-") for e in elements)


# -- (i) list bracket -----------------------------------------------------------------------------------------

def test_run_a_list_compares_with_fresh_daemon_order_not_stale_snapshot(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(SCREEN)], [lanes(SCREEN), lanes(SCREEN)])
    r.inventory_order = STALE  # the window's probe_a snapshot
    r.run_a_list()
    assert r.result["checks"]["run_a_list"]["visible_lanes"] == SCREEN and state["probes"] == 2


def test_list_bracket_rereads_when_probes_disagree(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(SCREEN)] * 2,
                        [lanes(STALE), lanes(SCREEN), lanes(SCREEN), lanes(SCREEN)])
    r.inventory_order = STALE
    r.run_a_list()
    assert state["probes"] == 4 and len(r.result["checks"]["order_brackets"]["run A list"]) == 2


def test_list_bracket_rereads_a_lagging_screen(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(STALE), list_screen(SCREEN)],
                        [lanes(SCREEN)] * 4)
    r.inventory_order = STALE
    r.run_a_list()
    assert state["probes"] == 4


def test_list_bracket_fails_closed_when_probes_never_agree(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(SCREEN)], [lanes(STALE), lanes(SCREEN)] * 3)
    r.inventory_order = SCREEN
    with pytest.raises(run.AssertFail):
        r.run_a_list()
    assert state["probes"] == 6 and len(r.result["checks"]["order_brackets"]["run A list"]) == 3


def test_list_bracket_rejects_correct_set_in_wrong_order(tmp_path, monkeypatch):
    r, state = make_run(tmp_path, monkeypatch, [list_screen(STALE)], [lanes(SCREEN)] * 6)
    r.inventory_order = STALE  # even the stale snapshot cannot rescue a screen that differs from the daemon now
    with pytest.raises(run.AssertFail):
        r.run_a_list()
    assert state["probes"] == 6


# -- (i) map attention bracket --------------------------------------------------------------------------------

def map_run(tmp_path, monkeypatch, rings, inventories):
    ids = sd.all_lane_ids()
    nodes = [card("lanes-map-lane-", lane, 100 + 10 * i) for i, lane in enumerate(ids)]
    nodes.append({"AXUniqueId": "lanes-map-assistant", "type": "Button",
                  "frame": {"x": 150, "y": 400, "width": 60, "height": 60}})
    r, state = make_run(tmp_path, monkeypatch, [nodes], inventories)
    r.show_view = lambda _v: None
    r.focus_lane = lambda _lane: None
    r.unfocus_to_page_one = lambda: None
    order = iter(rings)
    monkeypatch.setattr(run, "two_ring_order", lambda _e, _c: next(order))
    return r, state


def test_map_attention_order_uses_fresh_agreed_probes(tmp_path, monkeypatch):
    fresh = sd.all_lane_ids()
    stale = fresh[1:2] + fresh[:1] + fresh[2:]
    inventory = lanes(fresh[:1], "blocked") + lanes(fresh[1:])
    r, state = map_run(tmp_path, monkeypatch, [fresh], [inventory, inventory])
    r.attention_order = stale  # probe_b snapshot taken before updated_at moved
    r.run_b_map_pages()
    assert r.result["checks"]["run_b_map_pages"]["lanes"] == fresh and state["probes"] == 2


def test_map_attention_order_applies_rank_to_agreed_order(tmp_path, monkeypatch):
    ids = sd.all_lane_ids()
    inventory = lanes(ids[:3]) + lanes(ids[3:4], "blocked") + lanes(ids[4:])
    ranked = ids[3:4] + ids[:3] + ids[4:]
    r, _state = map_run(tmp_path, monkeypatch, [ids] * 3, [inventory] * 6)
    r.attention_order = ids
    with pytest.raises(run.AssertFail):
        r.run_b_map_pages()
    r, _state = map_run(tmp_path, monkeypatch, [ranked], [inventory] * 2)
    r.attention_order = ids
    r.run_b_map_pages()


# -- (i) overflow list order ----------------------------------------------------------------------------------

def overflow_run(tmp_path, monkeypatch, observed, inventories):
    expected = sd.all_lane_ids() + sd.overflow_lane_ids()
    nodes = [card("lanes-map-lane-", f"wl-{i:024x}", 10 * i) for i in range(16)]
    r, state = make_run(tmp_path, monkeypatch, [nodes], inventories)
    r.result["overflow_phase"] = {"inventory_ids": sorted(expected)}
    r.ui.dump = lambda *_a: Path(tmp_path) / "dump"
    r.ui.tap_element = lambda *_a, **_k: None
    r.ui.find = lambda *_a, **_k: {}
    r.show_view = lambda _v: None
    reads = iter(observed)
    r.ui.collect_scrolling = lambda prefix, limit, max_swipes=12: [run.LIST_CARD + x for x in next(reads)]
    monkeypatch.setattr(run, "overflow_control", lambda _e, _n: {"AXLabel": "Show all lanes"})
    return r, state, expected


def test_overflow_list_must_equal_agreed_daemon_order(tmp_path, monkeypatch):
    expected = sd.all_lane_ids() + sd.overflow_lane_ids()
    shuffled = expected[1:] + expected[:1]
    r, state, _ = overflow_run(tmp_path, monkeypatch, [shuffled] * 3, [lanes(expected)] * 6)
    with pytest.raises(run.AssertFail):
        r.overflow_assert()
    r, state, _ = overflow_run(tmp_path, monkeypatch, [expected], [lanes(expected)] * 2)
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
