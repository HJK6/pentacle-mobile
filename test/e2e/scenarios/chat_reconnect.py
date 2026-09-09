from __future__ import annotations

from pathlib import Path

# TODO(target-compat): tighten if this scenario gains device-only requirements.
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, assert_no_events, assert_sequence


_FIXTURE_NAME = "reconnect_silent_half_open.json"


def _fixture_path() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / _FIXTURE_NAME


def actions(config: dict) -> list[str]:
    # Open the mock chat, then arm a silent half-open on its live socket.
    return [*M.actions(config), "silent_half_open"]


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, _FIXTURE_NAME)
    local_fixture = _fixture_path()
    base["mock_fixture_path"] = str(local_fixture)
    base["scripted_daemon_fixture_path"] = str(local_fixture)
    # Arm the half-open after the mock hello has settled; fire the simulated
    # late onclose shortly after the client's own liveness close is suppressed.
    base["half_open_delay_ms"] = "2500"
    base["stale_onclose_delay_ms"] = "3000"
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None):
    """Assert the client's liveness watchdog recovers a true silent half-open.

    Deterministic mock model (contract #6): the local scripted daemon serves a
    hello then goes SILENT — socket stays open, zero further frames, and it never
    initiates a close. So there is no server-side slow_consumer/1011 close to
    race the client (the live-daemon dependency was the source of the
    order-dependent flake). The client's own no-frame watchdog must therefore
    detach the stale socket itself and close it with
    reason=watchdog_no_inbound_frame; the harness suppresses that outbound close
    (readyState stays OPEN) so the watchdog reason is the asserted signal, then
    the client reconnects to the still-live mock. Server-initiated
    close->reconnect (the slow_consumer path) is covered separately and
    deterministically by mock_chat_reconnect_duplicate_delivery (close_after).
    """
    if cap:
        cap.screenshot("chat_reconnect_start")
    early = M.await_mock_session_open(stream, name="chat_reconnect")
    if early:
        return early
    verdict = assert_sequence(
        stream,
        [
            EventSpec("harness:silent_half_open_armed", timeout_s=15),
            EventSpec("harness:silent_half_open_close_suppressed", where={"reason": "watchdog_no_inbound_frame"}, timeout_s=50),
            EventSpec("chat:ws_reconnect_attempt", timeout_s=8),
            EventSpec("chat:ws_reconnect_succeeded", timeout_s=45),
            EventSpec("harness:silent_half_open_late_onclose_fired", timeout_s=10),
        ],
        name="chat_reconnect",
    )
    verdict.fold_negative_watch(assert_no_events(stream, window_s=3))
    if cap:
        cap.screenshot("chat_reconnect_end")
    return verdict.finish()
