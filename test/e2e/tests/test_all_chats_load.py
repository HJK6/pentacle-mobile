"""Offline contract for the bounded all-chats load-responsiveness scenario."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import mock_v2_daemon as mvd  # noqa: E402
import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

from e2e import run_scenario  # noqa: E402
from e2e.harness.telemetry_events import TelemetryEvent  # noqa: E402
from e2e.scenarios import all_chats_freeze_sim_regression as S  # noqa: E402
from e2e.scenarios._m1_mock_control import MockControl  # noqa: E402
from e2e.tests.test_mock_v2_daemon import _args  # noqa: E402

WS = "ws://127.0.0.1:17999"


def _config(**extra):
    return {"ws_url": WS, "scenario_run_id": "run-1", **extra}


# ---- registration / actions -------------------------------------------------

def test_registered_in_public_native_runner():
    scenarios = run_scenario.build_scenarios()
    assert scenarios["all_chats_load"].module is S
    assert run_scenario.REPORT_MODULES["all_chats_load"] == "e2e.scenarios.all_chats_freeze_sim_regression"
    assert S.name == "all_chats_load"


def test_dangling_probe_action_removed_and_control_mode_adds_stall():
    # The mock daemon issues no operator credential: without the standard
    # disable_pentacle_auth unblocker the app stops at operator_enrollment_required
    # and never opens the socket (a native run then fails with chat:ws_open missing).
    assert S.actions(_config()) == ["autoaccept_biometric", "disable_pentacle_auth"]
    assert "chat_list_load_probe" not in S.actions(_config(PENTACLE_ALL_CHATS_MODE="stall_control"))
    assert S.actions(_config(PENTACLE_ALL_CHATS_MODE="stall_control")) == [
        "autoaccept_biometric", "disable_pentacle_auth", "chat_list_js_stall"]
    with pytest.raises(ValueError):
        S.actions(_config(PENTACLE_ALL_CHATS_MODE="stress"))


def test_no_source_requests_the_removed_probe():
    root = Path(__file__).resolve().parents[3]
    for path in [root / "test/e2e/scenarios/all_chats_freeze_sim_regression.py", root / "test/e2e/run_scenario.py"]:
        assert "chat_list_load_probe" not in path.read_text(encoding="utf-8")


def test_params_mark_every_burst_stream_active_and_require_loopback():
    params = S.params(_config())
    assert params["active_stream_ids"].split(",") == list(S.BURST_STREAM_IDS)
    assert params["ws_url"] == WS
    assert not any(key.startswith("chat_list_js_stall") for key in params)
    control = S.params(_config(PENTACLE_ALL_CHATS_MODE="stall_control"))
    assert control["chat_list_js_stall_stream_id"] == S.TRIGGER_STREAM_ID
    assert control["chat_list_js_stall_seq"] == str(S.TRIGGER_SEQ)
    assert control["chat_list_js_stall_ms"] == str(S.STALL_MS)
    for bad in ["", "ws://example.com:1", "wss://127.0.0.1:1", "ws://127.0.0.1"]:
        with pytest.raises(ValueError):
            S.params(_config(ws_url=bad))


# ---- fixture -----------------------------------------------------------------

def test_snapshot_has_burst_trigger_and_assistant_sessions():
    sessions = S.build_snapshot(_config())["sessions"]
    ids = [row["stream_id"] for row in sessions]
    assert ids[:S.SESSION_COUNT] == list(S.BURST_STREAM_IDS)
    assert S.TRIGGER_STREAM_ID in ids and "home:assistant" in ids
    assert len(set(ids)) == len(ids) == S.SESSION_COUNT + 2
    custom = S.build_snapshot(_config(PENTACLE_ASSISTANT_STREAM_ID="lab:helper"))["sessions"]
    assert "lab:helper" in [row["stream_id"] for row in custom]
    assert S.build_snapshot(_config())["events"] == []


def test_burst_is_paced_unique_and_contiguous_per_stream():
    frames = S.build_burst()
    assert len(frames) == S.BURST_EVENT_COUNT == S.SESSION_COUNT * S.EVENTS_PER_STREAM == 320
    identities = {(f["stream_id"], f["daemon_seq"]) for f in frames}
    assert len(identities) == 320
    assert [f["at_ms"] for f in frames] == [i * S.FRAME_INTERVAL_MS for i in range(320)]
    for stream_id in S.BURST_STREAM_IDS:
        assert [f["daemon_seq"] for f in frames if f["stream_id"] == stream_id] == list(range(1, S.EVENTS_PER_STREAM + 1))
    assert len({f["text"] for f in frames}) == 320
    assert all(f["kind"] == "ASSIST" for f in frames)
    assert S.TRIGGER_STREAM_ID not in {f["stream_id"] for f in frames}


# ---- injector ----------------------------------------------------------------

class _Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)


class _FakeControl:
    def __init__(self, clock, ack_delay_s=0.0, reject_at=None):
        self.clock, self.ack_delay_s, self.reject_at, self.sent = clock, ack_delay_s, reject_at, []

    def rpc(self, kind, **payload):
        assert kind == "debug_replay_event"
        self.sent.append((self.clock(), payload["event"]))
        if self.reject_at is not None and len(self.sent) == self.reject_at:
            raise RuntimeError("M1 mock rejected debug_replay_event")
        self.clock.now += self.ack_delay_s
        return {"status": "ok"}


def test_injector_paces_without_catch_up_bursts():
    clock = _Clock()
    control = _FakeControl(clock, ack_delay_s=0.25)  # ack slower than the 100 ms interval
    frames = S.build_burst()[:6]
    record = S.run_injector(control, frames, interval_s=0.1, clock=clock, sleep=clock.sleep)
    times = [at for at, _event in control.sent]
    assert all(b - a >= 0.1 - 1e-9 for a, b in zip(times, times[1:]))
    assert [row["acked"] for row in record["frames"]] == [True] * 6
    assert record["frames"][-1]["lateness_ms"] > 0
    assert record["first_send_mono"] == times[0] and record["last_ack_mono"] >= times[-1]


def test_injector_records_rejection_as_unacked():
    clock = _Clock()
    record = S.run_injector(_FakeControl(clock, reject_at=2), S.build_burst()[:3], interval_s=0.1, clock=clock, sleep=clock.sleep)
    assert [row["acked"] for row in record["frames"]] == [True, False]
    assert record["error"]


def test_injector_through_public_mock_reaches_app_client():
    """The real mock daemon acks every frame and broadcasts each as chat.event."""
    loop = asyncio.new_event_loop()
    ready, received, stop = threading.Event(), [], None
    state = {}

    async def main():
        daemon = mvd.MockDaemon(_args(0, ""))
        server = await serve(daemon.handler, "127.0.0.1", 0, max_size=None)
        state["url"] = f"ws://127.0.0.1:{next(iter(server.sockets)).getsockname()[1]}"
        async with websockets.connect(state["url"], max_size=None) as app:
            assert json.loads(await app.recv())["type"] == "welcome"
            await app.send(json.dumps({"type": "hello", "client": "pentacle-mobile", "subscribe": {"snapshot": True}}))
            ready.set()
            while len(received) < 40:
                frame = json.loads(await asyncio.wait_for(app.recv(), timeout=10))
                if frame.get("type") == "chat.event":
                    received.append((frame["event"]["stream_id"], frame["event"]["daemon_seq"]))
        server.close()
        await server.wait_closed()

    thread = threading.Thread(target=lambda: loop.run_until_complete(main()), daemon=True)
    thread.start()
    assert ready.wait(10)
    control = MockControl(state["url"])
    try:
        control.rpc("debug_replay_snapshot_config", snapshot=S.build_snapshot(_config()), host=S.HOST)
        frames = S.build_burst()[:40]
        record = S.run_injector(control, frames, interval_s=0.0)
    finally:
        control.close()
    thread.join(15)
    assert all(row["acked"] for row in record["frames"])
    assert received == [(f["stream_id"], f["daemon_seq"]) for f in frames]


# ---- native probe ------------------------------------------------------------

ROOT = {"role": "AXApplication", "frame": {"x": 0, "y": 0, "width": 400, "height": 800}, "pid": 1}
BUTTON = {"AXLabel": "Sessions, 2 need you", "role": "AXButton", "frame": {"x": 10, "y": 60, "width": 40, "height": 40}}
SCRIM = {"AXLabel": "Close sessions", "role": "AXButton", "frame": {"x": 0, "y": 0, "width": 400, "height": 800}}
PANEL = {"AXIdentifier": "assistant-drawer-panel", "frame": {"x": 0, "y": 0, "width": 300, "height": 800}}


def _row(stream_id):
    return {"AXIdentifier": f"assistant-drawer-row-{stream_id}", "frame": {"x": 0, "y": 200, "width": 300, "height": 60}}


class _FakeUI:
    """A simulated app: a tap commits its UI change only after `delay_s` of JS time."""

    def __init__(self, clock, delay_s=0.2, describe_s=0.1, stall=None):
        self.clock, self.delay_s, self.describe_s = clock, delay_s, describe_s
        self.stall = stall  # (start, end) monotonic window where JS commits nothing
        self.open, self.pending, self.taps, self.points = False, None, [], []

    def _advance(self, seconds):
        self.clock.sleep(seconds)

    def _settle(self):
        if self.pending and self.clock() >= self.pending[0]:
            self.open, self.pending = self.pending[1], None

    def _commit_at(self, at):
        commit = at + self.delay_s
        if self.stall and commit > self.stall[0] and at < self.stall[1]:
            commit = max(commit, self.stall[1] + self.delay_s)
        return commit

    def elements(self):
        self._advance(self.describe_s)
        self._settle()
        rows = [_row(s) for s in S.BURST_STREAM_IDS]
        return [ROOT, BUTTON] + ([SCRIM, PANEL] + rows if self.open else [])

    def tap_point(self, x, y):
        self.taps.append((x, y))
        target = not self.open
        self.pending = (self._commit_at(self.clock()), target)

    def describe_point(self, x, y):
        self.points.append((x, y))
        return SCRIM if self.open and x >= 300 else PANEL if self.open else ROOT

    def check_foreground(self):
        return None


def test_probe_cycle_measures_js_committed_open_and_close():
    clock = _Clock()
    ui = _FakeUI(clock)
    cycle = S.probe_cycle(ui, mono=clock, wall=clock, sleep=clock.sleep, require_rows=S.BURST_STREAM_IDS)
    kinds = [t["kind"] for t in cycle["transitions"]]
    assert kinds == ["open", "close"]
    assert all(t["outcome"] == "observed" and t["pre_state_ok"] for t in cycle["transitions"])
    assert all(200 <= t["latency_ms"] <= 600 for t in cycle["transitions"])
    assert cycle["rows_present"] == list(S.BURST_STREAM_IDS)
    assert ui.taps[0] == (30, 80)            # header Sessions button centre
    assert ui.taps[1][0] >= 300              # scrim point outside the panel
    assert ui.points and ui.points[-1] == ui.taps[1]


def test_probe_matches_dynamic_sessions_label():
    for label in ["Sessions, 0 need you", "Sessions, 17 need you"]:
        assert S.SESSIONS_LABEL.fullmatch(label)
    assert not S.SESSIONS_LABEL.fullmatch("Sessions")
    assert not S.SESSIONS_LABEL.fullmatch("Questions, 2 pending")


def test_simulated_js_stall_fails_the_probe():
    """Offline fail-first: a JS stall shows as latency, never as a false response."""
    clock = _Clock()
    ui = _FakeUI(clock, stall=(clock.now, clock.now + 5.0))
    cycle = S.probe_cycle(ui, mono=clock, wall=clock, sleep=clock.sleep)
    opened = cycle["transitions"][0]
    assert opened["outcome"] == "observed" and opened["latency_ms"] >= 5000
    evidence = _evidence(cycles=[_cycle(t0) for t0 in _spread()] + [cycle])
    verdict, failures, _ = S.evaluate(evidence)
    assert verdict == "FAIL" and "responsiveness_bound" in failures


def test_probe_times_out_when_ui_never_responds():
    clock = _Clock()
    ui = _FakeUI(clock, stall=(clock.now, clock.now + 60.0))
    cycle = S.probe_cycle(ui, mono=clock, wall=clock, sleep=clock.sleep)
    assert cycle["transitions"][0]["outcome"] == "timeout"
    assert len(cycle["transitions"]) == 1  # a cycle stops at its first unresolved transition


def test_already_present_panel_is_not_a_response():
    clock = _Clock()
    ui = _FakeUI(clock)
    ui.open = True
    cycle = S.probe_cycle(ui, mono=clock, wall=clock, sleep=clock.sleep)
    assert cycle["transitions"][0]["pre_state_ok"] is False
    assert ui.taps == []


# ---- oracle ------------------------------------------------------------------

WINDOW = (1000.0, 1032.0)


def _transition(kind, t0, latency_ms=300, outcome="observed", pre=True, wall=None):
    # Host wall and monotonic clocks differ; default taps sit far from any stall window.
    return {"kind": kind, "tap_started_mono": t0, "tap_started_wall": wall if wall is not None else t0 + 10_000,
            "observed_mono": None if outcome == "timeout" else t0 + latency_ms / 1000,
            "latency_ms": None if outcome == "timeout" else latency_ms, "outcome": outcome,
            "pre_state_ok": pre, "polls": 3, "describe_ms": [100, 100, 100]}


def _cycle(t0, **kw):
    return {"started_mono": t0, "transitions": [_transition("open", t0, **kw), _transition("close", t0 + 1.0, **kw)]}


def _spread(n=6):
    step = (WINDOW[1] - WINDOW[0]) / n
    return [WINDOW[0] + 0.5 + i * step for i in range(n)]


def _evidence(cycles=None, received=None, mode="normal", stall=None, baseline_ok=True, frames=None):
    burst = S.build_burst()
    frames = frames if frames is not None else [{"stream_id": f["stream_id"], "seq": f["daemon_seq"], "acked": True, "lateness_ms": 1.0} for f in burst]
    return {
        "mode": mode,
        "baseline": {"ok": baseline_ok, "error": None if baseline_ok else "witness absent", "cycle": _cycle(900.0)},
        "frames": frames, "expected_count": S.BURST_EVENT_COUNT,
        "first_send_mono": WINDOW[0], "last_ack_mono": WINDOW[1],
        "cycles": cycles if cycles is not None else [_cycle(t0) for t0 in _spread()],
        "received": received if received is not None else [(f["stream_id"], f["daemon_seq"]) for f in burst],
        "stall": stall, "setup_errors": [],
    }


def test_oracle_passes_complete_evidence():
    verdict, failures, metrics = S.evaluate(_evidence())
    assert (verdict, failures) == ("PASS", [])
    assert metrics["delivered_count"] == 320 and metrics["burst_cycle_count"] == 6
    assert metrics["claim"] == "sampled responsiveness at probe instants; not continuous"
    assert metrics["latency_ms"]["max"] == 300


def test_oracle_failure_reasons_in_isolation():
    slow = [_cycle(t0) for t0 in _spread()]
    slow[2]["transitions"][1]["latency_ms"] = S.TRANSITION_BOUND_MS + 1
    assert S.evaluate(_evidence(cycles=slow))[1] == ["responsiveness_bound"]

    timed = [_cycle(t0) for t0 in _spread()]
    timed[3]["transitions"] = [_transition("open", timed[3]["started_mono"], outcome="timeout")]
    assert "responsiveness_timeout" in S.evaluate(_evidence(cycles=timed))[1]

    assert S.evaluate(_evidence(cycles=[_cycle(t0) for t0 in _spread(5)]))[1] == ["probe_coverage"]
    clustered = [_cycle(WINDOW[0] + 1 + i) for i in range(8)]
    assert S.evaluate(_evidence(cycles=clustered))[1] == ["probe_coverage"]

    received = [(f["stream_id"], f["daemon_seq"]) for f in S.build_burst()][1:]
    assert S.evaluate(_evidence(received=received + received))[1] == ["delivery_missing"]

    invalid = [_cycle(t0) for t0 in _spread()]
    invalid[1]["transitions"][0]["pre_state_ok"] = False
    assert S.evaluate(_evidence(cycles=invalid))[1] == ["responsiveness_invalid"]


def test_oracle_counts_duplicate_receipts_once():
    burst = S.build_burst()
    received = [(f["stream_id"], f["daemon_seq"]) for f in burst] * 2
    _verdict, _failures, metrics = S.evaluate(_evidence(received=received))
    assert metrics["delivered_count"] == 320


def test_oracle_setup_failures():
    assert S.evaluate(_evidence(baseline_ok=False))[0] == "SETUP_FAIL"
    frames = [{"stream_id": f["stream_id"], "seq": f["daemon_seq"], "acked": True, "lateness_ms": 0} for f in S.build_burst()]
    frames[10]["acked"] = False
    assert S.evaluate(_evidence(frames=frames))[0] == "SETUP_FAIL"
    assert S.evaluate(_evidence(frames=frames[:100]))[0] == "SETUP_FAIL"


def test_received_identities_come_from_event_received_telemetry():
    events = [
        TelemetryEvent("chat", "chat:event_received", "", {"stream_id": "mock-host:sample-00", "seq": 1}, 1.0, ""),
        TelemetryEvent("chat", "chat:event_received", "", {"stream_id": "mock-host:sample-00", "seq": "2"}, 1.0, ""),
        TelemetryEvent("chat", "chat:event_rendered", "", {"stream_id": "mock-host:sample-00", "seq": 3}, 1.0, ""),
        TelemetryEvent("chat", "chat:event_received", "", {"stream_id": "", "seq": 4}, 1.0, ""),
    ]
    assert S.received_identities(events) == [("mock-host:sample-00", 1), ("mock-host:sample-00", 2)]


def _stall(begin=1015.0):
    return {"begin_wall": begin, "end_wall": begin + S.STALL_MS / 1000, "stall_ms": S.STALL_MS, "skew_s": 0.2}


def test_control_mode_detects_overlapping_stall():
    stall = _stall()
    cycles = [_cycle(t0) for t0 in _spread()]
    cycles.append({"started_mono": 1015.5, "transitions": [
        _transition("open", 1015.5, latency_ms=S.STALL_MS - 400, wall=1015.5)]})
    verdict, failures, metrics = S.evaluate(_evidence(cycles=cycles, mode="stall_control", stall=stall))
    assert verdict == "FAIL" and failures == ["responsiveness_bound"]
    assert metrics["stall_control"]["exercised"] is True


def test_control_mode_requires_stall_traces_and_qualifying_tap():
    assert S.evaluate(_evidence(mode="stall_control", stall=None))[0] == "SETUP_FAIL"
    stall = _stall()
    late = S.STALL_MS - S.TRANSITION_BOUND_MS + 100
    cycles = [_cycle(t0) for t0 in _spread()]
    cycles.append({"started_mono": 1015.0 + late / 1000, "transitions": [
        _transition("open", 1015.0 + late / 1000, latency_ms=S.TRANSITION_BOUND_MS + 50, wall=1015.0 + late / 1000)]})
    verdict, failures, _ = S.evaluate(_evidence(cycles=cycles, mode="stall_control", stall=stall))
    assert verdict == "SETUP_FAIL" and failures == ["stall_control_not_exercised"]
    early = [_cycle(t0) for t0 in _spread()]
    early.append({"started_mono": 1014.9, "transitions": [_transition("open", 1014.9, latency_ms=4000, wall=1014.9)]})
    assert S.evaluate(_evidence(cycles=early, mode="stall_control", stall=stall))[1] == ["stall_control_not_exercised"]


def test_stall_traces_parse_device_wall_clock():
    events = [
        TelemetryEvent("harness", "harness:ui_trace", "", {"kind": "chat_list_js_stall_begin", "timestamp_emitter_wall": 1015000, "stall_ms": 5000}, 50.0, ""),
        TelemetryEvent("harness", "harness:ui_trace", "", {"kind": "chat_list_js_stall_end", "timestamp_emitter_wall": 1020001, "stall_ms": 5000}, 55.0, ""),
    ]
    stall = S.stall_window(events, mono_to_wall=lambda mono: mono + 965.2)
    assert stall["begin_wall"] == 1015.0 and stall["end_wall"] == 1020.001 and stall["stall_ms"] == 5000
    assert stall["skew_s"] == pytest.approx(0.2)  # host receipt minus device emit, same clock on a simulator
    assert S.stall_window(events[:1], mono_to_wall=lambda mono: mono) is None


# ---- live run() wiring, offline ---------------------------------------------

class _RealClock:
    def __call__(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(max(0.0, seconds))


class _FakeStream:
    def __init__(self):
        self.lock, self.events = threading.Lock(), [
            TelemetryEvent("chat", "chat:ws_open", "", {}, time.monotonic(), "")]

    def add(self, message, data):
        with self.lock:
            self.events.append(TelemetryEvent(message.split(":")[0], message, "", data, time.monotonic(), ""))

    def all_events(self):
        with self.lock:
            return list(self.events)

    def next_event(self, timeout_s=0):
        time.sleep(min(timeout_s, 0.01))
        return None


def _live_app(stream, ui, stop):
    """A fake app: logs chat:event_received per event; the trigger stalls the fake UI."""
    loop = asyncio.new_event_loop()
    state, ready = {}, threading.Event()

    async def main():
        daemon = mvd.MockDaemon(_args(0, ""))
        server = await serve(daemon.handler, "127.0.0.1", 0, max_size=None)
        state["url"] = f"ws://127.0.0.1:{next(iter(server.sockets)).getsockname()[1]}"
        async with websockets.connect(state["url"], max_size=None) as app:
            await app.recv()
            await app.send(json.dumps({"type": "hello", "client": "pentacle-mobile", "subscribe": {"snapshot": True}}))
            ready.set()
            while not stop.is_set():
                try:
                    frame = json.loads(await asyncio.wait_for(app.recv(), timeout=0.2))
                except asyncio.TimeoutError:
                    continue
                if frame.get("type") != "chat.event":
                    continue
                event = frame["event"]
                if event["stream_id"] == S.TRIGGER_STREAM_ID:
                    begin = time.time()
                    ui.stall = (time.monotonic(), time.monotonic() + S.STALL_MS / 1000)
                    stream.add("harness:ui_trace", {"kind": "chat_list_js_stall_begin", "stall_ms": S.STALL_MS,
                                                    "timestamp_emitter_wall": begin * 1000})
                    stream.add("harness:ui_trace", {"kind": "chat_list_js_stall_end", "stall_ms": S.STALL_MS,
                                                    "timestamp_emitter_wall": (begin + S.STALL_MS / 1000) * 1000})
                elif event["stream_id"] in S.BURST_STREAM_IDS:
                    stream.add("chat:event_received", {"stream_id": event["stream_id"], "seq": event["daemon_seq"]})
        server.close()
        await server.wait_closed()

    thread = threading.Thread(target=lambda: loop.run_until_complete(main()), daemon=True)
    thread.start()
    assert ready.wait(10)
    return state["url"], thread


@pytest.mark.parametrize("run_mode,expected", [("normal", "PASS"), ("stall_control", "FAIL")])
def test_run_drives_burst_probes_and_control_end_to_end(monkeypatch, run_mode, expected):
    monkeypatch.setattr(S, "STALL_MS", 900)
    monkeypatch.setattr(S, "TRANSITION_BOUND_MS", 400)
    monkeypatch.setattr(S, "TRANSITION_TIMEOUT_MS", 3000)
    # The pacing schedule, not loopback ack latency (~50 ms on macOS, ~0 on
    # Linux), sets the burst window: sends are at least interval_s apart, so 80
    # frames span >= 3.95 s on any host, which is room for many fake-UI cycles.
    interval_s = 0.05
    monkeypatch.setattr(S, "EVENTS_PER_STREAM", 10)
    monkeypatch.setattr(S, "BURST_EVENT_COUNT", 80)
    fast = S.run_injector
    monkeypatch.setattr(S, "run_injector", lambda control, frames, **kw: fast(control, frames, interval_s=interval_s, **kw))
    stream, stop = _FakeStream(), threading.Event()
    ui = _FakeUI(_RealClock(), delay_s=0.02, describe_s=0.004)
    url, thread = _live_app(stream, ui, stop)
    monkeypatch.setattr(S, "_DrawerUI", lambda config: ui)
    try:
        verdict = S.run({"ws_url": url, "PENTACLE_ALL_CHATS_MODE": run_mode}, stream)
    finally:
        stop.set()
        thread.join(10)
    extras = verdict.extras
    assert verdict.verdict == expected, (verdict.error, extras.get("setup_errors"))
    assert extras["delivered_count"] == extras["expected_count"] == 80 and extras["claim"] == S.CLAIM
    sent = [frame["sent_mono"] for frame in extras["frames"]]
    assert sent[-1] - sent[0] >= 79 * interval_s - 1e-6
    assert extras["burst_cycle_count"] >= S.MIN_BURST_CYCLES
    if run_mode == "stall_control":
        assert extras["stall_control"]["exercised"] is True
        assert verdict.error in {"responsiveness_bound", "responsiveness_timeout", "responsiveness_bound; responsiveness_timeout"}
