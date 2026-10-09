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
import subprocess
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


def _owned_scratch(tmp_path):
    owned = _run(tmp_path)
    owned.scratch.mkdir(parents=True)
    (owned.scratch / run.OWNER_MARKER).write_text(owned.run_id)
    owned.evidence.mkdir(parents=True, exist_ok=True)
    return owned


def _failing_stop(receipt):
    raise RuntimeError(f"{receipt['label']}: owned stop incomplete")


def test_failed_teardown_stop_keeps_its_receipt_and_the_scratch(tmp_path, monkeypatch):
    owned = _owned_scratch(tmp_path)
    owned.processes = {"daemon": {"label": "daemon"}}
    monkeypatch.setattr(run.sd, "stop_owned", _failing_stop)
    record = owned.teardown()
    assert "daemon_stop" in record["failures"] and "scratch_remove" in record["failures"]
    assert owned.processes == {"daemon": {"label": "daemon"}}
    assert owned.scratch.is_dir()


def test_failed_mid_run_stop_keeps_the_scratch_even_after_a_later_stop(tmp_path, monkeypatch):
    owned = _owned_scratch(tmp_path)
    owned.processes = {"daemon": {"label": "daemon"}}
    monkeypatch.setattr(run.sd, "stop_owned", _failing_stop)
    with pytest.raises(RuntimeError, match="incomplete"):
        owned.stop_daemon()
    assert owned.processes == {"daemon": {"label": "daemon"}}
    monkeypatch.setattr(run.sd, "stop_owned", lambda receipt: {"label": receipt["label"], "absent": True})
    record = owned.teardown()
    assert owned.processes == {}
    assert "scratch_remove" in record["failures"]
    assert owned.scratch.is_dir()


def test_supplemental_scenes_exist_in_the_screenshot_harness():
    source = (REPO / "src/harness/screenshotFixtures.ts").read_text(encoding="utf-8")
    for scene in run.SUPPLEMENTAL_SCENES:
        assert f"'{scene}'" in source, scene
    # Show failure scenes are stub-driven; their asserted texts must be the client's settled wording.
    settlement = (REPO / "src/components/lanes/useWorkLaneShow.ts").read_text(encoding="utf-8")
    log = (REPO / "src/components/lanes/LaneLog.tsx").read_text(encoding="utf-8")
    assert set(run.SHOW_FAILURE_SCENES) == {"lanes:show_error", "lanes:show_timeout"}
    for scene in run.SHOW_FAILURE_SCENES.values():
        assert f"'{scene['expect_text']}'" in settlement, scene
    for test_id in ("lane-log-retry", "lane-log-loading"):
        assert f'testID="{test_id}"' in log, test_id


def test_stub_serves_on_loopback_and_stops():
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    stop = run.start_stub(run.LaneShowStub("typed_error", _fixture()["inventory_frame"]), port)
    assert sd.port_listening(port)
    stop()
    assert not sd.port_listening(port)


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


# ---------------------------------------------------------------------------
# Supplemental show error / timeout (real requestWorkLaneShow settlement against
# a loopback stub) and checked supplemental teardown.
# ---------------------------------------------------------------------------

def test_show_failure_scenes_are_declared_and_selectable():
    scenes = run.SHOW_FAILURE_SCENES
    assert scenes["lanes:show_error"]["mode"] == "typed_error"
    assert scenes["lanes:show_error"]["expect_text"] == "Lane details unavailable"
    assert scenes["lanes:show_timeout"]["mode"] == "no_reply"
    assert scenes["lanes:show_timeout"]["expect_text"] == "Request timed out"
    assert scenes["lanes:show_timeout"]["min_wait_s"] >= 30  # client RPC timeout
    args = run.parse(["supplemental", "--run-dir", "/tmp/x", "--app", "/tmp/a.app", "--scene", "lanes:show_timeout",
                      "--device-type", "d", "--runtime", "r", "--production-config", "/tmp/p.json"])
    assert args.scene == "lanes:show_timeout"


def _stub_exchange(mode, frames_after_show=1, wait_s=1.5):
    import asyncio
    import websockets

    async def go():
        stub = run.LaneShowStub(mode, _fixture()["inventory_frame"])
        async with websockets.serve(stub.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                assert json.loads(await ws.recv())["type"] == "welcome"
                await ws.send(json.dumps({"type": "hello", "client": "pentacle-mobile",
                                          "capabilities": {"work_lanes_v1": True}, "subscribe": {}}))
                seen = {}
                while "work_lanes.inventory" not in seen:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    seen[frame["type"]] = frame
                lane = _fixture()["inventory_frame"]["lanes"][0]["lane_id"]
                await ws.send(json.dumps({"type": "work_lanes.show", "lane_id": lane, "request_id": "work_lanes_show-1"}))
                await ws.send(json.dumps({"type": "ping"}))
                replies = []
                try:
                    while True:
                        replies.append(json.loads(await asyncio.wait_for(ws.recv(), wait_s)))
                except asyncio.TimeoutError:
                    pass
                return seen, replies, stub.receipts
    return asyncio.run(go())


def test_lane_show_stub_typed_error_settles_the_request():
    seen, replies, receipts = _stub_exchange("typed_error")
    assert seen["snapshot"]["work_lanes"]["lanes"] == _fixture()["inventory_frame"]["lanes"]
    error = [r for r in replies if r["type"] == "work_lanes.show.error"]
    assert error == [{"type": "work_lanes.show.error", "request_id": "work_lanes_show-1",
                      "error_code": "work_lanes_show_failed", "error": "synthetic supplemental failure"}]
    assert {"type": "pong"} in replies
    assert [r["reply"] for r in receipts] == ["work_lanes.show.error"]


def test_lane_show_stub_no_reply_leaves_only_liveness():
    seen, replies, receipts = _stub_exchange("no_reply")
    assert [r["type"] for r in replies] == ["pong"]  # socket stays alive; the request is never answered
    assert receipts[0]["request_id"] == "work_lanes_show-1" and receipts[0]["reply"] is None


class _FakeSimctl:
    def __init__(self, shutdown_rc=0, delete_rc=0, still_listed=False):
        self.calls, self.rc, self.listed = [], {"shutdown": shutdown_rc, "delete": delete_rc}, still_listed

    def __call__(self, argv, **_kwargs):
        self.calls.append(argv[2:])
        verb = argv[2]
        stdout = ""
        if verb == "list":
            devices = [{"udid": "U-1", "name": "x"}] if self.listed else []
            stdout = json.dumps({"devices": {"runtime": devices}})
        return subprocess.CompletedProcess(argv, self.rc.get(verb, 0), stdout, "boom" if self.rc.get(verb) else "")


@pytest.mark.parametrize("fake, complete", [
    (_FakeSimctl(), True),
    (_FakeSimctl(shutdown_rc=1), True),          # already-shutdown is fine if delete removes it
    (_FakeSimctl(delete_rc=1, still_listed=True), False),
    (_FakeSimctl(still_listed=True), False),
])
def test_supplemental_teardown_is_checked(fake, complete):
    record = run.supplemental_teardown("U-1", runner=fake)
    assert record["udid_absent"] is complete and record["complete"] is complete
    assert [c[0] for c in fake.calls] == ["shutdown", "delete", "list"]
    assert set(record) >= {"shutdown_rc", "delete_rc", "udid_absent", "complete"}


def test_incomplete_supplemental_teardown_makes_setup_fail_and_keeps_scene_verdict():
    record = run.finalize_supplemental({"verdict": "PASS"}, {"complete": False})
    assert record["verdict"] == "SETUP_FAIL" and record["scene_verdict"] == "PASS"
    assert run.finalize_supplemental({"verdict": "FAIL"}, {"complete": True})["verdict"] == "FAIL"


class _FakeSceneUi:
    """Modelled lane log: tapping the log or Retry sends a show request through the stub."""

    def __init__(self, stub, spinner=True, retry_id=None):
        self.stub, self.spinner, self.retry_id, self.screenshots = stub, spinner, retry_id, []

    def find(self, ident, timeout_s=0):
        return {"AXIdentifier": ident}

    def ids(self, prefix=""):
        if prefix == "lane-log-loading" and self.spinner:
            return [{"AXIdentifier": prefix}]
        return []

    def find_label(self, text, timeout_s=0):
        return {"AXLabel": text}

    def screenshot(self, name):
        self.screenshots.append(name)

    def tap(self, ident):
        number = len(self.stub.receipts) + 1
        request_id = self.retry_id if ident == "lane-log-retry" and self.retry_id is not None else f"req-{number}"
        self.stub.receipts.append({"at": time.time(), "request_id": request_id, "lane_id": "wl-1", "reply": None})


class _FakeStub:
    def __init__(self):
        self.receipts = []


_NO_REPLY = {"mode": "no_reply", "expect_text": "Request timed out", "min_wait_s": 0}


def test_show_failure_scene_accepts_a_pending_state_and_a_fresh_retry():
    stub, record = _FakeStub(), {}
    run.run_show_failure_scene(_NO_REPLY, _FakeSceneUi(stub), stub, record, "wl-1")
    assert record["show_failure"]["pending_spinner_visible"] is True
    assert [r["request_id"] for r in record["show_failure"]["requests"]] == ["req-1", "req-2"]


@pytest.mark.parametrize("ui_kwargs, fragment", [
    ({"spinner": False}, "pending"),
    ({"retry_id": "req-1"}, "fresh request id"),
    ({"retry_id": ""}, "fresh request id"),
])
def test_show_failure_scene_rejects_missing_pending_state_and_reused_retry_ids(ui_kwargs, fragment):
    stub = _FakeStub()
    with pytest.raises(run.AssertFail, match=fragment):
        run.run_show_failure_scene(_NO_REPLY, _FakeSceneUi(stub, **ui_kwargs), stub, {}, "wl-1")


def _harness_config(ws=sd.APP_WS_URL, name="Pentacle Harness", **extra):
    return {"name": name, "extra": {"wsUrl": ws, **extra}}


def test_supplemental_admission_requires_a_loopback_build_of_the_declared_identity():
    bundle = b"\x00hermes " + sd.APP_WS_URL.encode()
    production = run.operational_urls(PROD)
    show = run.SHOW_FAILURE_BUILD
    assert run.admit_supplemental_app(bundle, _harness_config(), production, show)["problems"] == []
    assert run.admit_supplemental_app(bundle, _harness_config(name="Pentacle"), production,
                                      run.SUPPLEMENTAL_BUILD)["problems"] == []
    with pytest.raises(run.SetupFail, match="non-loopback operational"):
        run.admit_supplemental_app(bundle, _harness_config(hosts=[{"url": "https://unowned.example.org"}]),
                                   production, run.SUPPLEMENTAL_BUILD)
    for config, fragment in [
        (_harness_config(dashboardHubUrl="https://unowned.example.org"), "non-loopback operational"),
        (_harness_config(name="Pentacle"), "armed harness build"),
        (_harness_config(ws="ws://127.0.0.1:7791"), "extra.wsUrl"),
    ]:
        with pytest.raises(run.SetupFail, match=fragment):
            run.admit_supplemental_app(bundle, config, production, show)
    with pytest.raises(run.SetupFail, match="production"):
        run.admit_supplemental_app(bundle, _harness_config(), [], show)


def test_companion_stop_failure_keeps_the_scene_verdict():
    def failing(_receipt):
        raise RuntimeError("owned stop incomplete")

    record = {"verdict": "PASS"}
    run.stop_supplemental_companion(record, {"label": "ui-companion"}, stopper=failing)
    assert record["verdict"] == "PASS" and record["companion_stopped"] is False
    record = run.finalize_supplemental(record, {"complete": True})
    assert record["verdict"] == "SETUP_FAIL" and record["scene_verdict"] == "PASS"


# Structural self-check: every declared scene takes the one shared path (admission before any simulator,
# its own check, verdict frozen before teardown, companion-stop failure recorded without overwriting it).

def _fake_app(tmp_path, app_config):
    import plistlib
    app = tmp_path / "Fake.app"
    (app / "EXConstants.bundle").mkdir(parents=True)
    (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "dev.example.lanes", "CFBundleExecutable": "Fake"}))
    (app / "main.jsbundle").write_bytes(b"\x00hermes " + sd.APP_WS_URL.encode())
    (app / "EXConstants.bundle" / "app.config").write_text(json.dumps(app_config))
    return app


class _RecordingSimctl:
    def __init__(self):
        self.verbs = []

    def __call__(self, argv, **_kwargs):
        verb = argv[2] if argv[:2] == ["xcrun", "simctl"] else argv[0]
        self.verbs.append(verb)
        stdout = "11111111-2222-3333-4444-555555555555" if verb == "create" else ""
        if verb == "list":
            stdout = json.dumps({"devices": {}})
        return subprocess.CompletedProcess(argv, 0, stdout, "")


def _supplemental(tmp_path, monkeypatch, scene, app_config, check):
    tmp_path.mkdir(parents=True)
    simctl = _RecordingSimctl()
    monkeypatch.setattr(run.subprocess, "run", simctl)
    monkeypatch.setattr(run.sd, "start_owned", lambda label, *a, **k: {"label": label})

    def failing_stop(receipt):
        raise RuntimeError("owned stop incomplete")

    monkeypatch.setattr(run.sd, "stop_owned", failing_stop)
    monkeypatch.setattr(run, "Ui", lambda *a, **k: type("U", (), {"screenshots": []})())
    monkeypatch.setattr(run, "LaneShowStub", lambda mode, inventory: _FakeStub())
    monkeypatch.setattr(run, "start_stub", lambda stub, port: (lambda: None))
    monkeypatch.setitem(run.SCENES[scene], "check", check)
    production = tmp_path / "production.json"
    production.write_text(json.dumps(PROD))
    run_dir = tmp_path / "runs"
    run_dir.mkdir(exist_ok=True)
    args = run.parse(["supplemental", "--run-dir", str(run_dir), "--app", str(_fake_app(tmp_path, app_config)),
                      "--scene", scene, "--device-type", "d", "--runtime", "r", "--production-config", str(production)])
    code = run.supplemental(args)
    [result] = sorted(run_dir.glob("supplemental-*/supplemental.json"))
    record = json.loads(result.read_text())
    result.unlink()
    return code, record, simctl.verbs


def test_every_supplemental_scene_runs_the_shared_path(tmp_path, monkeypatch):
    assert set(run.SCENES) == set(run.SUPPLEMENTAL_SCENES) | set(run.SHOW_FAILURE_SCENES)
    assert {spec["check"] for spec in run.SCENES.values()} == {run.check_seeded_scene, run.run_show_failure_scene}
    for name, spec in run.SCENES.items():
        good = _harness_config(name=run.HARNESS_APP_NAME if spec["build"] == run.SHOW_FAILURE_BUILD else "Pentacle")
        checked = []

        def check(scene, ui, stub, record, lane_id, name=name):
            checked.append(name)

        # 1) refused admission: the scene never reaches a simulator or its check
        bad = {**good, "extra": {**good["extra"], "dashboardHubUrl": "https://unowned.example.org"}}
        code, record, verbs = _supplemental(tmp_path / name.replace(":", "-") / "bad", monkeypatch, name, bad, check)
        assert (code, record["verdict"], record["scene_verdict"]) == (4, "SETUP_FAIL", "SETUP_FAIL"), name
        assert verbs == [] and checked == [], name
        # 2) admitted: check runs, its PASS is frozen, the failed companion stop is recorded separately
        code, record, verbs = _supplemental(tmp_path / name.replace(":", "-") / "good", monkeypatch, name, good, check)
        assert checked == [name] and verbs[0] == "create", name
        assert record["admission"]["problems"] == [] and record["build_identity"] == spec["build"], name
        assert (code, record["verdict"], record["scene_verdict"]) == (4, "SETUP_FAIL", "PASS"), name
        assert record["companion_stopped"] is False and record["teardown"]["complete"] is True, name


# Real-run fixes: macOS venv python re-execs (identity), and operator-authenticated probes.

def test_same_process_ignores_the_interpreter_path_only():
    start = "Fri Oct 9 07:59:37 2026"
    recorded = {"start": start, "command": "/run/venv/bin/python /d/web_gate_daemon.py /s --port 17893"}
    reexec = {"start": start, "command": "/opt/Python.app/Contents/MacOS/Python /d/web_gate_daemon.py /s --port 17893"}
    assert sd.same_process(recorded, reexec)
    assert not sd.same_process(recorded, {**reexec, "start": "Fri Oct 9 08:00:00 2026"})
    assert not sd.same_process(recorded, {**reexec, "command": "/opt/Python /d/other.py /s --port 17893"})
    assert not sd.same_process({"start": start, "command": "/run/venv/bin/python"}, {"start": start, "command": "/opt/Python"})


def test_owned_stop_accepts_its_own_reexeced_interpreter(tmp_path):
    env = {"PATH": "/usr/bin:/bin"}
    receipt = sd.start_owned("sleeper", [sys.executable, "-c", "import time; time.sleep(60)"], env=env, cwd=tmp_path,
                             log=tmp_path / "sleeper.log", port=None)
    current = sd.process_identity(receipt["pid"])
    _, _, tail = current["command"].partition(" ")
    reexec = {**receipt, "identity": {"start": current["start"], "command": "/elsewhere/bin/python " + tail}}
    outcome = sd.stop_owned(reexec)
    assert outcome["absent"] is True and not outcome.get("identity_changed")


class _FakeOperatorAuth:
    AUTH_SCHEME = "hmac-sha256-v2"

    @staticmethod
    def decode_envelope(value):
        assert value == "pentacle-auth-v2:fake"
        return {"version": 2, "credential_id": "11111111-2222-3333-4444-555555555555", "client_kind": "pentacle",
                "proof_key": b"k" * 32}

    @staticmethod
    def make_proof(key, nonce, credential_id, client_kind):
        return f"proof({len(key)},{nonce},{credential_id},{client_kind})"


def test_probe_hello_is_anonymous_or_an_operator_proof_over_the_welcome_nonce():
    welcome = {"type": "welcome", "auth": {"operator": {"scheme": "hmac-sha256-v2", "nonce": "N0"}}}
    anonymous = sd.probe_hello(welcome, None)
    assert "auth_v2" not in anonymous and anonymous["client"] == "lanes-release-contained-probe"
    hello = sd.probe_hello(welcome, {"envelope": "pentacle-auth-v2:fake", "module": _FakeOperatorAuth})
    assert hello["client"] == "pentacle"
    assert hello["auth_v2"] == {"scheme": "hmac-sha256-v2", "credential_id": "11111111-2222-3333-4444-555555555555",
                                "proof": "proof(32,N0,11111111-2222-3333-4444-555555555555,pentacle)"}
    with pytest.raises(RuntimeError, match="nonce"):
        sd.probe_hello({"type": "welcome"}, {"envelope": "pentacle-auth-v2:fake", "module": _FakeOperatorAuth})


def test_operator_credential_is_issued_by_the_pinned_wrapper_inside_scratch(tmp_path):
    argv = sd.issue_argv("/venv/python", tmp_path / "checkout", tmp_path / "scratch")
    assert argv == ["/venv/python", str(tmp_path / "checkout" / sd.WRAPPER_PATH), str(tmp_path / "scratch"), "--issue"]
    assert sd.operator_token_path(tmp_path / "scratch") == tmp_path / "scratch" / "operator-auth" / "token"


def test_scratch_hashes_never_include_operator_auth_material(tmp_path):
    owned = _owned_scratch(tmp_path)
    (owned.scratch / "operator-auth").mkdir()
    (owned.scratch / "operator-auth" / "token").write_text("pentacle-auth-v2:secret")
    (owned.scratch / "operator-auth" / "registry.json").write_text("{}")
    (owned.scratch / "sessions.db").write_text("x")
    owned.hash_evidence()
    assert set(owned.result["scratch_file_sha256"]) == {"sessions.db"}


def test_probe_a_reads_show_as_operator_and_proves_anonymous_reads_are_refused(tmp_path, monkeypatch):
    owned = _owned_scratch(tmp_path)
    owned.probe_auth = {"envelope": "e", "module": _FakeOperatorAuth}
    v1_inventory = json.loads((Path(run.__file__).resolve().parents[3] / sd.FIXTURE_PATH).read_text())["inventory_frame"]
    calls = []

    def fake_probe(port, lane_id=None, timeout_s=20, auth=None):
        calls.append(auth)
        if auth is None:
            return {"inventory": v1_inventory, "show": {"type": "work_lanes.show.error", "error_code": "work_lanes_unauthorized"}}
        return {"inventory": v1_inventory, "show": {"type": "work_lanes.show.ok", "lane": {"lane_id": lane_id}}}

    monkeypatch.setattr(run.sd, "probe", fake_probe)
    monkeypatch.setattr(run.v1, "check_v1_inventory", lambda *a: [])
    monkeypatch.setattr(run.v1, "check_v1_show", lambda frame, lane: [] if frame["type"].endswith(".ok") else ["no show.ok"])
    owned.probe_a()
    assert calls == [owned.probe_auth, None]
    assert owned.result["checks"]["probe_a"]["anonymous_show_error_code"] == "work_lanes_unauthorized"


def test_load_probe_auth_executes_a_real_postponed_annotation_dataclass_module(tmp_path):
    # Shape of the pinned services/_shared/operator_auth.py: future annotations + @dataclass.
    shared = tmp_path / "checkout" / "services" / "_shared"
    shared.mkdir(parents=True)
    (shared / "operator_auth.py").write_text(
        "from __future__ import annotations\n"
        "from dataclasses import dataclass\n"
        "AUTH_SCHEME = 'hmac-sha256-v2'\n"
        "@dataclass(frozen=True)\n"
        "class ConnectionTrust:\n"
        "    credential_id: str\n"
        "    client_kind: str\n"
        "def decode_envelope(value):\n"
        "    return {'credential_id': value, 'client_kind': 'pentacle', 'proof_key': b'k' * 32}\n")
    token = sd.operator_token_path(tmp_path / "scratch")
    token.parent.mkdir(parents=True)
    token.write_text("envelope-value\n")
    auth = sd.load_probe_auth(tmp_path / "checkout", tmp_path / "scratch")
    assert auth["envelope"] == "envelope-value"
    assert auth["module"].ConnectionTrust("c", "pentacle").client_kind == "pentacle"
    assert auth["module"].AUTH_SCHEME == "hmac-sha256-v2"


_PINNED = [Path(p) for p in __import__("os").environ.get("LANES_PINNED_DAEMON_CHECKOUTS", "").split(":") if p]


@pytest.mark.skipif(not _PINNED, reason="set LANES_PINNED_DAEMON_CHECKOUTS to the pinned daemon checkouts")
@pytest.mark.parametrize("checkout", _PINNED, ids=[p.name for p in _PINNED])
def test_load_probe_auth_loads_the_real_pinned_operator_auth(checkout, tmp_path):
    # Real pinned module + a real envelope it encodes itself; the proof must verify with the module's own transcript.
    token = sd.operator_token_path(tmp_path)
    token.parent.mkdir(parents=True)
    import importlib.util
    spec = importlib.util.spec_from_file_location("envelope_maker", checkout / "services" / "_shared" / "operator_auth.py")
    maker = importlib.util.module_from_spec(spec)
    sys.modules["envelope_maker"] = maker
    try:
        spec.loader.exec_module(maker)
        envelope = maker.encode_envelope("11111111-2222-4333-8444-555555555555", "pentacle", b"k" * maker.AUTH_PROOF_BYTES)
    finally:
        sys.modules.pop("envelope_maker", None)
    token.write_text(envelope)
    auth = sd.load_probe_auth(checkout, tmp_path)
    nonce = auth["module"].encode_b64url(b"n" * auth["module"].AUTH_NONCE_BYTES)
    hello = sd.probe_hello({"type": "welcome", "auth": {"operator": {"nonce": nonce}}}, auth)
    assert hello["client"] == "pentacle" and hello["auth_v2"]["scheme"] == auth["module"].AUTH_SCHEME
    import hashlib, hmac
    expected = hmac.new(b"k" * 32, auth["module"].proof_transcript(nonce, hello["auth_v2"]["credential_id"], "pentacle"),
                        hashlib.sha256).digest()
    assert hello["auth_v2"]["proof"] == auth["module"].encode_b64url(expected)


# Reduced proof: exact-label system alerts, in-app lanes navigation, smoke/reduced plans.

def _el(label, kind, x=0, y=0):
    return {"AXLabel": label, "type": kind, "frame": {"x": x, "y": y, "width": 140, "height": 48}}


def test_known_system_alerts_match_exact_titles_and_buttons():
    notifications = [_el("“Pentacle” Would Like to Send You Notifications", "StaticText"),
                     _el("Notifications may include alerts, sounds, and icon badges.", "StaticText"),
                     _el("Don’t Allow", "Button", 57, 494), _el("Allow", "Button", 205, 494)]
    title, button = run.known_system_alert(notifications)
    assert title.startswith("“Pentacle” Would Like") and button["AXLabel"] == "Don’t Allow"
    opener = [_el('Open in "Pentacle"?', "StaticText"), _el("Cancel", "Button"), _el("Open", "Button", 300, 500)]
    title, button = run.known_system_alert(opener)  # straight or curly quotes, same title
    assert title == "Open in “Pentacle”?" and button["frame"]["x"] == 300
    assert run.known_system_alert([_el("Cancel", "Button"), _el("Open session status", "Button")]) is None
    with pytest.raises(run.SetupFail, match="exactly one"):
        run.known_system_alert([_el("Open in “Pentacle”?", "StaticText"), _el("Cancel", "Button")])


def _alert_ui(tmp_path, screens):
    ui = run.Ui("U-1", "idb", lambda *a: None, tmp_path / "screenshots")
    (tmp_path / "screenshots").mkdir()
    taps, frames = [], iter(screens)
    ui.elements = lambda: next(frames)
    ui._idb = lambda *args: taps.append(args) or subprocess.CompletedProcess(args, 0, "", "")
    return ui, taps


@pytest.mark.parametrize("button", [
    {"AXLabel": "Open", "type": "Button"},                      # no frame
    {**_el("Open", "Button", 300, 500), "AXEnabled": False},    # disabled
])
def test_untappable_system_alert_button_is_setup_fail_with_a_dump(tmp_path, monkeypatch, button):
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    ui, taps = _alert_ui(tmp_path, [[_el("Open in “Pentacle”?", "StaticText"), _el("Cancel", "Button"), button]])
    with pytest.raises(run.SetupFail, match="Open in"):
        ui.clear_system_alerts()
    assert taps == [] and [p.name for p in (tmp_path / "ax").iterdir()] == ["00-system-alert.json"]


@pytest.mark.parametrize("buttons", [[_el("Cancel", "Button")],
                                     [_el("Open", "Button", 300, 500), _el("Open", "Button", 300, 560)]])
def test_known_alert_without_exactly_one_button_dumps_before_setup_fail(tmp_path, buttons):
    ui, taps = _alert_ui(tmp_path, [[_el("Open in “Pentacle”?", "StaticText"), *buttons]])
    with pytest.raises(run.SetupFail, match="exactly one"):
        ui.clear_system_alerts()
    dumps = list((tmp_path / "ax").iterdir())
    assert taps == [] and [p.name for p in dumps] == ["00-system-alert-unmatched.json"]
    assert "Open in" in dumps[0].read_text(encoding="utf-8")


def test_lanes_status_button_is_the_assistant_header_label():
    elements = [_el("Sessions, 0 need you", "Button"), _el("Assistant status, 9 open lanes, 1 blocked", "Button"),
                _el("Questions, 0 pending", "Button")]
    assert run.lanes_status_button(elements)["AXLabel"].startswith("Assistant status")
    assert run.lanes_status_button([_el("Assistant status, 9 open lanes", "StaticText")]) is None


def test_smoke_and_reduced_plans_are_inc1_only_and_bounded():
    assert run.SMOKE_STEPS == ["admission", "seed_inc1", "proxy_start", "daemon_b_start", "probe_b",
                               "simulator_activate", "app_launch", "enroll", "home_enrolled"]
    assert run.REDUCED_STEPS == run.SMOKE_STEPS + ["open_lanes", "reduced_list", "reduced_members", "reduced_map"]
    assert not {"seed_v1", "daemon_a_start", "probe_a", "run_c_reconnect"} & set(run.REDUCED_STEPS)
    common = ["--run-dir", "/r", "--app", "/a.app", "--bundle-id", "b", "--production-config", "/p",
              "--v1-checkout", "/v1", "--inc1-checkout", "/i", "--python", "/py", "--proxy-source", "/px",
              "--device-type", "d", "--runtime", "r"]
    assert run.parse(["smoke", *common]).command == "smoke"
    assert run.parse(["reduced", *common]).command == "reduced"


def test_enroll_presses_known_alerts_until_the_snapshot_arrives(tmp_path, monkeypatch):
    owned = _owned_scratch(tmp_path)
    owned.udid, owned.enroll_checkout = "U-1", tmp_path
    pressed, snapshots = [], iter([False, False, True])

    class FakeUi:
        def clear_system_alerts(self):
            if not pressed:
                pressed.append("Open in “Pentacle”?")
                return ["Open in “Pentacle”?"]
            return []

    owned.ui = FakeUi()
    monkeypatch.setattr(owned, "sh", lambda *a, **k: subprocess.CompletedProcess(a, 0, json.dumps({"url": "pentacle://enroll?code=X"}), ""))
    monkeypatch.setattr(run.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    monkeypatch.setattr(owned, "wire", lambda: [])
    monkeypatch.setattr(run, "connections_with_snapshot", lambda rows, since: next(snapshots))
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    owned.enroll()
    assert owned.result["system_alerts"] == ["Open in “Pentacle”?"]
    assert owned.result["enrollment"]["code_retained"] is False
