from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path

from ..harness.asserts import EventSpec, Verdict, assert_no_events, await_event


async def _inject_debug_event(ws_url: str, token: str, event: dict) -> None:
    """Send one synthetic event to an explicitly supplied mock endpoint."""
    import websockets

    digest = hashlib.sha256(json.dumps(event, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    request_id = f"example-event-{digest}"
    async with websockets.connect(ws_url, open_timeout=10, max_size=None) as ws:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if welcome.get("type") != "welcome":
            raise RuntimeError("mock server did not send welcome")
        await ws.send(json.dumps({
            "type": "hello",
            "client": "example-harness",
            "token": token or None,
            "subscribe": {"mode": "rpc", "snapshot": False},
        }))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if ready.get("type") != "ready":
            raise RuntimeError("mock server did not accept the example client")
        await ws.send(json.dumps({
            "type": "debug_replay_event",
            "request_id": request_id,
            "expected_stream_id": event["stream_id"],
            "event": event,
        }))
        while True:
            ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if ack.get("type") == "debug_replay_event.ack" and ack.get("request_id") == request_id:
                if ack.get("status") != "ok":
                    raise RuntimeError("mock server rejected the example event")
                return


def inject_debug_event(config: dict, event: dict) -> None:
    ws_url = str(config.get("ws_url") or "").strip()
    if not ws_url:
        raise RuntimeError("mock server ws_url is unavailable")
    auth_value = str(config.get("mock_token") or "")
    asyncio.run(_inject_debug_event(ws_url, auth_value, event))


HOST = "mock-host"
PROVIDER = "codex"
STREAM_ID = "mock-host:mock-session"
SESSION_NAME = "mock-session"


def fixture_dir(config: dict) -> Path:
    """Return an explicit fixture directory or this package's public fixtures."""
    override = str(config.get("fixture_dir") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon"


def fixture_path(config: dict, name: str) -> Path:
    local = Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / name
    if local.exists():
        return local
    directory = fixture_dir(config)
    candidate = directory / name
    if candidate.exists():
        return candidate
    # Allow an exported fixture to retain a legacy filesystem name while its
    # public payload advertises the generic scenario name.
    expected_name = Path(name).stem
    for sibling in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(sibling.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if payload.get("name") == expected_name:
            return sibling
    return candidate


def params_for_fixture(config: dict, fixture_name: str) -> dict[str, str]:
    run_id = str(
        config.get("scenario_run_id")
        or config.get("RUN_ID")
        or config.get("PENTACLE_RUN_ID")
        or "example-run"
    )
    path = fixture_path(config, fixture_name).expanduser()
    return {
        "host": HOST,
        "provider": PROVIDER,
        "stream_id": STREAM_ID,
        "mock_fixture_path": str(path),
        "scripted_daemon_fixture_path": str(path),
        "scenario_run_id": run_id,
        "PENTACLE_EVENT_REPLAY_COMMAND": "",
        "pre_open_wait_ms": "1800",
    }


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat"]


def preflight(config: dict, _repo_root: Path | None = None) -> str | None:
    fixture = str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip()
    if not fixture:
        return "mock fixture path is required"
    path = Path(fixture).expanduser()
    if not path.exists():
        return f"mock fixture missing: {path}"
    if str(config.get("PENTACLE_EVENT_REPLAY_COMMAND") or "").strip():
        return "example scenarios do not accept an external replay command"
    return None


def await_mock_session_open(stream, *, name: str) -> Verdict | None:
    ws_open = await_event(stream, EventSpec("chat:ws_open", timeout_s=20))
    if not ws_open:
        return Verdict(name=name, verdict="FAIL", error="missing chat:ws_open").finish()
    mounted = await_event(
        stream,
        EventSpec("harness:session_screen_mount", where={"stream_id": STREAM_ID}, timeout_s=30),
    )
    if not mounted:
        return Verdict(name=name, verdict="FAIL", error="missing session screen mount for the mock stream").finish()
    return None


def await_received_and_rendered(stream, seqs: list[int], *, name: str) -> Verdict | None:
    for seq in seqs:
        received = await_event(
            stream,
            EventSpec("chat:event_received", where={"stream_id": STREAM_ID, "seq": seq}, timeout_s=30),
        )
        if not received:
            return Verdict(name=name, verdict="FAIL", error=f"missing chat:event_received seq={seq}").finish()
    for seq in seqs:
        rendered = await_event(
            stream,
            EventSpec("chat:event_rendered", where={"stream_id": STREAM_ID, "seq": seq}, timeout_s=30),
        )
        if not rendered:
            return Verdict(name=name, verdict="FAIL", error=f"missing chat:event_rendered seq={seq}").finish()
    return None


def await_rendered(stream, seqs: list[int], *, name: str) -> Verdict | None:
    for seq in seqs:
        rendered = await_event(
            stream,
            EventSpec("chat:event_rendered", where={"stream_id": STREAM_ID, "seq": seq}, timeout_s=30),
        )
        if not rendered:
            return Verdict(name=name, verdict="FAIL", error=f"missing chat:event_rendered seq={seq}").finish()
    return None


def latest_rendered_order(stream, seqs: set[int]) -> list[int]:
    latest_by_seq: dict[int, object] = {}
    for event in stream.all_events():
        if event.message != "chat:event_rendered":
            continue
        if event.data.get("stream_id") != STREAM_ID:
            continue
        seq = event.data.get("seq")
        if seq not in seqs:
            continue
        latest_by_seq[int(seq)] = event

    def _render_order_key(item) -> tuple[float, float]:
        event = item[1]
        raw_index = event.data.get("render_order_index")
        if raw_index is not None:
            return (float(raw_index), float(event.received_at))
        transcript_order = _transcript_order_from_event(event)
        if item[0] in transcript_order:
            return (float(transcript_order.index(item[0])), float(event.received_at))
        return (float("inf"), float(event.received_at))

    return [seq for seq, _event in sorted(latest_by_seq.items(), key=_render_order_key)]


def _transcript_order_from_event(event) -> list[int]:
    order = event.data.get("transcript_seq_order")
    if not isinstance(order, list):
        return []
    return [int(seq) for seq in order if isinstance(seq, int)]


def await_transcript_order(
    stream,
    expected: list[int],
    *,
    timeout_s: float = 10.0,
    not_before: float | None = None,
) -> list[int]:
    deadline = time.monotonic() + timeout_s
    cutoff = not_before or 0.0
    latest: list[int] = []

    def consider(event) -> bool:
        nonlocal latest
        if event.received_at < cutoff:
            return False
        if event.message != "harness:transcript_order_dump":
            return False
        if event.data.get("stream_id") != STREAM_ID:
            return False
        order = _transcript_order_from_event(event)
        if order:
            latest = order
        return order == expected

    for event in stream.all_events():
        if consider(event):
            return expected
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if event and consider(event):
            return expected
    return latest


def count_events(stream, message: str, *, seq: int | None = None, row_id: str | None = None) -> int:
    count = 0
    for event in stream.all_events():
        if event.message != message or event.data.get("stream_id") != STREAM_ID:
            continue
        if seq is not None and event.data.get("seq") != seq:
            continue
        if row_id is not None and str(event.data.get("row_id") or event.data.get("id") or "") != row_id:
            continue
        count += 1
    return count


def finish_with_negative_watch(stream, verdict: Verdict, *, cap=None, screenshot_name: str = "mock_chat_streamd") -> Verdict:
    verdict.fold_negative_watch(assert_no_events(stream, window_s=3))
    if cap:
        cap.screenshot(screenshot_name)
    return verdict.finish()
