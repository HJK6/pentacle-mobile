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
