from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path


# scripted_replay.py is vendored alongside this file (the v1
# services/chat-stream/harness tree was retired). Resolve it from this file's
# own directory so it works regardless of cwd.
_TOOLS_DIR = Path(__file__).resolve().parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

import scripted_replay as replay  # noqa: E402


def replay_frame_interval_s(script, fixture_payload: dict | None = None) -> float:
    configured_ms = (
        fixture_payload.get("replay_frame_interval_ms")
        if isinstance(fixture_payload, dict)
        else getattr(script, "replay_frame_interval_ms", None)
    )
    if isinstance(configured_ms, (int, float)) and not isinstance(configured_ms, bool) and configured_ms >= 0:
        return float(configured_ms) / 1000.0
    if script.name == "mock_composite_chat_load":
        # Keep the host injector at the scenario's sustained 10 Hz cadence;
        # never catch up by bursting frames after a late daemon acknowledgement.
        return 0.1
    return 0.001 if (
        script.name == "all_chats_freeze_sim_regression_setup" and len(script.frames) == 19_120
    ) else 0.0


def replay_ack_batch_size(*, catch_up_late_frames: bool) -> int:
    return 640 if catch_up_late_frames else 1


async def receive_frame_ack_batch(ws, pending: list[dict]) -> list[tuple[dict, dict, float]]:
    remaining = {item["request_id"] for item in pending}
    acknowledgements: dict[str, tuple[dict, float]] = {}
    deadline = time.monotonic() + 30.0
    while remaining:
        response = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()))
        request_id = response.get("request_id")
        if request_id not in remaining:
            continue
        if response.get("type") != "debug_replay_event.ack" or response.get("status") != "ok":
            raise RuntimeError(f"debug replay rejected frame acknowledgement: {response!r}")
        acknowledgements[request_id] = (response, time.time() * 1000.0)
        remaining.remove(request_id)
    return [
        (item, acknowledgements[item["request_id"]][0], acknowledgements[item["request_id"]][1])
        for item in pending
    ]


def frame_ack_payload(item: dict, ack: dict, ack_wall_ms: float) -> dict:
    return {
        "event": "frame.sent",
        "id": item["frame_id"],
        "seq": item["seq"],
        "stream_id": item["stream_id"],
        "harness_run_id": item["harness_run_id"],
        "request_id": item["request_id"],
        "scheduled_at_ms": item["scheduled_at_ms"],
        "injected_at_ms": item["injected_at_ms"],
        "lateness_ms": round(item["injected_at_ms"] - item["scheduled_at_ms"], 3),
        "injector_send_wall_ms": round(item["injector_send_wall_ms"], 3),
        "daemon_accept_wall_ms": ack.get("daemon_accept_wall_ms"),
        "ack_wall_ms": round(ack_wall_ms, 3),
        "ack_latency_ms": round(ack_wall_ms - item["injector_send_wall_ms"], 3),
        "mobile_queue_depths": ack.get("mobile_queue_depths", []),
    }


def format_frame_ack_batch(received: list[tuple[dict, dict, float]]) -> str:
    return "\n".join(
        json.dumps(frame_ack_payload(item, ack, ack_wall_ms))
        for item, ack, ack_wall_ms in received
    )


SEED_HISTORY_PRODUCER = "pentacle.mobile.seed_history.v1"


async def seed_history_streams(ws, fixture_payload: dict) -> int:
    """Prime the daemon's per-stream event store from the fixture's
    `history.streams` BEFORE any open, so cold opens serve the transcript via the
    hello-snapshot / request_stream_events (the paths `recent_by_stream` feeds).
    `debug_replay_event` broadcasts live but never retains, so a cold-open latency
    scenario (chat_open_slo) cannot prime its transcript with live frames. Handled
    by the mock v2 daemon's SEED_HISTORY_PRODUCER handler. No-op when the fixture
    carries no history streams. Returns the number of streams seeded."""
    history = fixture_payload.get("history") if isinstance(fixture_payload, dict) else None
    streams = history.get("streams") if isinstance(history, dict) else None
    if not isinstance(streams, list) or not streams:
        return 0
    seeded = 0
    for entry in streams:
        if not isinstance(entry, dict):
            continue
        stream_id = str(entry.get("stream_id") or "")
        events = entry.get("events")
        if not stream_id or not isinstance(events, list) or not events:
            continue
        first = events[0] if isinstance(events[0], dict) else {}
        request_id = f"seed-history-{uuid.uuid4().hex}"
        await replay._send_json(
            ws,
            {
                "type": "debug_replay_notification",
                "request_id": request_id,
                "notification": {
                    "producer": SEED_HISTORY_PRODUCER,
                    "stream_id": stream_id,
                    "host": str(first.get("host") or ""),
                    "session_name": str(first.get("session_name") or ""),
                    "provider": str(first.get("provider") or ""),
                    "events": events,
                },
            },
        )
        ack = await replay._recv_type(ws, "debug_replay_notification.ack", request_id, timeout_s=30.0)
        if ack.get("status") != "ok":
            raise RuntimeError(f"seed_history rejected stream {stream_id}: {ack!r}")
        print(
            json.dumps({"event": "history.seeded", "stream_id": stream_id, "seeded": ack.get("seeded")}),
            flush=True,
        )
        seeded += 1
    print(json.dumps({"event": "history.seed_complete", "streams": seeded}), flush=True)
    return seeded


async def configure_snapshot(ws, fixture_payload: dict, host: str) -> bool:
    """Configure the daemon's session-inventory snapshot from the fixture BEFORE
    any app connects, so the app's hello-snapshot carries the fixture's sessions
    (e.g. the 64 all-chats-freeze rows). The single-stream injector does this too;
    without it a no-history fixture (freeze) leaves the snapshot empty and the app
    never renders its list. History-seeding streams index their own summaries
    separately. Returns True when a snapshot was configured. No-op for an empty
    snapshot."""
    snapshot = fixture_payload.get("snapshot") if isinstance(fixture_payload, dict) else None
    if not isinstance(snapshot, dict) or not (snapshot.get("sessions") or snapshot.get("events")):
        return False
    request_id = f"snapshot-config-{uuid.uuid4().hex}"
    await replay._send_json(ws, {
        "type": "debug_replay_snapshot_config",
        "request_id": request_id,
        "snapshot": snapshot,
        "host": host,
    })
    ack = await replay._recv_type(ws, "debug_replay_snapshot_config.ack", request_id)
    if ack.get("status") != "ok":
        raise RuntimeError(f"debug snapshot config rejected: {ack!r}")
    return True


async def configure_send_echo(ws, script) -> bool:
    send_echo = script.send_echo if isinstance(script.send_echo, dict) else {}
    if not send_echo:
        return False
    request_id = f"send-echo-config-{uuid.uuid4().hex}"
    fail_first_send = send_echo.get("fail_first_send")
    await replay._send_json(
        ws,
        {
            "type": "debug_replay_send_echo_config",
            "request_id": request_id,
            "stream_id": script.stream_id,
            "daemon_seq": int(send_echo.get("daemon_seq") or 9001),
            "timestamp": str(send_echo.get("timestamp") or ""),
            "provider": script.stream["provider"],
            **({"fail_first_send": fail_first_send} if isinstance(fail_first_send, dict) else {}),
        },
    )
    ack = await replay._recv_type(ws, "debug_replay_send_echo_config.ack", request_id)
    if ack.get("status") != "ok":
        raise RuntimeError(f"debug send echo config rejected: {ack!r}")
    return True


async def wait_for_send_echo(ws, script) -> None:
    send_echo = script.send_echo if isinstance(script.send_echo, dict) else {}
    if not send_echo:
        return
    timeout_s = float(send_echo.get("wait_for_send_s") or 30.0)
    echoed = await replay._recv_observed(ws, "send.echoed", timeout_s)
    print(json.dumps({"event": "send.echoed", "stream_id": echoed.get("stream_id"), "seq": echoed.get("seq")}), flush=True)


async def perform_authoritative_remove(ws, control: dict) -> None:
    request_id = f"authoritative-remove-{uuid.uuid4().hex}"
    await replay._send_json(
        ws,
        {
            "type": "debug_replay_notification",
            "request_id": request_id,
            "notification": {
                "producer": "pentacle.mobile.mock_remove_session.v1",
                "stream_id": f"{control['host']}:{control['session_name']}",
            },
        },
    )
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        response = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()))
        if response.get("request_id") != request_id:
            continue
        if response.get("type") == "debug_replay_notification.ack":
            if response.get("status") != "ok" or response.get("dropped") is not True:
                raise RuntimeError(f"authoritative remove rejected: {response!r}")
            print(json.dumps({"event": "authoritative_remove.ok", "request_id": request_id}), flush=True)
            return
    raise TimeoutError(f"timed out waiting for authoritative remove {request_id}")


async def inject(script, *, ws_url: str, token: str | None) -> None:
    import websockets

    fixture_payload = json.loads(script.path.read_text(encoding="utf-8"))
    history = fixture_payload.get("history") if isinstance(fixture_payload, dict) else None
    has_history_seed = isinstance(history, dict) and bool(history.get("streams"))
    ready_line = json.dumps({"event": "ready", "url": ws_url, "fixture_path": str(script.path)})
    # Legacy behavior for scenarios with nothing to seed: announce readiness before
    # connecting so the app boots immediately. When the fixture DOES carry cold-open
    # history, defer readiness until the seed lands (below) so run_scenario boots the
    # app only after every stream's transcript is in the daemon store — otherwise the
    # first cold opens race the seed and record INCOMPLETE.
    if not has_history_seed:
        print(ready_line, flush=True)
    async with websockets.connect(ws_url, open_timeout=10, max_size=None) as ws:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if welcome.get("type") != "welcome":
            raise RuntimeError(f"unexpected daemon welcome: {welcome!r}")
        await replay._send_json(
            ws,
            {
                "type": "hello",
                "client": "harness",
                "token": token or None,
                "subscribe": {"mode": "rpc", "snapshot": False},
            },
        )
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if ready.get("type") != "ready":
            raise RuntimeError(f"unexpected daemon ready frame: {ready!r}")
        print(json.dumps({"event": "client.hello", "client": "harness"}), flush=True)
        await configure_snapshot(ws, fixture_payload, script.stream["host"])
        await configure_send_echo(ws, script)

        await seed_history_streams(ws, fixture_payload)
        if has_history_seed:
            # Decouple `ready` from the tight seed burst. run_scenario's readiness
            # reader gates on `select()` + buffered `readline()`; when `ready`
            # is flushed in the same instant as the final seed lines, that reader
            # read-ahead-buffers it and never sees a fresh fd-readable event, so it
            # quiet-times-out. A brief yield lets it drain the seed burst first, so
            # `ready` lands as its own readable write.
            await asyncio.sleep(0.3)
            print(ready_line, flush=True)
        authoritative_remove = fixture_payload.get("authoritative_remove")
        frame_interval_s = replay_frame_interval_s(script, fixture_payload)
        catch_up_late_frames = fixture_payload.get("replay_catch_up_late_frames") is True
        harness_run_id = str(fixture_payload.get("harness_run_id") or "")
        first_frame_ready = bool(script.frames and script.frames[0].wait_for_client and catch_up_late_frames)
        if first_frame_ready:
            await replay._wait_for_client(ws, "pentacle-mobile", 30.0)
        started = time.monotonic()
        started_wall_ms = time.time() * 1000.0
        last_send_monotonic: float | None = None
        ack_batch: list[dict] = []
        ack_batch_size = replay_ack_batch_size(catch_up_late_frames=catch_up_late_frames)
        for frame_index, frame in enumerate(script.frames):
            due_monotonic = started + (frame.at_ms / 1000.0)
            if last_send_monotonic is not None and frame_interval_s and not catch_up_late_frames:
                due_monotonic = max(due_monotonic, last_send_monotonic + frame_interval_s)
            sleep_s = max(0.0, due_monotonic - time.monotonic())
            if sleep_s:
                await asyncio.sleep(sleep_s)
            if (frame.wait_for_client and not (first_frame_ready and frame_index == 0)) or frame.after_reconnect:
                await replay._wait_for_client(ws, "pentacle-mobile", 30.0)
            payload = replay.event_payload_for_frame(script, frame)
            request_id = f"frame-{frame.id}-{uuid.uuid4().hex}"
            injector_send_monotonic = time.monotonic()
            injector_send_wall_ms = time.time() * 1000.0
            injected_at_ms = round((time.monotonic() - started) * 1000.0, 3)
            await replay._send_json(
                ws,
                {
                    "type": "debug_replay_event",
                    "request_id": request_id,
                    "expected_stream_id": payload["stream_id"],
                    "harness_replay_timing": {
                        "harness_run_id": harness_run_id,
                        "frame_id": frame.id,
                        "fixture_at_ms": frame.at_ms,
                        "fixture_due_wall_ms": started_wall_ms + frame.at_ms,
                        "injector_send_wall_ms": injector_send_wall_ms,
                    },
                    "event": payload,
                },
            )
            last_send_monotonic = injector_send_monotonic
            ack_batch.append({
                "frame_id": frame.id,
                "seq": payload.get("daemon_seq"),
                "stream_id": payload.get("stream_id"),
                "harness_run_id": harness_run_id,
                "request_id": request_id,
                "scheduled_at_ms": frame.at_ms,
                "injected_at_ms": injected_at_ms,
                "injector_send_wall_ms": injector_send_wall_ms,
            })
            action_boundary = (
                isinstance(authoritative_remove, dict)
                and frame.id == authoritative_remove.get("after_frame_id")
            ) or frame.close_after
            if len(ack_batch) >= ack_batch_size or action_boundary or frame_index == len(script.frames) - 1:
                received = await receive_frame_ack_batch(ws, ack_batch)
                print(format_frame_ack_batch(received), flush=True)
                ack_batch = []
            if (
                isinstance(authoritative_remove, dict)
                and frame.id == authoritative_remove.get("after_frame_id")
            ):
                await perform_authoritative_remove(ws, authoritative_remove)
            if frame.close_after:
                close_id = f"close-{frame.id}-{uuid.uuid4().hex}"
                await replay._send_json(
                    ws,
                    {
                        "type": "debug_replay_close",
                        "request_id": close_id,
                        "client": "pentacle-mobile",
                        "code": 4000,
                        "reason": "scripted_reconnect",
                    },
                )
                close_ack = await replay._recv_type(ws, "debug_replay_close.ack", close_id)
                if close_ack.get("status") != "ok":
                    raise RuntimeError(f"debug close rejected frame {frame.id}: {close_ack!r}")
                print(json.dumps({"event": "client.closed", "id": frame.id, "closed": close_ack.get("closed", 0)}), flush=True)
        await wait_for_send_echo(ws, script)


def token_from_file(path: str | None) -> str | None:
    if not path:
        return None
    value = Path(path).expanduser()
    return value.read_text(encoding="utf-8").strip() if value.exists() else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--harness-env", required=True)
    args = parser.parse_args()
    env = replay.read_harness_env(args.harness_env)
    script = replay.load_script(args.script)
    asyncio.run(inject(script, ws_url=env["WS_URL"], token=token_from_file(env.get("TOKEN_FILE"))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
