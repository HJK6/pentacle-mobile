"""Unit tests for the standalone v2-wire mock daemon (`tools/mock_v2_daemon.py`).

Boots the daemon in-process on an ephemeral port and drives it over a real
websocket, asserting the app-facing v2 contract (welcome / operator-auth-v2 /
ready / snapshot / request_stream_events / chat.event) and the harness
debug-replay injection seam. Owned by
spec_pentacle_mobile__scripted_v2_mock_daemon_harness_2026_09.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

import _mock_operator_auth as operator_auth  # noqa: E402
import mock_v2_daemon as mvd  # noqa: E402
import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402


def _args(port: int, registry: str) -> argparse.Namespace:
    return argparse.Namespace(
        port=port, bind="127.0.0.1", host="mock-host",
        credential_registry=registry, recent_limit=20000, enable_debug_replay_ws=True,
    )


async def _boot(registry_path: Path):
    daemon = mvd.MockDaemon(_args(0, str(registry_path)))
    server = await serve(daemon.handler, "127.0.0.1", 0, max_size=None)
    port = next(iter(server.sockets)).getsockname()[1]
    return daemon, server, f"ws://127.0.0.1:{port}"


async def _app_hello(ws, cred_id: str, envelope: str, *, subscribe: dict) -> dict:
    welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
    assert welcome["type"] == "welcome"
    op = welcome["auth"]["operator"]
    assert op["scheme"] == operator_auth.AUTH_SCHEME
    nonce = op["nonce"]
    env = operator_auth.decode_envelope(envelope)
    proof = hmac.new(env["proof_key"], operator_auth.proof_transcript(nonce, cred_id, "pentacle-mobile"), hashlib.sha256).digest()
    await ws.send(json.dumps({
        "type": "hello", "client": "pentacle-mobile",
        "auth_v2": {"scheme": operator_auth.AUTH_SCHEME, "credential_id": cred_id, "proof": operator_auth.encode_b64url(proof)},
        "subscribe": subscribe,
    }))
    return welcome


async def _harness_hello(ws) -> None:
    welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
    assert welcome["type"] == "welcome"
    await ws.send(json.dumps({"type": "hello", "client": "harness", "token": None, "subscribe": {"mode": "rpc", "snapshot": False}}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
    assert ready["type"] == "ready"


@pytest.fixture()
def registry(tmp_path):
    d = tmp_path / "cfg"
    d.mkdir(mode=0o700)
    reg = operator_auth.OperatorCredentialRegistry(d / "creds.json")
    cred_id, envelope = reg.issue("pentacle-mobile", label="test")
    return reg, cred_id, envelope, d / "creds.json"


def test_app_auth_and_snapshot(registry):
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, open_timeout=5, max_size=None) as ws:
                await _app_hello(ws, cred_id, envelope, subscribe={"snapshot": True, "events_mode": "full"})
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert frame["type"] == "hello"
                snap = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert snap["type"] == "snapshot"
                assert isinstance(snap["sessions"], list)
                assert "limits" in snap
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_app_auth_rejects_bad_proof(registry):
    _reg, cred_id, _envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, open_timeout=5, max_size=None) as ws:
                welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                nonce = welcome["auth"]["operator"]["nonce"]
                bad = operator_auth.encode_b64url(b"\x00" * operator_auth.AUTH_PROOF_BYTES)
                await ws.send(json.dumps({"type": "hello", "client": "pentacle-mobile",
                    "auth_v2": {"scheme": operator_auth.AUTH_SCHEME, "credential_id": cred_id, "proof": bad},
                    "subscribe": {"snapshot": True}}))
                err = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert err["type"] == "hello.error"
                assert err["error_code"] == "operator_auth_invalid"
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_debug_event_broadcasts_chat_event(registry):
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
                await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
                # drain app bootstrap frames (hello, snapshot, hosts.stats)
                for _ in range(3):
                    await asyncio.wait_for(app.recv(), timeout=5)
                await _harness_hello(harness)
                event = {"stream_id": "mock-host:mock-session", "host": "mock-host", "provider": "codex",
                         "session_id": "", "session_name": "mock-session", "daemon_seq": 21,
                         "timestamp": "2026-07-03T16:00:21Z", "kind": "USER", "text": "hi", "raw": {"source": "terminal"}}
                await harness.send(json.dumps({"type": "debug_replay_event", "request_id": "r1", "event": event}))
                ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert ack["type"] == "debug_replay_event.ack" and ack["status"] == "ok"
                pushed = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert pushed["type"] == "chat.event"
                assert pushed["event"]["daemon_seq"] == 21
                assert pushed["event"]["stream_id"] == "mock-host:mock-session"
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_seed_history_and_cold_open(registry):
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as harness:
                await _harness_hello(harness)
                events = [{"stream_id": "mock-host:s1", "host": "mock-host", "session_name": "s1",
                           "daemon_seq": i, "timestamp": "2026-07-03T16:00:00Z", "kind": "ASSIST",
                           "text": f"e{i}", "raw": {}} for i in range(1, 6)]
                await harness.send(json.dumps({"type": "debug_replay_notification", "request_id": "seed1",
                    "notification": {"producer": mvd.SEED_HISTORY_PRODUCER, "stream_id": "mock-host:s1", "events": events}}))
                ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert ack["status"] == "ok" and ack["seeded"] == 5
            async with websockets.connect(url, max_size=None) as app:
                await _app_hello(app, cred_id, envelope, subscribe={"mode": "rpc", "snapshot": False})
                ready = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert ready["type"] == "ready"
                await app.send(json.dumps({"type": "request_stream_events", "request_id": "q1",
                    "host": "mock-host", "session_name": "s1", "limit": 500}))
                resp = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert resp["type"] == "request_stream_events.ok"
                assert resp["complete"] is True
                assert [e["daemon_seq"] for e in resp["events"]] == [1, 2, 3, 4, 5]
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_broadcast_skips_pre_handshake_connection(registry):
    """Regression for the all_chats_freeze burst-phase symptom-2 race
    (`unexpected daemon ready frame (daemon_seq N)`): a burst injector connects,
    reads `welcome`, and — before its own `hello` is dispatched — the daemon
    receives a live event on another connection. A freshly-connected socket is
    `client_kind=None, authorized=True` (no auth gate); broadcasting an app frame
    into that pre-handshake window landed a `chat.event` on the injector's socket
    ahead of its own `ready`, breaking the `welcome -> hello -> ready` handshake.
    The injector's very next frame after `hello` must be `ready`, never a
    broadcast."""
    _reg, _cred_id, _envelope, reg_path = registry

    async def scenario():
        _daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as injector, \
                    websockets.connect(url, max_size=None) as broadcaster:
                # Burst injector connects and reads welcome, but does NOT hello yet.
                welcome = json.loads(await asyncio.wait_for(injector.recv(), timeout=5))
                assert welcome["type"] == "welcome"
                # A separate harness connection injects a live event mid-flood.
                await _harness_hello(broadcaster)
                event = {"stream_id": "mock-host:freeze-49", "host": "mock-host",
                         "provider": "codex", "session_name": "freeze-49", "daemon_seq": 1027,
                         "timestamp": "2026-07-12T12:00:00Z", "kind": "ASSIST", "text": "x", "raw": {}}
                await broadcaster.send(json.dumps({"type": "debug_replay_event", "request_id": "b1", "event": event}))
                ack = json.loads(await asyncio.wait_for(broadcaster.recv(), timeout=5))
                assert ack["type"] == "debug_replay_event.ack" and ack["status"] == "ok"
                # Now the injector completes its handshake exactly as
                # multi_stream_scripted_replay.inject() does: hello, then the next
                # frame MUST be `ready` (no leaked chat.event ahead of it).
                await injector.send(json.dumps({"type": "hello", "client": "harness",
                    "token": None, "subscribe": {"mode": "rpc", "snapshot": False}}))
                frame = json.loads(await asyncio.wait_for(injector.recv(), timeout=5))
                assert frame["type"] == "ready", (
                    f"pre-handshake injector received {frame.get('type')!r} "
                    f"(daemon_seq={(frame.get('event') or {}).get('daemon_seq')}) before its ready"
                )
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_daemon_stats_counts_clients(registry):
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
                await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
                for _ in range(3):
                    await asyncio.wait_for(app.recv(), timeout=5)
                await _harness_hello(harness)
                await harness.send(json.dumps({"type": "daemon.stats", "request_id": "s1"}))
                stats = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert stats["type"] == "daemon.stats.ok"
                assert stats["stats"]["clients"].get("pentacle-mobile") == 1
                assert stats["stats"]["clients"].get("harness") == 1
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def _question_notification(actions: list[dict]) -> dict:
    return {"producer": "agent_question.v1", "severity": "info", "title": "Mock durable question",
            "body": "Answer it.", "actions": actions,
            "question": {"schema_version": 1, "question_id": "mock-q-1", "response_mode": "free_text"}}


async def _inject_question(app, harness, actions: list[dict]) -> str:
    await harness.send(json.dumps({"type": "debug_replay_notification", "request_id": "n1",
                                   "notification": _question_notification(actions)}))
    ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
    assert ack["type"] == "debug_replay_notification.ack" and ack["status"] == "ok"
    pushed = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
    assert pushed["type"] == "notification" and pushed["notification"]["state"] == "open"
    assert pushed["notification"]["question"]["state"] == "open"
    return ack["notification"]["notification_id"]


def test_notification_resolve_settles_like_v2_and_wakes_await(registry):
    """The app's notification.resolve gets v2's resolve.ok (ack action -> acked) and the
    injector's notification.await returns only then, carrying the submitted answer."""
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
                await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
                for _ in range(3):
                    await asyncio.wait_for(app.recv(), timeout=5)
                await _harness_hello(harness)
                nid = await _inject_question(app, harness, [{"kind": "ack", "action_id": "free-text-action", "label": "Submit"}])
                await harness.send(json.dumps({"type": "notification.await", "request_id": "w1", "notification_id": nid, "timeout": 5}))
                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(harness.recv(), timeout=0.3)
                await app.send(json.dumps({"type": "notification.resolve", "request_id": "r1", "notification_id": nid,
                                           "action_kind": "ack", "question_id": "mock-q-1", "text": "exact answer", "note": "a note"}))
                frames = [json.loads(await asyncio.wait_for(app.recv(), timeout=5)) for _ in range(2)]
                ok = next(f for f in frames if f["type"] == "notification.resolve.ok")
                assert ok["request_id"] == "r1" and ok["replayed"] is False
                assert ok["notification"]["state"] == "acked"
                assert ok["notification"]["resolution"]["action_kind"] == "ack"
                broadcast = next(f for f in frames if f["type"] == "notification")
                assert broadcast["notification"]["state"] == "acked"
                assert broadcast["notification"]["question"]["state"] == "answered"
                woke = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert woke["type"] == "notification.await.ok" and woke["request_id"] == "w1"
                assert woke["answer"]["action_kind"] == "ack"
                assert woke["answer"]["text"] == "exact answer" and woke["answer"]["note"] == "a note"
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_notification_resolve_selection_takes_stored_action_kind(registry):
    """As in v2, a selection resolves with the matching stored action's kind (yes_no -> answered)."""
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
                await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
                for _ in range(3):
                    await asyncio.wait_for(app.recv(), timeout=5)
                await _harness_hello(harness)
                nid = await _inject_question(app, harness, [
                    {"kind": "yes_no", "action_id": "a-approve", "label": "Approve", "value": "approve", "choice": True},
                    {"kind": "yes_no", "action_id": "a-decline", "label": "Decline", "value": "decline", "choice": False},
                ])
                await app.send(json.dumps({"type": "notification.resolve", "request_id": "r2", "notification_id": nid,
                                           "action_kind": "ack", "selections": ["decline"]}))
                frames = [json.loads(await asyncio.wait_for(app.recv(), timeout=5)) for _ in range(2)]
                ok = next(f for f in frames if f["type"] == "notification.resolve.ok")
                assert ok["notification"]["state"] == "answered"
                resolution = ok["notification"]["resolution"]
                assert resolution["action_kind"] == "yes_no" and resolution["action_id"] == "a-decline"
                assert resolution["choice"] is False and resolution["selections"] == ["decline"]
                await harness.send(json.dumps({"type": "notification.await", "request_id": "w2", "notification_id": nid, "timeout": 5}))
                woke = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert woke["type"] == "notification.await.ok" and woke["answer"]["selections"] == ["decline"]
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


async def _prompt_answer_scenario(reg_path, cred_id, envelope, *, actions, response_mode, answer, options=None, question_notification=None):
    daemon, server, url = await _boot(reg_path)
    try:
        async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
            await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
            for _ in range(3):
                await asyncio.wait_for(app.recv(), timeout=5)
            await _harness_hello(harness)
            notification = question_notification or _question_notification(actions)
            notification["question"]["response_mode"] = response_mode
            notification["question"]["options"] = options or []
            await harness.send(json.dumps({"type": "debug_replay_notification", "request_id": "n1", "notification": notification}))
            nid = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))["notification"]["notification_id"]
            await asyncio.wait_for(app.recv(), timeout=5)
            await harness.send(json.dumps({"type": "notification.await", "request_id": "w1", "notification_id": nid, "timeout": 5}))
            await app.send(json.dumps({"type": "prompt.answer", "request_id": "p1", "question_id": notification["question"]["question_id"], **answer}))
            frames = [json.loads(await asyncio.wait_for(app.recv(), timeout=5)) for _ in range(2)]
            woke = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
            return frames, woke
    finally:
        server.close()
        await server.wait_closed()


def test_prompt_answer_free_text_resolves_the_question_like_v2(registry):
    """v2 _answer_free_text: the app's prompt.answer resolves the linked notification as
    `resolved` with the text, broadcasts it, leaves the question answered and wakes await."""
    _reg, cred_id, envelope, reg_path = registry
    frames, woke = asyncio.run(_prompt_answer_scenario(
        reg_path, cred_id, envelope, actions=[{"kind": "ack", "action_id": "free-text-action", "label": "Submit"}],
        response_mode="free_text", answer={"text": "exact answer"}))
    ok = next(f for f in frames if f["type"] == "prompt.answer.ok")
    assert ok["request_id"] == "p1" and ok["ok"] is True and ok["question"]["state"] == "answered"
    assert ok["notification"]["state"] == "resolved"
    broadcast = next(f for f in frames if f["type"] == "notification")
    assert broadcast["notification"]["state"] == "resolved"
    assert broadcast["notification"]["question"]["state"] == "answered"
    assert woke["type"] == "notification.await.ok"
    assert woke["answer"]["action_kind"] == "resolved" and woke["answer"]["text"] == "exact answer"


def test_prompt_answer_choice_takes_stored_action_kind_and_custom_text(registry):
    """v2 _answer_choice: a selection takes the stored action's kind and text rides as custom_text."""
    _reg, cred_id, envelope, reg_path = registry
    frames, woke = asyncio.run(_prompt_answer_scenario(
        reg_path, cred_id, envelope, actions=[{"kind": "ack", "action_id": "answer-2", "label": "Answer 2", "value": "2"}],
        response_mode="single_choice", answer={"selections": ["2"], "text": "a note"},
        options=[{"value": "2", "label": "Answer 2"}]))
    broadcast = next(f for f in frames if f["type"] == "notification")
    assert broadcast["notification"]["state"] == "acked"
    assert broadcast["notification"]["resolution"]["action_id"] == "answer-2"
    assert woke["answer"]["selections"] == ["2"] and woke["answer"]["custom_text"] == "a note"


@pytest.mark.parametrize("action_value", ["proceed", {"answer": "proceed"}])
def test_prompt_answer_choice_matches_v2_action_values(registry, action_value):
    _reg, cred_id, envelope, reg_path = registry
    frames, woke = asyncio.run(_prompt_answer_scenario(
        reg_path, cred_id, envelope,
        actions=[{"kind": "ack", "action_id": "a-proceed", "label": "Proceed", "value": action_value}],
        response_mode="single_choice", options=[{"value": "proceed", "label": "Proceed"}],
        answer={"selections": ["proceed"]}))
    notification = next(f["notification"] for f in frames if f["type"] == "notification")
    assert notification["state"] == "acked"
    assert notification["resolution"]["action_id"] == "a-proceed"
    assert woke["answer"]["action_kind"] == "ack"


@pytest.mark.parametrize("answer,actions,mode", [
    ({"selections": ["bad"]}, True, "single_choice"),
    ({}, True, "single_choice"),
    ({"selections": []}, True, "single_choice"),
    ({"selections": ["proceed", "proceed"]}, True, "multi_choice"),
    ({"selections": ["proceed", "wait"]}, True, "single_choice"),
    ({"selections": [3]}, True, "single_choice"),
    ({"selections": "proceed"}, True, "single_choice"),
    ({"selections": ["proceed"]}, False, "single_choice"),
    ({"selections": ["proceed"]}, True, "unknown"),
    ({"selections": ["proceed"], "value": "proceed"}, True, "single_choice"),
])
def test_prompt_answer_invalid_choice_keeps_notification_open(registry, answer, actions, mode):
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as app, websockets.connect(url, max_size=None) as harness:
                await _app_hello(app, cred_id, envelope, subscribe={"snapshot": True})
                for _ in range(3):
                    await asyncio.wait_for(app.recv(), timeout=5)
                await _harness_hello(harness)
                notification = _question_notification(
                    [{"kind": "ack", "action_id": "a-proceed", "value": {"answer": "proceed"}}] if actions else [])
                notification["question"].update(response_mode=mode, options=[
                    {"value": "proceed", "label": "Proceed"}, {"value": "wait", "label": "Wait"}])
                await harness.send(json.dumps({"type": "debug_replay_notification", "request_id": "n-invalid", "notification": notification}))
                nid = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))["notification"]["notification_id"]
                await asyncio.wait_for(app.recv(), timeout=5)
                await app.send(json.dumps({"type": "prompt.answer", "request_id": "p-invalid", "question_id": "mock-q-1", **answer}))
                reply = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert reply["type"] == "prompt.error"
                assert reply["request_id"] == "p-invalid" and reply["error_code"] == "prompt_invalid"
                assert daemon.notifications[nid]["state"] == "open"
                assert daemon.notifications[nid]["question"]["state"] == "open"
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(scenario())


def test_prompt_answer_choice_custom_text_only_remains_valid(registry):
    _reg, cred_id, envelope, reg_path = registry
    frames, woke = asyncio.run(_prompt_answer_scenario(
        reg_path, cred_id, envelope, actions=[], response_mode="single_choice",
        options=[{"value": "proceed", "label": "Proceed"}], answer={"text": "another answer"}))
    notification = next(f["notification"] for f in frames if f["type"] == "notification")
    assert notification["state"] == "resolved"
    assert woke["answer"]["custom_text"] == "another answer"


@pytest.mark.parametrize("index", range(3))
@pytest.mark.parametrize("selection", ["proceed", "wait"])
def test_overlay_fixture_choices_resolve_like_v2(registry, index, selection):
    _reg, cred_id, envelope, reg_path = registry
    path = Path(__file__).resolve().parents[1] / "fixtures/scripted_daemon/questions_overlay_partial_submit.json"
    notification = json.loads(path.read_text())["notifications"][index]["notification"]
    frames, woke = asyncio.run(_prompt_answer_scenario(
        reg_path, cred_id, envelope, actions=notification["actions"], response_mode="single_choice",
        options=notification["question"]["options"], question_notification=notification,
        answer={"selections": [selection]}))
    broadcast = next(f["notification"] for f in frames if f["type"] == "notification")
    assert broadcast["state"] == "acked" and broadcast["question"]["state"] == "answered"
    assert broadcast["resolution"]["action_id"] == f"overlay-action-{index}-{selection}"
    assert woke["answer"]["selections"] == [selection]


def test_debug_replay_question_is_persisted_as_mount_fetch_ask_event(registry):
    """Fidelity with the real daemon (M1 session free-text `no_entries` gap):
    replaying an OPEN agent question whose surface stream is declared must also
    persist a `prompt.ask.ok` TOOL_RESULT stream event, so a bounded
    request_stream_events('mount-fetch') returns it and the app can re-hydrate
    the question through its transcript backfill. A live-only broadcast (no
    persisted ask row) was what let the bounded re-fetch drop the question and
    auto-close the overlay in window-05."""
    _reg, cred_id, envelope, reg_path = registry
    stream_id = "mock-host:mock-session"
    notification = {
        "producer": "agent_question.v1", "severity": "info",
        "title": "Mock durable question", "body": "Answer it.",
        "actions": [{"kind": "ack", "action_id": "a1", "label": "Proceed", "value": {"answer": "proceed"}}],
        "question": {"schema_version": 1, "question_id": "mock-ask-1", "response_mode": "free_text",
                     "state": "open", "producer_stream_id": stream_id},
    }

    async def scenario():
        _daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as harness:
                await _harness_hello(harness)
                await harness.send(json.dumps({"type": "debug_replay_notification",
                                               "request_id": "n1", "notification": notification}))
                ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert ack["type"] == "debug_replay_notification.ack" and ack["status"] == "ok"
                nid = ack["notification"]["notification_id"]
            async with websockets.connect(url, max_size=None) as app:
                await _app_hello(app, cred_id, envelope, subscribe={"mode": "rpc", "snapshot": False})
                ready = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert ready["type"] == "ready"
                # Bounded cold-open mount-fetch window, exactly as the app issues it.
                await app.send(json.dumps({"type": "request_stream_events", "request_id": "q1",
                                           "stream_id": stream_id, "limit": 25}))
                resp = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                assert resp["type"] == "request_stream_events.ok" and resp["complete"] is True
                return resp["events"], nid
        finally:
            server.close()
            await server.wait_closed()

    events, nid = asyncio.run(scenario())
    asks = []
    for e in events:
        if e.get("kind") != "TOOL_RESULT" or not isinstance(e.get("text"), str):
            continue
        try:
            payload = json.loads(e["text"])
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("type") == "prompt.ask.ok":
            asks.append(payload)
    assert asks, "mount-fetch must return a persisted prompt.ask.ok event for the replayed question"
    assert asks[-1]["question"]["question_id"] == "mock-ask-1"
    assert asks[-1]["notification"]["notification_id"] == nid


def test_debug_replay_report_notification_is_not_persisted(registry):
    """A notification without an open agent question (or without a surface
    stream) stays broadcast-only: no stream event is persisted, so unrelated
    replay paths are unchanged."""
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        _daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as harness:
                await _harness_hello(harness)
                await harness.send(json.dumps({"type": "debug_replay_notification", "request_id": "r1",
                    "notification": {"producer": "agent_report.v1", "stream_id": "mock-host:report",
                                     "title": "Report", "body": "done"}}))
                ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert ack["status"] == "ok"
            async with websockets.connect(url, max_size=None) as app:
                await _app_hello(app, cred_id, envelope, subscribe={"mode": "rpc", "snapshot": False})
                assert json.loads(await asyncio.wait_for(app.recv(), timeout=5))["type"] == "ready"
                await app.send(json.dumps({"type": "request_stream_events", "request_id": "q1",
                                           "stream_id": "mock-host:report", "limit": 25}))
                resp = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                return resp["events"]
        finally:
            server.close()
            await server.wait_closed()

    assert asyncio.run(scenario()) == []


def _open_question_notification(stream_id="mock-host:mock-session", qid="mock-ask-1"):
    return {
        "producer": "agent_question.v1", "severity": "info",
        "title": "Mock durable question", "body": "Answer it.",
        "actions": [{"kind": "ack", "action_id": "a1", "label": "Proceed", "value": {"answer": "proceed"}}],
        "question": {"schema_version": 1, "question_id": qid, "response_mode": "free_text",
                     "state": "open", "producer_stream_id": stream_id},
    }


def test_reconnect_snapshot_carries_open_question(registry):
    """RED for the window-05 no_entries overlay-close: after an open agent
    question exists, a fresh snapshot (what a reconnecting client receives) must
    carry it. The old mock sent notifications:[], so the reducer's full-slice
    replacement wiped the question on reconnect and the overlay auto-closed."""
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        _daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as harness:
                await _harness_hello(harness)
                await harness.send(json.dumps({"type": "debug_replay_notification",
                                               "request_id": "n1", "notification": _open_question_notification()}))
                ack = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))
                assert ack["status"] == "ok"
                nid = ack["notification"]["notification_id"]
            # A reconnecting app subscribes for a snapshot (mode != rpc).
            async with websockets.connect(url, max_size=None) as app:
                await _app_hello(app, cred_id, envelope, subscribe={"events_mode": "full"})
                snapshot = None
                for _ in range(5):
                    frame = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                    if frame["type"] == "snapshot":
                        snapshot = frame
                        break
                assert snapshot is not None, "expected a snapshot frame on reconnect"
                return snapshot["notifications"], nid
        finally:
            server.close()
            await server.wait_closed()

    notifications, nid = asyncio.run(scenario())
    ids = [n.get("notification_id") for n in notifications]
    assert nid in ids, "reconnect snapshot must carry the open question so it is not wiped"
    carried = next(n for n in notifications if n.get("notification_id") == nid)
    assert carried.get("state") == "open" and carried["question"]["state"] == "open"


def test_notification_list_answers_lookup_and_open(registry):
    """The mock must answer notification.list (both the open-list form and the
    notification_ids lookup the transcript backfill uses). An unanswered command
    is what let a tracked RPC time out and force-close the socket (rpc_timeout)."""
    _reg, cred_id, envelope, reg_path = registry

    async def scenario():
        _daemon, server, url = await _boot(reg_path)
        try:
            async with websockets.connect(url, max_size=None) as harness:
                await _harness_hello(harness)
                await harness.send(json.dumps({"type": "debug_replay_notification",
                                               "request_id": "n1", "notification": _open_question_notification()}))
                nid = json.loads(await asyncio.wait_for(harness.recv(), timeout=5))["notification"]["notification_id"]
            async with websockets.connect(url, max_size=None) as app:
                await _app_hello(app, cred_id, envelope, subscribe={"mode": "rpc", "snapshot": False})
                assert json.loads(await asyncio.wait_for(app.recv(), timeout=5))["type"] == "ready"
                await app.send(json.dumps({"type": "notification.list", "request_id": "L1", "notification_ids": [nid]}))
                lookup = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                await app.send(json.dumps({"type": "notification.list", "request_id": "L2", "states": ["open"]}))
                listing = json.loads(await asyncio.wait_for(app.recv(), timeout=5))
                return lookup, listing, nid
        finally:
            server.close()
            await server.wait_closed()

    lookup, listing, nid = asyncio.run(scenario())
    assert lookup["type"] == "notification.list.ok" and lookup["request_id"] == "L1"
    assert [n["notification_id"] for n in lookup["notifications"]] == [nid]
    assert listing["type"] == "notification.list.ok" and listing["request_id"] == "L2"
    assert nid in [n["notification_id"] for n in listing["notifications"]]
