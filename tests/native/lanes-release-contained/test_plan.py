"""Host-only checks of the `lanes-release-contained` plan.

No simulator, no daemon, no network: these exercise the pure parts of the
runner (plan order, containment env, daemon argv, compiled-config scan, wire
pairing, v1/increment-1 oracles on the shared fixture, owned-process and
scratch-removal guards).

    python3 -m pytest tests/native/lanes-release-contained/test_plan.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))

import run  # noqa: E402
import scratch_daemon as sd  # noqa: E402
import v1_daemon as v1  # noqa: E402


def test_plan_runs_a_then_c_then_b_with_owned_teardown_last():
    plan = run.plan()
    steps = plan["steps"]
    order = [steps.index(name) for name in ("admission", "probe_a", "app_launch", "enroll", "run_a_list", "run_a_log",
                                            "daemon_a_stop", "seed_inc1_upgrade", "daemon_b_start", "run_c_reconnect",
                                            "run_b_all_members", "run_b_log", "run_b_final")]
    assert order == sorted(order)
    assert steps.count("app_launch") == 1  # one cold launch; C reconnects the same process
    assert plan["teardown"][-2:] == ["evidence_hash", "scratch_remove"]
    assert plan["ports"] == {"daemon": 17893, "proxy": 17896, "companion": 10883, "metro_must_be_closed": 8081}
    assert plan["app_ws_url"] == "ws://127.0.0.1:17896"
    assert plan["proof_build"] == "normal_release_loopback_counterpart"
    assert plan["pins"] == {"v1": "3dc10e240a163ca4a36a0886326af0b2da09f595",
                            "inc1": "56ca05bc27fac2faf7cf369974cad785ca4129be"}


def test_plan_command_prints_json(capsys):
    assert run.main(["plan"]) == 0
    assert json.loads(capsys.readouterr().out)["scenario"] == "lanes-release-contained"


def test_lane_plan_is_stable_and_bounded():
    ids = sd.all_lane_ids()
    assert len(ids) == len(set(ids)) == 9
    assert all(re.fullmatch(r"wl-[0-9a-f]{24}", lane) for lane in ids)
    assert sd.v1_lane_ids() == ids[:5]
    assert sd.lane_id_for(sd.LANES[0]["key"]) == "wl-" + hashlib.sha256(
        ("local:web-gate-assistant\x00" + sd.LANES[0]["key"]).encode()).hexdigest()[:24]
    assert sd.LANES[0]["members"] == sd.BIG and len(sd.BIG) == 32 and len(set(sd.BIG)) == 32
    assert all(len(lane["members"]) <= 32 for lane in sd.LANES)
    nospec = [lane for lane in sd.LANES if not lane["members"]]
    assert len(nospec) == 1 and nospec[0]["no_spec_reason"]
    assert any(lane["state"] == "paused" and not lane["lead"] for lane in sd.LANES if lane["v1"])
    assert any(lane["state"] == "blocked" and lane.get("blocker") for lane in sd.LANES if lane["v1"])


def test_memory_tree_has_missing_ambiguous_and_editable_items(tmp_path):
    facts = sd.write_memory(tmp_path)
    declared: dict[str, int] = {}
    for spec in tmp_path.rglob("spec.md"):
        match = re.search(r"^id: (\S+)$", spec.read_text(), re.M)
        declared[match[1]] = declared.get(match[1], 0) + 1
    assert facts["missing"] not in declared
    assert declared[facts["ambiguous"]] == 2
    members = {member for lane in sd.LANES for member in lane["members"]}
    assert members - set(declared) == {sd.MISSING}
    assert sd.tick_edited_spec(tmp_path) == sd.EDITED
    with pytest.raises(ValueError):
        sd.tick_edited_spec(tmp_path)  # one edit only
    parked = sd.hide_memory_root(tmp_path / "work")
    assert parked.is_dir() and not (tmp_path / "work").exists()
    sd.restore_memory_root(tmp_path / "work")
    assert (tmp_path / "work").is_dir()


def test_child_env_is_contained_and_audio_backend_off(tmp_path):
    inherited = {"PATH": "/usr/bin", "LANG": "C.UTF-8", "HOME": "/home/someone", "MIC_API": "http://127.0.0.1:7780",
                 "AGENT_ORCH_STREAM_ID": "x", "PENTACLE_ASSISTANT_COMPOSITE_ENABLED": "1", "AWS_PROFILE": "p",
                 "PENTACLE_MEMORY_ROOT": "/shared/memory", "EXPO_PUBLIC_PENTACLE_WS_URL": "ws://example"}
    env = sd.child_env(tmp_path / "scratch", inherited)
    assert "MIC_API" in env and env["MIC_API"] == ""
    assert env["PENTACLE_MEMORY_ROOT"] == str(tmp_path / "scratch" / "memory")
    assert env["PENTACLE_RUNTIME_DIR"] == str(tmp_path / "scratch" / "runtime")
    assert env["PENTACLE_HOST_ID"] == "local" and env["PENTACLE_ASSISTANT_AUTO_RESTORE"] == "0"
    assert "HOME" not in env
    assert not [key for key in env if key.startswith(("AGENT_ORCH_", "AWS_", "EXPO_"))]
    assert [key for key in env if key.startswith("PENTACLE_ASSISTANT_")] == ["PENTACLE_ASSISTANT_AUTO_RESTORE"]
    assert env["WORK_INDEX_SWEEP_S"] == "5" and env["WORK_INDEX_SETTLE_S"] == "5"


@pytest.mark.parametrize("mutate, message", [
    (lambda env: env.pop("MIC_API"), "MIC_API"),
    (lambda env: env.update(MIC_API="http://127.0.0.1:17894"), "MIC_API"),
    (lambda env: env.pop("PENTACLE_MEMORY_ROOT"), "PENTACLE_MEMORY_ROOT"),
    (lambda env: env.update(PENTACLE_MEMORY_ROOT="/elsewhere/memory"), "PENTACLE_MEMORY_ROOT"),
    (lambda env: env.update(HOME="/home/someone"), "HOME"),
    (lambda env: env.update(AGENT_ORCH_TOKEN="x"), "AGENT_ORCH_TOKEN"),
    (lambda env: env.update(PENTACLE_ASSISTANT_DIRECT_PRIMARY_STREAM_ID="x"), "PENTACLE_ASSISTANT_DIRECT"),
])
def test_containment_rejects_each_escape(tmp_path, mutate, message):
    env = sd.child_env(tmp_path / "scratch", {"PATH": "/usr/bin"})
    mutate(env)
    with pytest.raises(ValueError, match=message):
        sd.assert_containment(env, tmp_path / "scratch")


def test_daemon_argv_is_the_reviewed_isolated_command(tmp_path):
    scratch, checkout = tmp_path / "scratch", tmp_path / "checkout"
    argv = sd.daemon_argv("/venv/bin/python3.13", checkout, scratch)
    assert argv[:3] == ["/venv/bin/python3.13", str(checkout / "test/e2e/lib/web_gate_daemon.py"), str(scratch)]
    assert argv[3:] == [
        "--host", "127.0.0.1", "--port", "17893", "--local-host", "local",
        "--db", str(scratch / "sessions.db"), "--notifications-db", str(scratch / "notifications.db"),
        "--assets-db", str(scratch / "assets.db"), "--blob-root", str(scratch / "blobs"),
        "--tmux-bin", "/usr/bin/false", "--ssh-bin", "/usr/bin/false",
        "--claude-bin", "/usr/bin/false", "--codex-bin", "/usr/bin/false",
        "--disable-mirror", "--disable-ingest", "--disable-hosts", "--disable-reconciler",
        "--disable-retention", "--disable-nudges", "--disable-notification-expiry",
        "--disable-remote-presence", "--disable-event-push-ingest", "--disable-routing-integrity",
        "--disable-outbound-notices", "--disable-awaiter-resolution", "--disable-window-schedule",
        "--disable-usage-state-publisher"]
    assert all(str(path).startswith(str(scratch)) for path in argv[10:17:2])


PROD = {"extra": {"wsUrl": "wss://control.example.net:7791", "dashboardHubUrl": "https://hub.example.net/x",
                  "hosts": [{"url": "https://host-a.example.net"}]},
        "ios": {"url": "https://attribution.example.org"}}


def _app_config(ws=sd.APP_WS_URL, **extra):
    return {"extra": {"wsUrl": ws, **extra}}


def test_operational_urls_only_from_extra():
    assert run.operational_urls(PROD) == ["https://host-a.example.net", "https://hub.example.net/x",
                                          "wss://control.example.net:7791"]


def test_compiled_scan_passes_loopback_only():
    bundle = b"\x00hermes " + sd.APP_WS_URL.encode() + b" https://docs.example.org/attribution"
    result = run.scan_compiled(bundle, _app_config(), run.operational_urls(PROD))
    assert result["problems"] == []
    assert result["production_urls_checked"] == 3


@pytest.mark.parametrize("bundle, config, fragment", [
    (b"ws://127.0.0.1:17896 wss://control.example.net:7791", _app_config(), "non-loopback socket"),
    (b"ws://127.0.0.1:17896 control.example.net", _app_config(), "production operational"),
    (b"ws://127.0.0.1:17896", _app_config(ws="ws://127.0.0.1:7791"), "extra.wsUrl"),
    (b"nothing", _app_config(), "does not contain the owned loopback"),
    (b"ws://127.0.0.1:17896", _app_config(hub="https://hub.example.net/x"), "production operational"),
    (b"ws://127.0.0.1:17896", _app_config(dashboardHubUrl="https://unowned.example.org"), "non-loopback operational"),
    (b"ws://127.0.0.1:17896", _app_config(hosts=[{"url": "http://198.51.100.7:7795"}]), "non-loopback operational"),
])
def test_compiled_scan_rejects_escapes(bundle, config, fragment):
    problems = run.scan_compiled(bundle, config, run.operational_urls(PROD))["problems"]
    assert any(fragment in problem for problem in problems), problems


def test_show_pairs_match_request_ids_after_the_tap():
    t = time.time()
    rows = [
        {"at": t - 5, "direction": "client_to_daemon", "type": "work_lanes.show", "request_id": "old", "connection": 1},
        {"at": t + 1, "direction": "client_to_daemon", "type": "work_lanes.show", "request_id": "r1", "connection": 2, "bytes": 90},
        {"at": t + 2, "direction": "daemon_to_client", "type": "work_lanes.show.ok", "request_id": "r1", "connection": 2, "bytes": 9000},
        {"at": t + 3, "direction": "client_to_daemon", "type": "work_lanes.show", "request_id": "r2", "connection": 2},
        {"at": t + 3, "direction": "daemon_to_client", "type": "snapshot", "connection": 2},
    ]
    pairs = run.show_pairs(rows, t)
    assert [(p["request_id"], p["reply_type"]) for p in pairs] == [("r1", "work_lanes.show.ok"), ("r2", None)]
    assert run.connections_with_snapshot(rows, t) == [2]
    assert run.connections_with_snapshot(rows, t + 4) == []


def _fixture():
    return json.loads((REPO / sd.FIXTURE_PATH).read_text(encoding="utf-8"))


def test_v1_oracle_accepts_the_shared_v1_inventory_frame():
    frame = _fixture()["inventory_frame"]
    ids = [lane["lane_id"] for lane in frame["lanes"]]
    assert v1.check_v1_inventory(frame, ids) == []
    assert v1.check_v1_inventory(frame, ids[:-1])  # wrong seed set is caught


def test_v1_oracle_rejects_increment_one_fields():
    frame = json.loads(json.dumps(_fixture()["inventory_frame"]))
    frame["lanes"][0]["members_total"] = 3
    frame["work_index"] = {"available": True}
    problems = v1.check_v1_inventory(frame, [lane["lane_id"] for lane in frame["lanes"]])
    assert any("increment-1 keys" in p for p in problems) and any("work_index" in p for p in problems)


def test_increment_one_fixture_frames_fail_the_v1_oracle_when_present():
    fixture = _fixture()
    if hashlib.sha256((REPO / sd.FIXTURE_PATH).read_bytes()).hexdigest() != sd.FIXTURE_SHA256:
        pytest.skip("vendored fixture is not yet the shared increment-1 file (byte copy lands with the client change)")
    for case in fixture["progress_v2"]:
        frame = case["frame"]
        assert v1.check_v1_inventory(frame, [lane["lane_id"] for lane in frame["lanes"]]), case["name"]
        assert not (v1._keys(frame) & {"completion_pending", "lead_reported_done", "stale"}), case["name"]


def test_show_oracles():
    lane = sd.big_lane_id()
    ok = {"type": "work_lanes.show.ok", "lane": {"lane_id": lane}, "projection": {}, "events": [], "updates": []}
    assert v1.check_v1_show(ok, lane) == []
    assert v1.check_v1_show({**ok, "members": []}, lane)
    assert v1.check_v1_show({"type": "work_lanes.show.error"}, lane)
    members = [{"spec_id": spec} for spec in sd.BIG]
    assert v1.check_inc1_show({**ok, "members": members}, lane, sd.BIG) == []
    assert v1.check_inc1_show({**ok, "members": members[::-1]}, lane, sd.BIG)


def test_inc1_inventory_oracle_requires_inline_eight_of_thirty_two():
    big = sd.big_lane_id()
    lanes = [{"lane_id": lane} for lane in sd.all_lane_ids()]
    lanes[0].update(members=[{"spec_id": s} for s in sd.BIG[:8]], members_total=32)
    frame = {"type": "work_lanes.inventory", "lanes": lanes, "work_index": {"available": True}}
    assert v1.check_inc1_inventory(frame, sd.all_lane_ids(), big) == []
    lanes[0]["members"] = [{"spec_id": s} for s in sd.BIG]
    assert v1.check_inc1_inventory(frame, sd.all_lane_ids(), big)


def test_target_and_overlap_guards():
    big = {"AXIdentifier": "a", "frame": {"x": 0, "y": 0, "width": 44, "height": 44}}
    small = {"AXIdentifier": "b", "frame": {"x": 100, "y": 0, "width": 30, "height": 30}}
    run.assert_target(big, {"width": 375, "height": 812})
    with pytest.raises(run.AssertFail):
        run.assert_target(small)
    with pytest.raises(run.AssertFail):
        run.assert_target({"AXIdentifier": "c", "frame": {"x": 360, "y": 0, "width": 44, "height": 44}},
                          {"width": 375, "height": 812})
    assert run.overlapping([big, small]) == []
    assert run.overlapping([big, {"AXIdentifier": "d", "frame": {"x": 20, "y": 20, "width": 44, "height": 44}}]) == [("a", "d")]


class _FakeMapUi:
    def __init__(self, elements):
        self.elements = elements

    def ids(self, prefix=""):
        return [e for e in self.elements if e["AXIdentifier"].startswith(prefix)]

    def find(self, ident, timeout_s=0):
        return next(e for e in self.elements if e["AXIdentifier"] == ident)


@pytest.mark.parametrize("count", [8, 3])
def test_map_order_follows_the_clockwise_orbit_slots(count):
    # LanesMap geometry: 3x3 grid of slot-sized nodes, hub in the centre, lanes on clockwise perimeter slots.
    slots = [(1, 0), (2, 0), (2, 1), (2, 2), (1, 2), (0, 2), (0, 1), (0, 0)]
    width, height, gap = 109.0, 118.0, 8.0

    def node(ident, column, row):
        return {"AXIdentifier": ident, "frame": {"x": 12 + column * (width + gap), "y": 200 + row * (height + gap),
                                                 "width": width, "height": height}}

    lanes = [f"wl-{index:024x}" for index in range(count)]
    elements = [node("lanes-map-assistant", 1, 1)]
    elements += [node(f"lanes-map-lane-{lane}", *slots[index * 8 // count]) for index, lane in enumerate(lanes)]
    scenario = run.Run.__new__(run.Run)
    scenario.ui = _FakeMapUi(list(reversed(elements)))
    assert scenario.visible_order("lanes-map-lane-") == lanes


def test_owned_stop_refuses_a_changed_identity_and_stops_its_own(tmp_path):
    env = {"PATH": "/usr/bin:/bin"}
    receipt = sd.start_owned("sleeper", [sys.executable, "-c", "import time; time.sleep(60)"], env=env, cwd=tmp_path,
                             log=tmp_path / "sleeper.log", port=None)
    try:
        forged = {**receipt, "identity": {"start": "Thu Jan  1 00:00:00 1970", "command": "other"}}
        with pytest.raises(RuntimeError, match="identity changed"):
            sd.stop_owned(forged)
        assert sd.process_identity(receipt["pid"]) is not None
    finally:
        outcome = sd.stop_owned(receipt)
    assert outcome["absent"] is True


def test_proxy_copy_requires_the_reviewed_bytes(tmp_path):
    source = tmp_path / "proxy.py"
    source.write_text("print('not the reviewed proxy')\n")
    with pytest.raises(ValueError, match="reviewed proxy"):
        sd.copy_proxy(source, tmp_path)


def _run(tmp_path, run_id="lanes-test"):
    args = argparse.Namespace(run_id=run_id, run_dir=tmp_path, python=Path(sys.executable),
                              v1_checkout=tmp_path, inc1_checkout=tmp_path)
    return run.Run(args)


def test_scratch_removal_requires_the_run_marker(tmp_path):
    owned = _run(tmp_path)
    owned.scratch.mkdir(parents=True)
    (owned.scratch / run.OWNER_MARKER).write_text("someone-else")
    with pytest.raises(RuntimeError, match="marker"):
        owned.remove_scratch()
    (owned.scratch / run.OWNER_MARKER).write_text(owned.run_id)
    owned.processes = {"daemon": {}}
    with pytest.raises(RuntimeError, match="processes"):
        owned.remove_scratch()
    owned.processes = {}
    assert owned.remove_scratch() == {"removed": str(owned.scratch)}
    assert not owned.scratch.exists()


def test_supplemental_scenes_exist_in_the_screenshot_harness():
    source = (REPO / "src/harness/screenshotFixtures.ts").read_text(encoding="utf-8")
    for scene in run.SUPPLEMENTAL_SCENES:
        assert f"'{scene}'" in source, scene


def test_scenario_scripts_compile():
    for name in ("run.py", "scratch_daemon.py", "v1_daemon.py"):
        compile((HERE / name).read_text(encoding="utf-8"), name, "exec")


def _stubbed(tmp_path, fail_at=None, error=None):
    owned = _run(tmp_path, run_id="lanes-orchestration")
    calls = []
    names = [name for name in run.STEPS]
    methods = {"admission": "admission", "seed_v1": "seed_v1", "proxy_start": "start_proxy", "probe_a": "probe_a",
               "simulator_activate": "activate_simulator", "app_launch": "launch", "enroll": "enroll",
               "open_lanes": "open_lanes", "daemon_a_stop": "stop_daemon", "probe_b": "probe_b",
               "spec_edit": "spec_edit", "transport_unavailable_probe": "transport_unavailable_probe"}
    for name in names:
        attr = methods.get(name, name)
        if attr in ("daemon_a_start", "daemon_b_start", "seed_inc1_upgrade"):
            continue
        def fake(name=name):
            calls.append(name)
            if name == fail_at:
                raise error
        setattr(owned, attr, fake)
    owned.start_daemon = lambda label, checkout: calls.append(label)
    owned.seed = lambda pin, checkout: calls.append("seed-" + pin)
    return owned, calls


def test_orchestration_runs_every_step_then_teardown(tmp_path, capsys):
    owned, calls = _stubbed(tmp_path)
    assert owned.execute() == 0
    result = json.loads((owned.evidence / "result.json").read_text())
    assert result["verdict"] == "PASS" and [s["step"] for s in result["steps"]] == run.STEPS
    assert calls.index("daemon-a-v1") < calls.index("seed-inc1") < calls.index("daemon-b-inc1")
    assert result["teardown"]["failures"] == []
    assert (owned.evidence / "teardown.json").is_file()


@pytest.mark.parametrize("fail_at, error, code, verdict", [
    ("run_b_log", run.AssertFail("x"), 1, "FAIL"),
    ("admission", run.SetupFail("y"), 4, "SETUP_FAIL"),
])
def test_orchestration_verdicts(tmp_path, capsys, fail_at, error, code, verdict):
    owned, calls = _stubbed(tmp_path, fail_at, error)
    assert owned.execute() == code
    result = json.loads((owned.evidence / "result.json").read_text())
    assert result["verdict"] == verdict and calls[-1] == fail_at
