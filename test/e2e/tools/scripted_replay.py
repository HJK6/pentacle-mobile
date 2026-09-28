from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, TextIO

from datetime import datetime

# Vendored from the retired v1 `services/chat-stream/parser.py` (deleted by
# `154784e8 retire chat-stream v1`). The scripted injector only needs timestamp
# validation; the canonical event payload is built directly in
# `event_payload_for_frame` (the v1 `chat_streamd.event_payload` base was fully
# overridden by `script.stream`, so it was vestigial).
def parse_timestamp(value: str | None) -> datetime:
    if not value:
        return datetime.fromtimestamp(0)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _normalize_claude_jsonl_records(records, *, host: str, session_name: str):
    """Lazy shim for the jsonl-fixture path only (unused by the mock-v2 scripted
    scenarios). Kept importable so a jsonl fixture fails with a clear message
    rather than an ImportError if the retired module is truly needed."""
    raise ScriptValidationError(
        "claude-jsonl fixtures are not supported by the vendored scripted mock daemon; "
        "supply a chat.event `frames` fixture instead"
    )


class ScriptValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ScriptedFrame:
    id: str
    at_ms: int
    type: str
    event: dict[str, Any] | None = None
    duplicate_of: str | None = None
    after_reconnect: bool = False
    close_after: bool = False
    wait_for_client: bool = False
    wait_for_disconnect: bool = False
    expected_sort_index: int | None = None


@dataclass(frozen=True)
class ScriptedNotification:
    id: str
    at_ms: int
    notification: dict[str, Any]
    wait_for_client: bool = False
    await_resolve: bool = False
    resolve_timeout_s: float = 30.0


@dataclass(frozen=True)
class ScriptedDaemonScript:
    path: Path
    name: str
    stream: dict[str, str]
    snapshot: dict[str, Any]
    frames: list[ScriptedFrame]
    notifications: list[ScriptedNotification]
    upload: Any = None
    send_echo: Any = None
    history: Any = None

    @property
    def stream_id(self) -> str:
        return self.stream["stream_id"]


def _require_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ScriptValidationError(f"{label} must be an object")
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ScriptValidationError(f"{label} must be a non-empty string")
    return value


def _optional_bool(value: Any, label: str) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ScriptValidationError(f"{label} must be a boolean")
    return value


def _coerce_at_ms(value: Any, label: str) -> int:
    if not isinstance(value, (int, float)) or value < 0:
        raise ScriptValidationError(f"{label} must be a non-negative number")
    return int(value)


def _validate_stream(payload: dict[str, Any]) -> dict[str, str]:
    stream = _require_dict(payload.get("stream"), "stream")
    return {
        "stream_id": _require_text(stream.get("stream_id"), "stream.stream_id"),
        "host": _require_text(stream.get("host"), "stream.host"),
        "provider": _require_text(stream.get("provider"), "stream.provider"),
        "session_name": _require_text(stream.get("session_name"), "stream.session_name"),
        "title": str(stream.get("title") or stream.get("session_name") or ""),
        "session_id": str(stream.get("session_id") or ""),
    }


def _validate_event(frame_id: str, event: Any) -> dict[str, Any]:
    payload = _require_dict(event, f"frames[{frame_id}].event")
    _require_text(payload.get("kind"), f"frames[{frame_id}].event.kind")
    _require_text(payload.get("timestamp"), f"frames[{frame_id}].event.timestamp")
    if not isinstance(payload.get("daemon_seq"), int):
        raise ScriptValidationError(f"frames[{frame_id}].event.daemon_seq must be an integer")
    if not isinstance(payload.get("text"), str):
        raise ScriptValidationError(f"frames[{frame_id}].event.text must be a string")
    try:
        parse_timestamp(str(payload["timestamp"]))
    except Exception as exc:
        raise ScriptValidationError(f"frames[{frame_id}].event.timestamp must be ISO-8601") from exc
    if "attachments" in payload and not isinstance(payload["attachments"], list):
        raise ScriptValidationError(f"frames[{frame_id}].event.attachments must be an array")
    if "raw" in payload and not isinstance(payload["raw"], dict):
        raise ScriptValidationError(f"frames[{frame_id}].event.raw must be an object")
    return dict(payload)


def _jsonl_records_to_frames(payload: dict[str, Any], stream: dict[str, str]) -> list[dict[str, Any]]:
    records = payload.get("claude_jsonl_records")
    if not isinstance(records, list) or not records:
        raise ScriptValidationError("claude_jsonl_records must be a non-empty array")
    start_at_ms = _coerce_at_ms(payload.get("claude_jsonl_start_at_ms", 250), "claude_jsonl_start_at_ms")
    step_ms = _coerce_at_ms(payload.get("claude_jsonl_step_ms", 25), "claude_jsonl_step_ms")
    events = _normalize_claude_jsonl_records(records, host=stream["host"], session_name=stream["session_name"])
    frames: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        event_payload = dict(event)
        event_payload["daemon_seq"] = index + 1
        frames.append(
            {
                "id": f"jsonl-{index + 1}-{str(event_payload.get('kind') or 'event').lower()}",
                "at_ms": start_at_ms + (index * step_ms),
                "type": "chat.event",
                "wait_for_client": index == 0,
                "event": event_payload,
                "expected_sort_index": index + 1,
            }
        )
    return frames


def _validate_optional_mapping(value: Any, label: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ScriptValidationError(f"{label} must be an object")
    return dict(value)


def load_script(path: str | Path) -> ScriptedDaemonScript:
    fixture_path = Path(path).expanduser().resolve()
    payload = _require_dict(json.loads(fixture_path.read_text(encoding="utf-8")), "script")
    if payload.get("schema_version") != 1:
        raise ScriptValidationError("schema_version must be 1")
    name = _require_text(payload.get("name"), "name")
    stream = _validate_stream(payload)
    snapshot = payload.get("snapshot") if payload.get("snapshot") is not None else {}
    snapshot = _require_dict(snapshot, "snapshot")
    history = _validate_optional_mapping(payload.get("history"), "history")
    send_echo = _validate_optional_mapping(payload.get("send_echo"), "send_echo")
    frames_raw = payload.get("frames")
    if frames_raw is None and payload.get("claude_jsonl_records") is not None:
        frames_raw = _jsonl_records_to_frames(payload, stream)
    if not isinstance(frames_raw, list) or (not frames_raw and not send_echo):
        raise ScriptValidationError("frames must be a non-empty array")

    frames: list[ScriptedFrame] = []
    by_id: dict[str, ScriptedFrame] = {}
    saw_close = bool(history.get("close_after_chunks"))
    for index, raw_frame in enumerate(frames_raw):
        raw = _require_dict(raw_frame, f"frames[{index}]")
        frame_id = _require_text(raw.get("id"), f"frames[{index}].id")
        if frame_id in by_id:
            raise ScriptValidationError(f"duplicate frame id: {frame_id}")
        frame_type = _require_text(raw.get("type"), f"frames[{frame_id}].type")
        if frame_type != "chat.event":
            raise ScriptValidationError(f"frames[{frame_id}].type unsupported: {frame_type}")
        duplicate_of = raw.get("duplicate_of")
        if duplicate_of is not None:
            duplicate_of = _require_text(duplicate_of, f"frames[{frame_id}].duplicate_of")
            if duplicate_of not in by_id:
                raise ScriptValidationError(f"frames[{frame_id}].duplicate_of must reference an earlier frame")
        after_reconnect = _optional_bool(raw.get("after_reconnect"), f"frames[{frame_id}].after_reconnect")
        close_after = _optional_bool(raw.get("close_after"), f"frames[{frame_id}].close_after")
        wait_for_disconnect = _optional_bool(raw.get("wait_for_disconnect"), f"frames[{frame_id}].wait_for_disconnect")
        if wait_for_disconnect and after_reconnect:
            raise ScriptValidationError(f"frames[{frame_id}].wait_for_disconnect conflicts with after_reconnect")
        if wait_for_disconnect and _optional_bool(raw.get("wait_for_client"), f"frames[{frame_id}].wait_for_client"):
            raise ScriptValidationError(f"frames[{frame_id}].wait_for_disconnect conflicts with wait_for_client")
        if after_reconnect and not saw_close:
            raise ScriptValidationError(f"frames[{frame_id}].after_reconnect requires an earlier close_after")
        if saw_close and duplicate_of and not after_reconnect:
            raise ScriptValidationError(f"frames[{frame_id}].duplicate_of after close requires after_reconnect")
        event = _validate_event(frame_id, raw.get("event")) if duplicate_of is None else by_id[duplicate_of].event
        expected_sort_index = raw.get("expected_sort_index")
        if expected_sort_index is not None and not isinstance(expected_sort_index, int):
            raise ScriptValidationError(f"frames[{frame_id}].expected_sort_index must be an integer")
        frame = ScriptedFrame(
            id=frame_id,
            at_ms=_coerce_at_ms(raw.get("at_ms", 0), f"frames[{frame_id}].at_ms"),
            type=frame_type,
            event=dict(event or {}),
            duplicate_of=duplicate_of,
            after_reconnect=after_reconnect,
            close_after=close_after,
            wait_for_client=_optional_bool(raw.get("wait_for_client"), f"frames[{frame_id}].wait_for_client"),
            wait_for_disconnect=wait_for_disconnect,
            expected_sort_index=expected_sort_index,
        )
        frames.append(frame)
        by_id[frame_id] = frame
        saw_close = saw_close or close_after

    notifications: list[ScriptedNotification] = []
    notifications_raw = payload.get("notifications")
    if notifications_raw is not None:
        if not isinstance(notifications_raw, list):
            raise ScriptValidationError("notifications must be an array")
        seen_notification_ids: set[str] = set()
        for index, raw_notification in enumerate(notifications_raw):
            raw = _require_dict(raw_notification, f"notifications[{index}]")
            notification_id = _require_text(raw.get("id"), f"notifications[{index}].id")
            if notification_id in seen_notification_ids:
                raise ScriptValidationError(f"duplicate notification id: {notification_id}")
            seen_notification_ids.add(notification_id)
            notification = _require_dict(raw.get("notification"), f"notifications[{notification_id}].notification")
            producer = _require_text(notification.get("producer"), f"notifications[{notification_id}].notification.producer")
            _require_text(notification.get("title"), f"notifications[{notification_id}].notification.title")
            if "actions" in notification and not isinstance(notification["actions"], list):
                raise ScriptValidationError(f"notifications[{notification_id}].notification.actions must be an array")
            if producer == "agent_question.v1":
                question = _require_dict(notification.get("question"), f"notifications[{notification_id}].notification.question")
                _require_text(question.get("question_id"), f"notifications[{notification_id}].notification.question.question_id")
                _require_text(question.get("dedup_key"), f"notifications[{notification_id}].notification.question.dedup_key")
                _require_text(question.get("response_mode"), f"notifications[{notification_id}].notification.question.response_mode")
                if not isinstance(question.get("options"), list) or not question["options"]:
                    raise ScriptValidationError(f"notifications[{notification_id}].notification.question.options must be a non-empty array")
            resolve_timeout_s = raw.get("resolve_timeout_s", 30.0)
            if not isinstance(resolve_timeout_s, (int, float)) or resolve_timeout_s < 0:
                raise ScriptValidationError(f"notifications[{notification_id}].resolve_timeout_s must be a non-negative number")
            notifications.append(
                ScriptedNotification(
                    id=notification_id,
                    at_ms=_coerce_at_ms(raw.get("at_ms", 0), f"notifications[{notification_id}].at_ms"),
                    notification=dict(notification),
                    wait_for_client=_optional_bool(raw.get("wait_for_client"), f"notifications[{notification_id}].wait_for_client"),
                    await_resolve=_optional_bool(raw.get("await_resolve"), f"notifications[{notification_id}].await_resolve"),
                    resolve_timeout_s=float(resolve_timeout_s),
                )
            )

    return ScriptedDaemonScript(
        path=fixture_path,
        name=name,
        stream=stream,
        snapshot=snapshot,
        frames=frames,
        notifications=notifications,
        upload=_validate_optional_mapping(payload.get("upload"), "upload"),
        send_echo=send_echo,
        history=history,
    )


def event_payload_for_frame(script: ScriptedDaemonScript, frame: ScriptedFrame) -> dict[str, Any]:
    if frame.event is None:
        raise ScriptValidationError(f"frame {frame.id} has no event payload")
    raw = dict(frame.event.get("raw") or {})
    raw.setdefault("source", "scripted-daemon")
    raw.setdefault("session_name", script.stream["session_name"])
    if script.stream.get("session_id"):
        raw.setdefault("sessionId", script.stream["session_id"])
    # Timestamp validation only (parse errors surface here, not at broadcast).
    parse_timestamp(str(frame.event["timestamp"]))
    # Build the canonical stored-event payload directly. The retired v1
    # `chat_streamd.event_payload` base was fully overridden by these
    # `script.stream` values, so it added nothing.
    payload = {
        "daemon_seq": int(frame.event["daemon_seq"]),
        "host": str(frame.event.get("host") or script.stream["host"]),
        "provider": str(frame.event.get("provider") or script.stream["provider"]),
        "session_id": str(frame.event.get("session_id") or script.stream.get("session_id") or ""),
        "session_name": str(frame.event.get("session_name") or script.stream["session_name"]),
        "stream_id": str(frame.event.get("stream_id") or script.stream["stream_id"]),
        "timestamp": str(frame.event["timestamp"]),
        "kind": str(frame.event["kind"]),
        "text": str(frame.event["text"]),
        "raw": raw,
    }
    for key in ("attachments", "optimistic_id"):
        if key in frame.event:
            payload[key] = frame.event[key]
    missing = {"daemon_seq", "host", "provider", "session_id", "session_name", "stream_id", "timestamp", "kind", "text", "raw"} - set(payload)
    if missing:
        raise ScriptValidationError(f"frame {frame.id} event missing production keys: {sorted(missing)}")
    return payload


def read_harness_env(path: str | Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in Path(path).expanduser().read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key] = value
    return result


def _log(sink: TextIO | None, event: str, **payload: Any) -> None:
    if sink is None:
        return
    print(json.dumps({"event": event, **payload}, sort_keys=True, separators=(",", ":")), file=sink, flush=True)


async def _recv_type(ws: Any, frame_type: str, request_id: str, timeout_s: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        frame = json.loads(raw)
        if frame.get("type") == frame_type and frame.get("request_id") == request_id:
            return frame
    raise TimeoutError(f"timed out waiting for {frame_type} {request_id}")


async def _recv_observed(ws: Any, event: str, timeout_s: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
        frame = json.loads(raw)
        if frame.get("type") == "debug_replay_observed" and frame.get("event") == event:
            return frame
    raise TimeoutError(f"timed out waiting for debug_replay_observed {event}")


async def _send_json(ws: Any, payload: dict[str, Any]) -> None:
    await ws.send(json.dumps(payload, separators=(",", ":")))


async def _wait_for_client(ws: Any, target_client: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if await _client_is_registered(ws, target_client, max(0.1, deadline - time.monotonic())):
            return
        await asyncio.sleep(0.1)
    raise TimeoutError(f"timed out waiting for websocket client {target_client}")


async def _client_is_registered(ws: Any, target_client: str, timeout_s: float) -> bool:
    request_id = f"stats-{uuid.uuid4().hex}"
    await _send_json(ws, {"type": "daemon.stats", "request_id": request_id})
    frame = await _recv_type(ws, "daemon.stats.ok", request_id, timeout_s=timeout_s)
    clients = frame.get("stats", {}).get("clients", {})
    return isinstance(clients, dict) and int(clients.get(target_client) or 0) > 0


async def _wait_for_client_disconnect(ws: Any, target_client: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    saw_client = False
    while time.monotonic() < deadline:
        request_id = f"stats-{uuid.uuid4().hex}"
        await _send_json(ws, {"type": "daemon.stats", "request_id": request_id})
        frame = await _recv_type(ws, "daemon.stats.ok", request_id, timeout_s=max(0.1, deadline - time.monotonic()))
        clients = frame.get("stats", {}).get("clients", {})
        count = int(clients.get(target_client) or 0) if isinstance(clients, dict) else 0
        if count > 0:
            saw_client = True
        elif saw_client:
            return
        await asyncio.sleep(0.1)
    raise TimeoutError(f"timed out waiting for websocket client {target_client} to disconnect")


async def _inject_notification(ws: Any, item: ScriptedNotification) -> dict[str, Any]:
    request_id = f"notification-{item.id}-{uuid.uuid4().hex}"
    await _send_json(
        ws,
        {
            "type": "debug_replay_notification",
            "request_id": request_id,
            "notification": item.notification,
        },
    )
    ack = await _recv_type(ws, "debug_replay_notification.ack", request_id)
    if ack.get("status") != "ok":
        raise RuntimeError(f"debug notification rejected {item.id}: {ack!r}")
    notification = ack.get("notification")
    if not isinstance(notification, dict) or not notification.get("notification_id"):
        raise RuntimeError(f"debug notification ack missing notification payload {item.id}: {ack!r}")
    return notification


async def _await_notification_resolution(ws: Any, notification_id: str, timeout_s: float) -> dict[str, Any]:
    request_id = f"notification-await-{notification_id}-{uuid.uuid4().hex}"
    await _send_json(
        ws,
        {
            "type": "notification.await",
            "request_id": request_id,
            "notification_id": notification_id,
            "timeout": timeout_s,
        },
    )
    frame = await _recv_type(ws, "notification.await.ok", request_id, timeout_s=timeout_s + 1.0)
    answer = frame.get("answer")
    if not isinstance(answer, dict):
        raise RuntimeError(f"notification.await.ok missing answer for {notification_id}: {frame!r}")
    return answer


async def _wait_for_ready(ws: Any, timeout_s: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    observed_types: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            observed = ", ".join(observed_types[-20:]) or "none"
            raise TimeoutError(f"timed out waiting for daemon ready frame; observed: {observed}")
        try:
            raw_frame = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError as exc:
            observed = ", ".join(observed_types) or "none"
            raise TimeoutError(
                f"timed out waiting for daemon ready frame; observed: {observed}"
            ) from exc
        frame = json.loads(raw_frame)
        frame_type = frame.get("type")
        if frame_type == "ready":
            return frame
        observed_types.append(str(frame_type or "<missing>"))
        del observed_types[:-20]


async def inject_script(
    script: ScriptedDaemonScript,
    *,
    ws_url: str,
    token: str | None = None,
    target_client: str = "pentacle-mobile",
    wait_client_timeout_s: float = 30.0,
    log_sink: TextIO | None = sys.stdout,
) -> None:
    import websockets

    _log(log_sink, "ready", url=ws_url, fixture_path=str(script.path))
    async with websockets.connect(ws_url, open_timeout=10, max_size=None) as ws:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if welcome.get("type") != "welcome":
            raise RuntimeError(f"unexpected daemon welcome: {welcome!r}")
        await _send_json(
            ws,
            {
                "type": "hello",
                "client": "harness",
                "token": token or None,
                "subscribe": {"mode": "rpc", "snapshot": False},
            },
        )
        await _wait_for_ready(ws)
        _log(log_sink, "client.hello", client="harness")

        send_echo = script.send_echo if isinstance(script.send_echo, dict) else {}
        history = script.history if isinstance(script.history, dict) else {}
        if script.snapshot:
            request_id = f"snapshot-config-{uuid.uuid4().hex}"
            await _send_json(
                ws,
                {
                    "type": "debug_replay_snapshot_config",
                    "request_id": request_id,
                    "snapshot": script.snapshot,
                    "host": script.stream["host"],
                },
            )
            ack = await _recv_type(ws, "debug_replay_snapshot_config.ack", request_id)
            if ack.get("status") != "ok":
                raise RuntimeError(f"debug snapshot config rejected: {ack!r}")
        if send_echo:
            request_id = f"send-echo-config-{uuid.uuid4().hex}"
            fail_first_send = send_echo.get("fail_first_send") if isinstance(send_echo, dict) else None
            match = str(send_echo.get("match") or "stream_id")
            session_name_pattern = str(send_echo.get("session_name_pattern") or "")
            await _send_json(
                ws,
                {
                    "type": "debug_replay_send_echo_config",
                    "request_id": request_id,
                    "stream_id": script.stream_id,
                    "host": script.stream["host"],
                    "match": match,
                    **({"session_name_pattern": session_name_pattern} if session_name_pattern else {}),
                    "daemon_seq": int(send_echo.get("daemon_seq") or 9001),
                    **({"echo_delay_ms": int(send_echo.get("echo_delay_ms") or 0)} if send_echo.get("echo_delay_ms") else {}),
                    "timestamp": str(send_echo.get("timestamp") or ""),
                    "provider": script.stream["provider"],
                    "event_source": str(send_echo.get("event_source") or "scripted-daemon"),
                    **(
                        {"assistant_replies": send_echo.get("assistant_replies")}
                        if isinstance(send_echo.get("assistant_replies"), list)
                        else {}
                    ),
                    **({"fail_first_send": fail_first_send} if isinstance(fail_first_send, dict) else {}),
                },
            )
            ack = await _recv_type(ws, "debug_replay_send_echo_config.ack", request_id)
            if ack.get("status") != "ok":
                raise RuntimeError(f"debug send echo config rejected: {ack!r}")

        if history:
            events_raw = history.get("events")
            if events_raw is None:
                try:
                    count = int(history.get("event_count") or 0)
                    start_seq = int(history.get("start_seq") or 1)
                except (TypeError, ValueError):
                    count = 0
                    start_seq = 1
                if count <= 0:
                    raise RuntimeError("history.events array or positive history.event_count is required")
                events_raw = [
                    {
                        "kind": "USER" if seq % 2 else "ASSIST",
                        "daemon_seq": seq,
                        "timestamp": f"2026-07-09T05:14:{(seq % 60):02d}.000Z",
                        "text": f"history row {seq}",
                    }
                    for seq in range(start_seq, start_seq + count)
                ]
            if not isinstance(events_raw, list):
                raise RuntimeError("history.events must be an array")
            request_id = f"history-config-{uuid.uuid4().hex}"
            events = []
            for raw_event in events_raw:
                event = _validate_event(f"history-{len(events)}", raw_event)
                events.append(event_payload_for_frame(
                    script,
                    ScriptedFrame(
                        id=f"history-{len(events)}",
                        at_ms=0,
                        type="chat.event",
                        event=event,
                    ),
                ))
            await _send_json(
                ws,
                {
                    "type": "debug_replay_stream_events_config",
                    "request_id": request_id,
                    "stream_id": script.stream_id,
                    "events": events,
                    "close_after_chunks": int(history.get("close_after_chunks") or 0),
                    "close_once": history.get("close_once") is not False,
                },
            )
            ack = await _recv_type(ws, "debug_replay_stream_events_config.ack", request_id)
            if ack.get("status") != "ok":
                raise RuntimeError(f"debug history config rejected: {ack!r}")

        if script.snapshot:
            # Configure passive responders before this launch-window loop: the
            # app may send or fetch history as soon as a rebroadcast arrives.
            snapshot_attempts = 0
            snapshot_delivered_to_registered_client = False
            for attempt in range(1, 11):
                await asyncio.sleep(0.5)
                snapshot_attempts = attempt
                client_registered = await _client_is_registered(ws, target_client, 10.0)
                request_id = f"snapshot-rebroadcast-{attempt}-{uuid.uuid4().hex}"
                await _send_json(
                    ws,
                    {
                        "type": "debug_replay_snapshot_config",
                        "request_id": request_id,
                        "snapshot": script.snapshot,
                        "host": script.stream["host"],
                        "force_broadcast": True,
                    },
                )
                ack = await _recv_type(ws, "debug_replay_snapshot_config.ack", request_id)
                if ack.get("status") != "ok":
                    raise RuntimeError(f"debug snapshot rebroadcast rejected: {ack!r}")
                if client_registered:
                    snapshot_delivered_to_registered_client = True
                    break
            _log(
                log_sink,
                "snapshot.rebroadcast",
                attempts=snapshot_attempts,
                client_registered=snapshot_delivered_to_registered_client,
            )

        started = time.monotonic()
        started_wall_ms = time.time() * 1000.0
        timeline: list[tuple[int, int, str, ScriptedFrame | ScriptedNotification]] = []
        timeline.extend((frame.at_ms, index, "frame", frame) for index, frame in enumerate(script.frames))
        timeline.extend(
            (notification.at_ms, len(script.frames) + index, "notification", notification)
            for index, notification in enumerate(script.notifications)
        )
        for _at_ms, _index, item_type, item in sorted(timeline, key=lambda row: (row[0], row[1])):
            sleep_s = max(0.0, (item.at_ms / 1000.0) - (time.monotonic() - started))
            if sleep_s:
                await asyncio.sleep(sleep_s)
            if (item.wait_for_client and not script.snapshot) or (item_type == "frame" and item.after_reconnect):
                await _wait_for_client(ws, target_client, wait_client_timeout_s)
            if item_type == "frame" and item.wait_for_disconnect:
                await _wait_for_client_disconnect(ws, target_client, wait_client_timeout_s)
            if item_type == "notification":
                notification_item = item
                notification = await _inject_notification(ws, notification_item)
                _log(
                    log_sink,
                    "notification.sent",
                    id=notification_item.id,
                    notification_id=notification.get("notification_id"),
                    producer=notification.get("producer"),
                    state=notification.get("state"),
                )
                if notification_item.await_resolve:
                    answer = await _await_notification_resolution(
                        ws,
                        str(notification["notification_id"]),
                        notification_item.resolve_timeout_s,
                    )
                    _log(
                        log_sink,
                        "notification.resolve",
                        id=notification_item.id,
                        notification_id=notification.get("notification_id"),
                        question_id=(
                            notification.get("question", {}).get("question_id")
                            if isinstance(notification.get("question"), Mapping)
                            else None
                        ),
                        action_kind=answer.get("action_kind"),
                        selections=answer.get("selections"),
                        text=answer.get("text"),
                        note=answer.get("note"),
                    )
                continue

            frame = item
            payload = event_payload_for_frame(script, frame)
            request_id = f"frame-{frame.id}-{uuid.uuid4().hex}"
            injector_send_wall_ms = time.time() * 1000.0
            await _send_json(
                ws,
                {
                    "type": "debug_replay_event",
                    "request_id": request_id,
                    "expected_stream_id": payload["stream_id"],
                    "harness_replay_timing": {
                        "fixture_at_ms": frame.at_ms,
                        "injector_send_wall_ms": injector_send_wall_ms,
                        "fixture_due_wall_ms": started_wall_ms + frame.at_ms,
                    },
                    "event": payload,
                },
            )
            ack = await _recv_type(ws, "debug_replay_event.ack", request_id)
            if ack.get("status") != "ok":
                raise RuntimeError(f"debug replay rejected frame {frame.id}: {ack!r}")
            ack_wall_ms = time.time() * 1000.0
            _log(
                log_sink,
                "frame.sent",
                id=frame.id,
                seq=payload.get("daemon_seq"),
                at_ms=frame.at_ms,
                injector_send_wall_ms=round(injector_send_wall_ms, 3),
                daemon_accept_wall_ms=ack.get("daemon_accept_wall_ms"),
                ack_wall_ms=round(ack_wall_ms, 3),
                schedule_lag_ms=round(injector_send_wall_ms - (started_wall_ms + frame.at_ms), 3),
                ack_latency_ms=round(ack_wall_ms - injector_send_wall_ms, 3),
                mobile_queue_depths=ack.get("mobile_queue_depths", []),
            )
            # A dense scripted replay can keep receiving immediate acks without
            # handing the loop back to the daemon's other websocket clients.
            # Let send/close responders run between frames so the fixture models
            # concurrent stream traffic instead of serializing it behind replay.
            await asyncio.sleep(0)
            if frame.close_after:
                close_deadline = time.monotonic() + wait_client_timeout_s
                close_attempts = 0
                while True:
                    close_attempts += 1
                    close_id = f"close-{frame.id}-{uuid.uuid4().hex}"
                    await _send_json(
                        ws,
                        {
                            "type": "debug_replay_close",
                            "request_id": close_id,
                            "client": target_client,
                            "code": 4000,
                            "reason": "scripted_reconnect",
                        },
                    )
                    close_ack = await _recv_type(ws, "debug_replay_close.ack", close_id)
                    if close_ack.get("status") != "ok":
                        raise RuntimeError(f"debug close rejected frame {frame.id}: {close_ack!r}")
                    if int(close_ack.get("closed") or 0) > 0:
                        _log(log_sink, "client.closed", id=frame.id, closed=close_ack["closed"], attempts=close_attempts)
                        break
                    if time.monotonic() >= close_deadline:
                        raise TimeoutError(f"debug close found no {target_client!r} client for frame {frame.id}")
                    await asyncio.sleep(0.25)

        if send_echo:
            timeout_s = float(send_echo.get("wait_for_send_s") or 30.0)
            if send_echo.get("expect_upload"):
                upload_init = await _recv_observed(ws, "upload_blob_init", timeout_s)
                _log(log_sink, "upload_blob_init", request_id=upload_init.get("request_id"), size_hint_bytes=upload_init.get("size_hint_bytes"))
                upload_done = await _recv_observed(ws, "upload_blob_chunk", timeout_s)
                _log(
                    log_sink,
                    "upload.ok",
                    request_id=upload_done.get("request_id"),
                    blob_sha=upload_done.get("blob_sha"),
                    size_bytes=upload_done.get("size_bytes"),
                )
            received = await _recv_observed(ws, "send.received", timeout_s)
            _log(
                log_sink,
                "send.received",
                request_id=received.get("request_id"),
                stream_id=received.get("stream_id"),
                optimistic_id=received.get("optimistic_id"),
                attachment_count=received.get("attachment_count"),
                has_localPath=received.get("has_localPath"),
                attachments=received.get("attachments"),
            )
            failed = None
            if isinstance(send_echo.get("fail_first_send"), dict):
                failed = await _recv_observed(ws, "send.failed", timeout_s)
                _log(
                    log_sink,
                    "send.failed",
                    request_id=failed.get("request_id"),
                    stream_id=failed.get("stream_id"),
                    optimistic_id=failed.get("optimistic_id"),
                    reason=failed.get("reason"),
                )
                received = await _recv_observed(ws, "send.received", timeout_s)
                _log(
                    log_sink,
                    "send.received",
                    request_id=received.get("request_id"),
                    stream_id=received.get("stream_id"),
                    optimistic_id=received.get("optimistic_id"),
                    attachment_count=received.get("attachment_count"),
                    has_localPath=received.get("has_localPath"),
                    attachments=received.get("attachments"),
                )
            echoed = await _recv_observed(ws, "send.echoed", timeout_s)
            _log(
                log_sink,
                "send.echoed",
                request_id=echoed.get("request_id"),
                stream_id=echoed.get("stream_id"),
                seq=echoed.get("seq"),
                optimistic_id=echoed.get("optimistic_id"),
            )


def _token_from_file(path: str | Path | None) -> str | None:
    if not path:
        return None
    return Path(path).expanduser().read_text(encoding="utf-8").strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--ws-url")
    parser.add_argument("--token-file")
    parser.add_argument("--harness-env")
    parser.add_argument("--target-client", default="pentacle-mobile")
    parser.add_argument("--wait-client-timeout", type=float, default=30.0)
    args = parser.parse_args(argv)

    ws_url = args.ws_url
    token_file = args.token_file
    if args.harness_env:
        env = read_harness_env(args.harness_env)
        ws_url = ws_url or env.get("WS_URL")
        token_file = token_file or env.get("TOKEN_FILE")
    if not ws_url:
        raise SystemExit("--ws-url or --harness-env with WS_URL is required")

    script = load_script(args.script)
    asyncio.run(
        inject_script(
            script,
            ws_url=ws_url,
            token=_token_from_file(token_file),
            target_client=args.target_client,
            wait_client_timeout_s=args.wait_client_timeout,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
