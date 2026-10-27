"""Offline actual-entry controls. All targets/credentials/transports are synthetic."""
import asyncio
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, quote, urlsplit

import pytest
import run_scenario as runner
from e2e.scenarios import m1_configured_roster_history as m1
from e2e.scenarios import nexus_agents_history_questions as mock
from e2e.harness.log_capture import LogStream
from e2e.harness.telemetry_events import TelemetryEvent


@pytest.fixture(autouse=True)
def effect_traps(monkeypatch):
    # Event-loop self-pipe is setup, before traps; subject code cannot open sockets.
    loop = asyncio.new_event_loop()
    def forbidden(*a, **k):
        raise AssertionError("unexpected external effect")
    monkeypatch.setattr(asyncio, "run", loop.run_until_complete)
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(m1.auth, "OperatorCredentialRegistry", forbidden)
    yield
    loop.close()


@pytest.fixture
def supplied(tmp_path, monkeypatch):
    token = m1.auth.encode_envelope("00000000-0000-4000-8000-000000000001", "pentacle-mobile", bytes(range(32)))
    path = tmp_path / "fake-token"
    path.write_text(token)
    path.chmod(0o600)
    monkeypatch.setenv("PENTACLE_SCENARIO_DEVICE_SET_ROOT", "/synthetic/owned-devices")
    config = {"PENTACLE_SCENARIO_DEVICE_SET_ROOT": "/synthetic/owned-devices",
              "PENTACLE_GATE_BOUND_SIMULATOR_UDID": "12345678-1234-1234-1234-123456789abc",
              "PENTACLE_GATE_BOUND_BUNDLE_ID": "com.example.synthetic.harness",
              "PENTACLE_DAEMON_WS_URL": "wss://example.invalid:443/ws", "daemon_token_file": str(path),
              "scenario_run_id": "owned-run", "m1_host": "hostx", "m1_parent_stream_id": "hostx:owned-parent",
              "m1_child_stream_id": "hostx:owned-child", "m1_parent_generation": "parent-generation",
              "m1_child_generation": "child-generation", "m1_child_name": "Owned worker",
              "m1_expected_rows": json.dumps([{"row_id": "tell:owned-row", "text": "Owned synthetic history."}])}
    return config, token, path


def wire(config):
    value = m1.inputs(config)
    parent = {"stream_id": config["m1_parent_stream_id"], "host": "hostx", "role": "nexus",
              "session_generation": config["m1_parent_generation"], "agents": [{
                  "stream_id": config["m1_child_stream_id"], "session_generation": config["m1_child_generation"],
                  "display_name": config["m1_child_name"]}]}
    reply = {"type": "thread.read.ok", "ok": True, "next_cursor": None,
             **{key: config["m1_" + key] for key in ("parent_stream_id", "child_stream_id", "parent_generation", "child_generation")},
             "rows": [{**row, "truncated": False} for row in value["rows"]]}
    return parent, reply


class FakeSocket:
    def __init__(self, config, mutate=None):
        parent, self.reply = wire(config)
        self.frames = [{"type": "welcome", "auth": {"operator": {"protocol_version": 2,
            "scheme": m1.auth.AUTH_SCHEME, "nonce": m1.auth.encode_b64url(bytes(reversed(range(32)))),
            "expires_at": time.time() + 30}}}, {"type": "hello"}, {"type": "snapshot", "sessions": [parent]}]
        if mutate:
            mutate(self.frames, self.reply)
        self.sent, self.closed = [], False
    async def __aenter__(self): return self
    async def __aexit__(self, *args): self.closed = True
    async def recv(self):
        if self.frames: return json.dumps(self.frames.pop(0))
        return json.dumps(self.reply)
    async def send(self, text):
        msg = json.loads(text)
        assert msg["type"] in {"hello", "thread.read"}
        self.sent.append(msg)
        if msg["type"] == "thread.read": self.reply["request_id"] = msg["request_id"]


def test_actual_observer_mobile_proof_inventory_and_history(supplied):
    config, token, _ = supplied
    ws = FakeSocket(config)
    observed = asyncio.run(m1.observe(config, token, connect=lambda *a, **k: ws))
    assert ws.closed and len(ws.sent) == 2
    hello = ws.sent[0]
    assert hello["capabilities"] == dict.fromkeys(("assistant_composite_v1", "work_lanes_v1", "consent_enrollment_offer_v1", "consent_open_v1"), True)
    assert hello["client"] == "pentacle-mobile" and hello["subscribe"]["include_subagents"] is False
    assert hello["auth_v2"]["proof"] == m1.auth.make_proof(bytes(range(32)), m1.auth.encode_b64url(bytes(reversed(range(32)))), "00000000-0000-4000-8000-000000000001", "pentacle-mobile")
    assert observed["parent_generation"] == config["m1_parent_generation"]
    assert not any("rows" in key for key in observed)


@pytest.mark.parametrize("defect", ["parent_missing", "parent_generation", "not_nexus", "child_generation", "wrong_child", "wrong_name", "extra_child", "denied", "wrong_pair", "stale_history", "wrong_row_id", "wrong_text", "empty_history", "truncated", "older_page", "malformed_challenge", "missing_ack"])
def test_actual_observer_refuses_unowned_stale_denied_or_missing(supplied, defect):
    config, token, _ = supplied
    def mutate(frames, reply):
        parent = frames[2]["sessions"][0]
        child = parent["agents"][0]
        if defect == "parent_missing": frames[2]["sessions"] = []
        elif defect == "parent_generation": parent["session_generation"] = "stale"
        elif defect == "not_nexus": parent["role"] = "lead"
        elif defect == "child_generation": child["session_generation"] = "stale"
        elif defect == "wrong_child": child["stream_id"] = "hostx:other"
        elif defect == "wrong_name": child["display_name"] = "Other worker"
        elif defect == "extra_child": parent["agents"].append(dict(child))
        elif defect == "denied": reply.update(type="thread.error", ok=False)
        elif defect == "wrong_pair": reply["child_stream_id"] = "hostx:other"
        elif defect == "stale_history": reply["parent_generation"] = "stale"
        elif defect == "wrong_row_id": reply["rows"][0]["row_id"] = "tell:other"
        elif defect == "wrong_text": reply["rows"][0]["text"] = "Other synthetic text"
        elif defect == "empty_history": reply["rows"] = []
        elif defect == "truncated": reply["rows"][0]["truncated"] = True
        elif defect == "older_page": reply["next_cursor"] = "old"
        elif defect == "malformed_challenge": frames[0]["auth"]["operator"]["nonce"] = "bad"
        elif defect == "missing_ack": frames.pop(1)
    ws = FakeSocket(config, mutate)
    with pytest.raises(m1.ConfiguredError):
        asyncio.run(m1.observe(config, token, connect=lambda *a, **k: ws))
    assert ws.closed


@pytest.mark.parametrize("key,value", [("m1_parent_stream_id", "hostx:a:b"), ("m1_host", "other"), ("m1_child_stream_id", "hostx:owned-parent"), ("m1_parent_generation", ""), ("m1_child_generation", "with space"), ("m1_expected_rows", "[]"), ("m1_expected_rows", '[{"row_id":"tell:a","text":""}]'), ("m1_extra", "bad"), ("m1_child_name", "\n"), ("PENTACLE_DAEMON_WS_URL", "ws://example.invalid:1234"), ("PENTACLE_DAEMON_WS_URL", "wss://user:pass@example.invalid:443"), ("PENTACLE_DAEMON_WS_URL", "wss://example.invalid:443?token=bad"), ("PENTACLE_DAEMON_WS_URL", "wss://example.invalid"), ("PENTACLE_DAEMON_WS_URL", "wss://example.invalid:99999"), ("daemon_token_file", "relative"), ("actions", "resolve_notification"), ("runtime_sentinel", "fatal")])
def test_actual_native_entry_invalid_inputs_before_any_effect(tmp_path, supplied, monkeypatch, key, value):
    config, _, _ = supplied
    config[key] = value
    def forbidden(*a, **k): raise AssertionError("input validation reached credential/native/observer effect")
    monkeypatch.setattr(runner, "_read_dashboard_token", forbidden)
    monkeypatch.setattr(m1, "observe", forbidden)
    with pytest.raises(m1.ConfiguredError):
        runner.execute_native(m1.name, config, tmp_path, "invalid")
    assert not (tmp_path / "invalid.ui.jsonl").exists()


@pytest.mark.parametrize("defect", ["symlink", "mode", "directory", "fifo", "oversize", "invalid", "cli_kind"])
def test_fake_credential_file_refused_before_native_and_socket(tmp_path, supplied, monkeypatch, defect):
    config, _, token_path = supplied
    if defect == "symlink":
        link = tmp_path / "token-link"; link.symlink_to(token_path); config["daemon_token_file"] = str(link)
    elif defect == "mode": token_path.chmod(0o644)
    elif defect == "directory": config["daemon_token_file"] = str(tmp_path)
    elif defect == "fifo":
        fifo = tmp_path / "token-fifo"; os.mkfifo(fifo, 0o600); config["daemon_token_file"] = str(fifo)
    elif defect == "oversize": token_path.write_text("x" * 65537)
    elif defect == "invalid": token_path.write_text("not-an-envelope")
    elif defect == "cli_kind": token_path.write_text(m1.auth.encode_envelope("00000000-0000-4000-8000-000000000001", "pentacle", bytes(range(32))))
    def forbidden(*a, **k): raise AssertionError("invalid credential reached observer")
    monkeypatch.setattr(m1, "observe", forbidden)
    with pytest.raises(m1.ConfiguredError, match="credential file/envelope invalid"):
        runner.execute_native(m1.name, config, tmp_path, "invalid")


def native_rehearsal(tmp_path, config, token, monkeypatch, *, fault=None, bad_ui=None, cli=False):
    if cli:
        config["scenario_run_id"] = "candidate"
    state = {"launched": False, "stream_closed": False, "video_closed": False}
    sockets, launches = [], []
    real_observe = m1.observe
    def connect(*args, **kwargs):
        ws = FakeSocket(config); sockets.append(ws); return ws
    monkeypatch.setattr(m1, "observe", lambda cfg, tok: real_observe(cfg, tok, connect=connect))
    def line(message, data, pid=91):
        return json.dumps({"processID": pid, "eventMessage": "[TELEMETRY] " + json.dumps({"message": message, "data": data})}) + "\n"
    class Logs(LogStream):
        def start(self):
            self.output = self.raw_path.open("w", encoding="utf-8")
            self.output.write("UNRELATED_USER_TRANSCRIPT " + token)
            self.feed_line(line("harness:harness_armed", {"scenario": m1.name, "scenario_run_id": config["scenario_run_id"]}))
            self.feed_line(line("harness:ui_trace", {"kind": "unrelated", "text": "UNRELATED_USER_TRANSCRIPT"}))
            data = [("store_state_transition", {"connected": True, "connecting": False, "has_hydrated": True}),
                    ("nexus_agents_roster_rendered", {"child_stream_ids": [config["m1_child_stream_id"]], "child_names": [config["m1_child_name"]]}),
                    ("nexus_agents_history_rendered", {"parent_stream_id": config["m1_parent_stream_id"], "child_stream_id": config["m1_child_stream_id"], "row_ids": ["tell:owned-row"], "row_texts": ["Owned synthetic history."]})]
            for kind, fields in data:
                if bad_ui == "content" and kind.endswith("history_rendered"): fields["row_ids"] = ["tell:other"]
                if bad_ui == "hydration" and kind == "store_state_transition": fields["has_hydrated"] = False
                if bad_ui == "missing_connection_field" and kind == "store_state_transition": fields.pop("connecting")
                if bad_ui == "run": fields["scenario_run_id"] = "other-run"
                self.feed_line(line("harness:ui_trace", {"kind": kind, **fields}, pid=77 if bad_ui == "pid" else 91))
            if bad_ui == "later_content":
                self.feed_line(line("harness:ui_trace", {"kind": "nexus_agents_history_rendered", "parent_stream_id": config["m1_parent_stream_id"],
                    "child_stream_id": config["m1_child_stream_id"], "row_ids": ["tell:other"], "row_texts": ["unrelated"]}))
            if bad_ui == "prearm":
                for event in self.events[1:]: event.received_at = self.events[0].received_at - 1
            return self
        def close(self):
            state["stream_closed"] = True
            self.output.close()
            if fault == "cleanup": raise RuntimeError("whole config must not survive " + token)
    class Video:
        def __init__(self, *args, **kwargs): self.process = None
        def start(self): self.process = object(); return True
        def stop(self):
            state["video_closed"] = True
            return {"video_finalized": True, "video_alive_after_teardown": False, "video_forced_kill": False,
                    "video_unavailable_reason": token}
    def native(argv, **kwargs):
        args = argv[4:]
        assert argv[:4] == ["xcrun", "simctl", "--set", config["PENTACLE_SCENARIO_DEVICE_SET_ROOT"]]
        if args[0] == "launch":
            launches.append(parse_qs(urlsplit(args[-1]).query))
            if fault == "launch": raise subprocess.TimeoutExpired(argv, 30, output=token, stderr=token)
            state["launched"] = True
            output = config["PENTACLE_GATE_BOUND_BUNDLE_ID"] + ": 91\n"
        elif args[0] == "terminate": state["launched"] = False; output = ""
        elif args[0] == "spawn": output = ("91 0 UIKitApplication:" + config["PENTACLE_GATE_BOUND_BUNDLE_ID"] + "[owned]\n") if state["launched"] else ""
        elif args[0] == "io": Path(args[-1]).write_bytes(b"owned synthetic image"); output = ""
        else: raise AssertionError("unexpected native command")
        return subprocess.CompletedProcess(argv, 0, output, token + " UNRELATED_USER_TRANSCRIPT")
    monkeypatch.setattr(runner, "LogStream", Logs)
    monkeypatch.setattr(runner, "VideoRecorder", Video)
    monkeypatch.setattr(subprocess, "run", native)
    # Subject timeouts advance instantly under missing-evidence controls.
    real_clock = time.monotonic
    if bad_ui:
        ticks = iter(range(1000)); monkeypatch.setattr(m1.time, "monotonic", lambda: real_clock() + next(ticks))
    monkeypatch.setattr(runner.time, "sleep", lambda *_: None)
    if cli:
        env = tmp_path / "synthetic.env"
        env.write_text("\n".join(key + "=" + value for key, value in config.items()))
        monkeypatch.setenv("PENTACLE_RUN_ID", "candidate")
        assert runner.main([m1.name, "--env-file", str(env), "--runs-dir", str(tmp_path)]) == 0
        payload = json.loads((tmp_path / "candidate.json").read_text())
        proof = json.loads((tmp_path / "candidate.teardown.json").read_text())
    else:
        payload, proof = runner.execute_native(m1.name, config, tmp_path, "candidate")
    serialized = json.dumps({"payload": payload, "proof": proof})
    retained = serialized + "".join(p.read_text(errors="replace") for p in tmp_path.glob("candidate*") if p.suffix != ".png")
    mask = runner._SecretMask(token, m1.auth.encode_b64url(bytes(range(32))))
    assert bool(mask(retained) == retained), "credential survived emitted evidence"
    assert "UNRELATED_USER_TRANSCRIPT" not in retained
    assert state["stream_closed"] and state["video_closed"]
    assert all(ws.closed for ws in sockets)
    assert not state["launched"]
    return payload, proof, launches, sockets


@pytest.mark.parametrize("fault,verdict", [(None, "PASS"), ("launch", "SETUP_FAIL"), ("cleanup", "SETUP_FAIL")])
def test_actual_entry_query_oracle_capture_and_cleanup(tmp_path, supplied, monkeypatch, capsys, fault, verdict):
    config, token, _ = supplied
    payload, proof, launches, sockets = native_rehearsal(tmp_path, config, token, monkeypatch, fault=fault)
    assert payload["verdict"] == verdict
    query = launches[0]
    assert query["actions"] == ["open_existing_chat"]
    assert query["stream_id"] == [config["m1_parent_stream_id"]] and query["agentHistory"] == [config["m1_child_stream_id"]]
    assert query["agentHistoryGeneration"] == [config["m1_child_generation"]] and query["ws_url"] == [config["PENTACLE_DAEMON_WS_URL"]]
    assert bool(query["pentacle_token"] == [token])
    assert "disable_pentacle_auth" not in query and "text" not in query
    if fault == "launch":
        assert proof["attempted"] == proof["orphan_count"] == 1
    if not fault:
        assert len(sockets) == 2 and proof["attempted"] == proof["closed_count"] == 1
        assert payload["result"]["extras"]["rendered_rows"] == m1.inputs(config)["rows"]
    captured = capsys.readouterr()
    assert bool(token not in captured.out + captured.err)


@pytest.mark.parametrize("bad_ui", ["pid", "run", "prearm", "content", "hydration", "missing_connection_field", "later_content"])
def test_actual_entry_does_not_pass_unbound_or_wrong_content(tmp_path, supplied, monkeypatch, bad_ui):
    config, token, _ = supplied
    payload, _, _, sockets = native_rehearsal(tmp_path, config, token, monkeypatch, bad_ui=bad_ui)
    assert payload["verdict"] == "FAIL" and len(sockets) == 1


class Sink(io.StringIO):
    def close(self): self.retained = self.getvalue(); super().close()


def test_secret_mask_stream_all_splits_encoding_and_safe_content():
    secret = 'SYNTHETIC_ONLY:/capture?"x'
    mask = runner._SecretMask(secret)
    forms = [secret, quote(secret, safe=""), quote(secret, safe="").replace("%3A", "%3a").replace("%2F", "%2f"),
             json.dumps(secret)[1:-1], json.dumps(json.dumps(secret)[1:-1])[1:-1],
             "".join("\\u%04x" % ord(c) for c in secret), "".join("%%%02X" % b for b in secret.encode())]
    for form in forms:
        for split in range(len(form) + 1):
            sink = Sink(); writer = runner._SecretSafeWriter(sink, mask)
            writer.write("owned identity before " + form[:split]); writer.flush()
            writer.write(form[split:] + " owned identity after"); writer.close()
            assert bool(secret not in sink.retained and form not in sink.retained)
            assert "owned identity before " in sink.retained and " owned identity after" in sink.retained


def test_outer_cli_error_does_not_dump_config_or_exception(tmp_path, supplied):
    config, token, _ = supplied
    env = tmp_path / "synthetic.env"
    env.write_text("\n".join(key + "=" + value for key, value in config.items()))
    def failing(*args): raise RuntimeError("entire config and token " + token)
    output = tmp_path / "runs"
    assert runner.main([m1.name, "--env-file", str(env), "--runs-dir", str(output)], execute=failing) == 4
    retained = "".join(p.read_text() for p in output.iterdir())
    assert bool(token not in retained) and "entire config" not in retained
    assert "configured M1 setup failed" in retained


def test_existing_mock_and_dashboard_mask_are_preserved(supplied):
    config, _, _ = supplied
    assert mock.actions(config) == ["autoaccept_biometric", "open_existing_chat", "resolve_notification"]
    assert mock.params(config)["agentHistory"] == "mock-host:child-worker"
    mask = runner._SecretMask("synthetic-dashboard:/credential")
    result = runner._sanitize_command_result(subprocess.CompletedProcess(["launch", "synthetic-dashboard:/credential"], 1, quote("synthetic-dashboard:/credential", safe=""), "safe identity error"), mask)
    assert result.stderr == "safe identity error"
    assert result.args == ["launch", "[REDACTED]"] and result.stdout == "[REDACTED]"


def test_actual_cli_configured_success_with_owned_fake_inputs(tmp_path, supplied, monkeypatch):
    config, token, _ = supplied
    payload, proof, launches, sockets = native_rehearsal(tmp_path, config, token, monkeypatch, cli=True)
    assert payload["verdict"] == "PASS" and proof["orphan_count"] == 0 and len(sockets) == 2


def test_invalid_owner_and_duplicate_row_fields_before_effects(tmp_path, supplied, monkeypatch):
    config, _, path = supplied
    original = runner.os.fstat
    def foreign(fd):
        info = original(fd)
        return SimpleNamespace(st_mode=info.st_mode, st_uid=os.getuid() + 1)
    monkeypatch.setattr(runner.os, "fstat", foreign)
    with pytest.raises(m1.ConfiguredError):
        runner.execute_native(m1.name, config, tmp_path, "foreign")
    monkeypatch.setattr(runner.os, "fstat", original)
    config["m1_expected_rows"] = '[{"row_id":"tell:a","row_id":"tell:b","text":"synthetic"}]'
    with pytest.raises(m1.ConfiguredError): m1.inputs(config)


def test_context_stdout_stderr_and_observer_cleanup_are_secret_safe(tmp_path, supplied, monkeypatch, capsys):
    config, token, _ = supplied
    real_observe = m1.observe
    class BrokenClose(FakeSocket):
        async def __aexit__(self, *args):
            self.closed = True
            raise RuntimeError("whole config " + token)
    ws = BrokenClose(config)
    async def observe(cfg, tok):
        print(tok[:100], end="")
        print(tok[100:], end="")
        print(quote(tok, safe="")[:120], file=sys.stderr, end="")
        print(quote(tok, safe="")[120:], file=sys.stderr, end="")
        return await real_observe(cfg, tok, connect=lambda *a, **k: ws)
    monkeypatch.setattr(m1, "observe", observe)
    with pytest.raises(m1.ConfiguredError, match="transport/challenge/cleanup failed"):
        runner.execute_native(m1.name, config, tmp_path, "cleanup")
    assert ws.closed
    captured = capsys.readouterr()
    mask = runner._SecretMask(token)
    assert bool(mask(captured.out + captured.err) == captured.out + captured.err)
    assert "[REDACTED]" in captured.out and "[REDACTED]" in captured.err


def test_existing_dashboard_native_path_masks_real_trace_and_log_sinks(tmp_path, supplied, monkeypatch):
    config, token, _ = supplied
    config.update(PENTACLE_DAEMON_WS_URL="ws://127.0.0.1:18791", dashboard_catalog_spec_id="example__dashboard_reports",
                  daemon_token_owner_stream_id="hostx:owned-app")
    # Exercise the existing native phase and mask boundaries without idb/UI work.
    monkeypatch.setenv("IDB_COMPANION", "synthetic-unconnected-companion")
    original = runner.DashboardCatalogScenario
    class Catalog(original):
        def run(self, *args): return runner.Verdict("dashboard_catalog", "PASS").finish()
    monkeypatch.setattr(runner, "DashboardCatalogScenario", Catalog)
    launched = [False]
    class Logs(LogStream):
        def start(self):
            self.output = self.raw_path.open("w", encoding="utf-8")
            self.output.write(token[:100]); self.output.write(token[100:])
            self.feed_line(json.dumps({"processID": 91, "eventMessage": "[TELEMETRY] " + json.dumps({
                "message": "harness:harness_armed", "data": {"scenario_run_id": config["scenario_run_id"], "scenario": "dashboard_catalog"}})}))
        def close(self): self.output.close()
    class Video:
        process = None
        def __init__(self, *args, **kwargs): pass
        def start(self): return True
    def native(argv, **kwargs):
        args = argv[4:]
        if args[0] == "launch": launched[0] = True; output = config["PENTACLE_GATE_BOUND_BUNDLE_ID"] + ": 91"
        elif args[0] == "terminate": launched[0] = False; output = ""
        elif args[0] == "spawn": output = "91 0 UIKitApplication:" + config["PENTACLE_GATE_BOUND_BUNDLE_ID"] + "[owned]" if launched[0] else ""
        elif args[0] == "io": Path(args[-1]).write_bytes(b"synthetic image"); output = ""
        else: raise AssertionError("unexpected native effect")
        return subprocess.CompletedProcess(argv, 0, output, token)
    monkeypatch.setattr(runner, "LogStream", Logs)
    monkeypatch.setattr(runner, "VideoRecorder", Video)
    monkeypatch.setattr(subprocess, "run", native)
    monkeypatch.setattr(time, "sleep", lambda *_: None)
    payload, proof = runner.execute_native("dashboard_catalog", config, tmp_path, "dashboard", _catalog_phase="configured")
    retained = json.dumps(payload) + "".join(p.read_text() for p in tmp_path.glob("dashboard*") if p.suffix != ".png")
    mask = runner._SecretMask(token)
    assert bool(mask(retained) == retained) and "[REDACTED]" in retained
    assert payload["verdict"] == "PASS" and proof["closed_count"] == 1


def test_projection_refuses_unverified_arming_and_native_envelope(supplied):
    config, _, _ = supplied
    def raw(pid, run):
        return json.dumps({"processID": pid, "eventMessage": "[TELEMETRY] " + json.dumps({
            "message": "harness:harness_armed", "data": {"scenario": m1.name, "scenario_run_id": run}})})
    assert m1.filtered_line(raw(91, "other-run"), config) is None
    assert m1.filtered_line(raw({"text": "unrelated"}, config["scenario_run_id"]), config) is None
    assert m1.filtered_line(raw(91, config["scenario_run_id"]), config) is not None
