"""Mock-only characterization of the daemon's registration contract (no simulator).

This is a *characterization* test of ``mock_v2_daemon.py``, not a RED test for
the bug: it passes at the base commit too. The RED proof that the fix is needed
is the scenario-contract test in ``test_nexus_agents_history_fixture.py``.

It documents why ``nexus_agents_history_questions`` must request
``disable_pentacle_auth``. With that action, ``usePentacleToken.ts`` stores a
``null`` auth token (the ``__auth_disabled__`` string is only the hook's debug
snapshot), so ``pentacleStream.ts`` connects via ``completeOpen({token:
authToken || undefined})`` — i.e. a hello with no ``token`` field. This test
shows the mock registers that token-less hello, whereas a client that never
sends a hello is never registered (the ``missing chat:ws_open`` /
``client_registered:false`` state a mock-only run reproduces when the
cold-launch auth bypass is absent). The mock ignores the token regardless
(``_on_hello`` only verifies when ``auth_v2`` is present and a registry is set).
"""
import asyncio
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

websockets = pytest.importorskip("websockets")

ROOT = Path(__file__).resolve().parents[1]
DAEMON = ROOT / "tools" / "mock_v2_daemon.py"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _recv_until(ws, want_type, timeout=3.0):
    end = time.monotonic() + timeout
    seen = []
    while time.monotonic() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, end - time.monotonic()))
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            break
        msg = json.loads(raw)
        seen.append(msg.get("type"))
        if msg.get("type") == want_type:
            return msg, seen
    return None, seen


async def _stats(ctrl, kind):
    rid = "stats-" + str(time.monotonic())
    await ctrl.send(json.dumps({"type": "daemon.stats", "request_id": rid}))
    frame, _ = await _recv_until(ctrl, "daemon.stats.ok", 3.0)
    assert frame is not None, "mock did not answer daemon.stats"
    return int(frame.get("stats", {}).get("clients", {}).get(kind, 0) or 0)


async def _run():
    port = _free_port()
    uri = f"ws://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, str(DAEMON), "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                async with websockets.connect(uri):
                    break
            except OSError:
                await asyncio.sleep(0.05)
        else:
            raise RuntimeError("mock daemon did not start")

        ctrl = await websockets.connect(uri)
        await _recv_until(ctrl, "welcome", 3.0)

        # The disable_pentacle_auth path yields a token-less hello -> registers.
        app = await websockets.connect(uri)
        await _recv_until(app, "welcome", 3.0)
        await app.send(json.dumps({
            "type": "hello", "client": "pentacle-mobile",
            "subscribe": {"events_mode": "summary"},
        }))
        snap, seen = await _recv_until(app, "snapshot", 3.0)
        assert snap is not None and "hello" in seen, seen
        await asyncio.sleep(0.2)
        registered = await _stats(ctrl, "pentacle-mobile")

        # A client that never sends a hello is never registered.
        silent = await websockets.connect(uri)
        await _recv_until(silent, "welcome", 3.0)
        await asyncio.sleep(0.3)
        after_silent = await _stats(ctrl, "pentacle-mobile")

        await ctrl.close(); await app.close(); await silent.close()
        return registered, after_silent
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def test_mock_characterization_registers_tokenless_hello_not_silent_client():
    registered, after_silent = asyncio.run(_run())
    assert registered == 1, "the token-less (auth-disabled) hello must register as pentacle-mobile"
    assert after_silent == 1, "a client that sends no hello must not register"
