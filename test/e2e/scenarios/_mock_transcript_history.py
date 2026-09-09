from __future__ import annotations

import json
import time
from pathlib import Path

from . import _mock_chat_streamd as M

EVENT_COUNT = 600
LATEST_SEQ = EVENT_COUNT
SECOND_STREAM_ID = "mock-host:mock-session-b"
SECOND_SESSION_NAME = "mock-session-b"
OPEN_MOUNT_BUDGET_MS = 250
FIRST_PAINT_BUDGET_MS = 1500
LOAD_EARLIER_AFFORDANCE_BUDGET_MS = 1500


def fixture_path(config: dict, scenario_name: str) -> Path:
    run_id = str(config.get("scenario_run_id") or config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or f"mock-{int(time.time())}")
    return Path("/tmp") / f"pentacle-{scenario_name}-{run_id}.json"


def event(seq: int, *, at_ms: int = 0, stream_id: str = M.STREAM_ID, session_name: str = M.SESSION_NAME) -> dict:
    minute = (seq - 1) // 60
    second = (seq - 1) % 60
    return {
        "id": f"{session_name}-history-{seq:04d}",
        "at_ms": at_ms,
        "type": "chat.event",
        "event": {
            "kind": "USER" if seq % 2 else "ASSIST",
            "daemon_seq": seq,
            "timestamp": f"2026-07-10T03:{minute:02d}:{second:02d}.000Z",
            "text": f"{session_name} transcript history row {seq:04d}",
            "stream_id": stream_id,
            "session_name": session_name,
            "host": M.HOST,
            "provider": M.PROVIDER,
        },
    }


def history_event(
    seq: int,
    *,
    stream_id: str = M.STREAM_ID,
    session_name: str = M.SESSION_NAME,
    payload_bytes: int = 0,
) -> dict:
    result = dict(event(seq, stream_id=stream_id, session_name=session_name)["event"])
    if payload_bytes > len(result["text"]):
        result["text"] = f"{result['text']}|" + "x" * (payload_bytes - len(result["text"]) - 1)
    return result


def _history_item(stream_id: str, session_name: str, *, start_seq: int = 1, payload_bytes: int = 0) -> dict:
    return {
        "stream_id": stream_id,
        "events": [history_event(seq, stream_id=stream_id, session_name=session_name, payload_bytes=payload_bytes) for seq in range(start_seq, EVENT_COUNT + 1)],
    }


def _session(stream_id: str, session_name: str) -> dict:
    return {
        "stream_id": stream_id,
        "host": M.HOST,
        "provider": M.PROVIDER,
        "session_name": session_name,
        "title": session_name,
        "last_text": f"{session_name} transcript history row {LATEST_SEQ:04d}",
        "last_event_at": "2026-07-10T03:09:59.000Z",
        "online": True,
    }


def write_fixture(
    config: dict,
    scenario_name: str,
    *,
    live_append: bool = False,
    include_second_stream: bool = False,
    history_start_seq: int = 1,
    payload_bytes: int = 0,
) -> Path:
    path = fixture_path(config, scenario_name)
    frames = []
    if live_append:
        # Simulator launch plus the scripted inventory rebroadcast can consume most of 15s;
        # leave enough headroom for the session-open anchor to settle before the live append.
        live_frame = event(EVENT_COUNT + 1, at_ms=30000)
        live_frame["wait_for_client"] = True
        frames.append(live_frame)
    history_streams = [_history_item(M.STREAM_ID, M.SESSION_NAME, start_seq=history_start_seq, payload_bytes=payload_bytes)]
    if include_second_stream:
        history_streams.append(_history_item(SECOND_STREAM_ID, SECOND_SESSION_NAME, start_seq=history_start_seq, payload_bytes=payload_bytes))
    payload = {
        "schema_version": 1,
        "name": scenario_name,
        "stream": {
            "stream_id": M.STREAM_ID,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": M.SESSION_NAME,
            "title": "Transcript history probe",
        },
        "snapshot": {
            "sessions": [
                _session(M.STREAM_ID, M.SESSION_NAME),
                *([_session(SECOND_STREAM_ID, SECOND_SESSION_NAME)] if include_second_stream else []),
            ],
            "events": [],
        },
        "history": {"streams": history_streams},
        "frames": frames,
        "upload": {},
        "send_echo": {},
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def params(
    config: dict,
    scenario_name: str,
    *,
    live_append: bool = False,
    include_second_stream: bool = False,
    history_start_seq: int = 1,
    payload_bytes: int = 0,
) -> dict[str, str]:
    fixture = write_fixture(
        config,
        scenario_name,
        live_append=live_append,
        include_second_stream=include_second_stream,
        history_start_seq=history_start_seq,
        payload_bytes=payload_bytes,
    )
    payload = M.params_for_fixture(config, fixture.name)
    payload["mock_fixture_path"] = str(fixture)
    payload["scripted_daemon_fixture_path"] = str(fixture)
    payload["pre_open_wait_ms"] = "5000"
    return payload


def latest_list_update(stream, *, stream_id: str = M.STREAM_ID) -> dict:
    latest: dict = {}
    for row in stream.all_events():
        if row.message != "harness:ui_trace":
            continue
        if row.data.get("kind") != "transcript_list_update":
            continue
        if row.data.get("stream_id") != stream_id:
            continue
        latest = dict(row.data)
    return latest


def latest_order_dump(stream, *, stream_id: str = M.STREAM_ID) -> dict:
    latest: dict = {}
    for row in stream.all_events():
        if row.message != "harness:transcript_order_dump":
            continue
        if row.data.get("stream_id") != stream_id:
            continue
        latest = dict(row.data)
    return latest


def order_dump_seq_order(data: dict) -> list[int]:
    order = data.get("transcript_seq_order")
    if not isinstance(order, list):
        return []
    seqs = [int(seq) for seq in order if isinstance(seq, int)]
    return list(reversed(seqs))


def seq_order(data: dict) -> list[int]:
    rows = data.get("row_order")
    if not isinstance(rows, list):
        return []
    seqs: list[int] = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("seq"), int):
            seqs.append(row["seq"])
    return seqs


def visible_seq_order(stream, *, stream_id: str = M.STREAM_ID) -> list[int]:
    seqs = seq_order(latest_list_update(stream, stream_id=stream_id))
    if seqs:
        return seqs
    for row in reversed(stream.all_events()):
        if row.message != "harness:transcript_order_dump":
            continue
        if row.data.get("stream_id") != stream_id:
            continue
        seqs = order_dump_seq_order(dict(row.data))
        if seqs:
            return seqs
    return []


def visible_seq_order_between(stream, *, stream_id: str, not_before: float | None = None, before: float | None = None) -> list[int]:
    latest: list[int] = []
    for row in stream.all_events():
        if not_before is not None and row.received_at < not_before:
            continue
        if before is not None and row.received_at >= before:
            continue
        if row.message == "harness:ui_trace" and row.data.get("kind") == "transcript_list_update":
            if row.data.get("stream_id") == stream_id:
                seqs = seq_order(dict(row.data))
                if seqs:
                    latest = seqs
            continue
        if row.message == "harness:transcript_order_dump" and row.data.get("stream_id") == stream_id:
            seqs = order_dump_seq_order(dict(row.data))
            if seqs:
                latest = seqs
    return latest


def await_visible_seq_order(
    stream,
    *,
    stream_id: str = M.STREAM_ID,
    min_count: int = 1,
    contains: int | None = None,
    timeout_s: float = 15.0,
    not_before: float | None = None,
) -> list[int]:
    deadline = time.monotonic() + timeout_s
    while True:
        seqs = visible_seq_order_between(stream, stream_id=stream_id, not_before=not_before)
        if len(seqs) >= min_count and (contains is None or contains in seqs):
            return seqs
        if time.monotonic() >= deadline:
            return seqs
        stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))


def await_settled_anchor_sample(
    stream,
    *,
    stream_id: str = M.STREAM_ID,
    phase: str = "anchored_transcript_update",
    not_before: float | None = None,
    quiet_s: float = 0.6,
    timeout_s: float = 8.0,
):
    deadline = time.monotonic() + timeout_s
    latest = None
    latest_seen_at = time.monotonic()
    while True:
        for row in stream.all_events():
            if not_before is not None and row.received_at < not_before:
                continue
            if row.message != "harness:ui_trace" or row.data.get("kind") != "transcript_anchor_sample":
                continue
            if row.data.get("stream_id") != stream_id or row.data.get("phase") != phase:
                continue
            if latest is None or row.received_at > latest.received_at:
                latest = row
                latest_seen_at = time.monotonic()
        now = time.monotonic()
        if latest is not None and now - latest_seen_at >= quiet_s:
            return latest
        if now >= deadline:
            return latest
        stream.next_event(timeout_s=min(0.25, deadline - now))


def first_event(stream, message: str, *, stream_id: str = M.STREAM_ID, kind: str | None = None):
    for row in stream.all_events():
        if row.message != message:
            continue
        if stream_id and row.data.get("stream_id") != stream_id:
            continue
        if kind is not None and row.data.get("kind") != kind:
            continue
        return row
    return None


def latency_ms(start, end) -> float | None:
    if not start or not end:
        return None
    return round((end.received_at - start.received_at) * 1000.0, 1)


def initial_load_budget_failures(stream, *, require_affordance: bool = True) -> tuple[list[str], dict]:
    attempted = first_event(stream, "harness:open_existing_chat_attempted")
    mounted = first_event(stream, "harness:session_screen_mount")
    first_paint = first_event(stream, "harness:transcript_order_dump")
    affordance = first_event(stream, "harness:ui_trace", kind="transcript_load_earlier_affordance_visible")
    open_ms = latency_ms(attempted, mounted)
    first_paint_ms = latency_ms(attempted, first_paint)
    affordance_ms = latency_ms(attempted, affordance)
    failures: list[str] = []
    if open_ms is None:
        failures.append("missing open mount timing events")
    elif open_ms > OPEN_MOUNT_BUDGET_MS:
        failures.append(f"open mount latency {open_ms}ms > {OPEN_MOUNT_BUDGET_MS}ms")
    if first_paint_ms is None:
        failures.append("missing first transcript paint timing event")
    elif first_paint_ms > FIRST_PAINT_BUDGET_MS:
        failures.append(f"first paint latency {first_paint_ms}ms > {FIRST_PAINT_BUDGET_MS}ms")
    if require_affordance:
        if affordance_ms is None:
            failures.append("missing load-earlier affordance timing event")
        elif affordance_ms > LOAD_EARLIER_AFFORDANCE_BUDGET_MS:
            failures.append(
                f"load-earlier affordance latency {affordance_ms}ms > {LOAD_EARLIER_AFFORDANCE_BUDGET_MS}ms"
            )
    return failures, {
        "open_mount_ms": open_ms,
        "first_paint_ms": first_paint_ms,
        "load_earlier_affordance_ms": affordance_ms,
    }


def anchor_samples(stream, *, phase: str | None = None, not_before: float | None = None) -> list[dict]:
    samples: list[dict] = []
    cutoff = not_before or 0.0
    for row in stream.all_events():
        if row.received_at < cutoff:
            continue
        if row.message != "harness:ui_trace":
            continue
        if row.data.get("kind") != "transcript_anchor_sample":
            continue
        if row.data.get("stream_id") != M.STREAM_ID:
            continue
        if phase is not None and row.data.get("phase") != phase:
            continue
        sample = dict(row.data)
        sample["_received_at"] = row.received_at
        samples.append(sample)
    return samples


def compact_window_retains_latest(data: dict, *, latest_seq: int = LATEST_SEQ) -> bool:
    return data.get("last_seq") == latest_seq


def anchor_movement_failure(before: dict | None, after: dict | None) -> str | None:
    if not before:
        return "missing before anchor sample"
    if not after:
        return "missing after anchor sample"
    before_seq = before.get("anchor_seq")
    after_seq = after.get("anchor_seq")
    if before_seq is None or after_seq is None:
        return "missing anchor row"
    if before_seq != after_seq:
        return f"anchor row changed {before_seq}->{after_seq}"
    return None
