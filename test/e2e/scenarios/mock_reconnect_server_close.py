from __future__ import annotations

from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_reconnect_server_close"
_FIXTURE_NAME = "reconnect_server_close.json"


def _fixture_path() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / _FIXTURE_NAME


def actions(config: dict) -> list[str]:
    return M.actions(config)


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, _FIXTURE_NAME)
    local = _fixture_path()
    base["mock_fixture_path"] = str(local)
    base["scripted_daemon_fixture_path"] = str(local)
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    """Assert a SERVER-initiated close drives a graceful client reconnect.

    Complements chat_reconnect (client-watchdog close). The mock daemon serves a
    hello then closes the client itself (close_after) — the deterministic stand-in
    for the live daemon's slow_consumer(1011) close of a non-draining client —
    and the client must reconnect and resume delivery. Focused reconnect
    assertion only (no render-order aggregation), so it stays deterministic.
    """
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    reconnected = await_event(stream, EventSpec("chat:ws_reconnect_succeeded", timeout_s=45))
    if not reconnected:
        return Verdict(name=name, verdict="FAIL", error="missing chat:ws_reconnect_succeeded after server close").finish()
    delivered = await_event(
        stream,
        EventSpec("chat:event_received", where={"stream_id": M.STREAM_ID, "seq": 21}, timeout_s=30),
        not_before=reconnected.received_at,
    )
    if not delivered:
        return Verdict(name=name, verdict="FAIL", error="missing post-reconnect delivery (seq 21)").finish()
    return M.finish_with_negative_watch(
        stream,
        Verdict(name=name, verdict="PASS"),
        cap=cap,
        screenshot_name="mock_reconnect_server_close",
    )
