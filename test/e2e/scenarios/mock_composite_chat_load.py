from __future__ import annotations

import json
import re
import time
from pathlib import Path

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..backed_session_probe import verify_backed_session_closed
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_composite_chat_load"
FIXTURE_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
FRAME_COUNT = 640
# Ten events/second sustains production-like websocket pressure throughout the
# control-plane probe. The former 8 ms cadence (125/s) accumulated a native
# callback backlog that starved command responses, so it measured transport
# queue drain rather than the 2.5 s create/send/delete budgets.
FRAME_INTERVAL_MS = 100
SEED_ACTIVITY_MS = 450
STREAM_START_MS = 1000
PRE_OPEN_WAIT_MS = 80
REPEAT_COUNT = 3
D_STREAM_ID = "mock-host:mock-created"
D_SESSION_NAME = "mock-created"
D_EVENT_AT_MS = 1400

OPEN_MOUNT_BUDGET_MS = 250.0
JS_BLOCK_BUDGET_MS = 1000.0
JS_DRIFT_TRIM_FRACTION = 0.2
SEND_RECONCILE_BUDGET_MS = 2500.0
QUEUED_RENDER_BUDGET_MS = 500.0
CREATE_SETTLE_BUDGET_MS = 2500.0
DELETE_SETTLE_BUDGET_MS = 2500.0


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "composite_chat_load_probe"]


def _fixture_path(config: dict) -> Path:
    run_id = str(
        config.get("scenario_run_id")
        or config.get("RUN_ID")
        or config.get("PENTACLE_RUN_ID")
        or f"mock-{int(time.time())}"
    )
    return Path("/tmp") / f"pentacle-composite-chat-load-{run_id}.json"


def _event(seq: int, at_ms: int) -> dict:
    text = (
        f"composite load frame {seq:04d} "
        + "live-stream payload segment " * 18
        + f"tail-{seq:04d}"
    )
    return {
        "id": f"stream-{seq:04d}",
        "at_ms": at_ms,
        "type": "chat.event",
        "wait_for_client": seq == 1,
        "event": {
            "kind": "ASSIST" if seq > 1 else "USER",
            "daemon_seq": seq,
            "timestamp": f"2026-07-09T18:{seq // 60:02d}:{seq % 60:02d}.000Z",
            "text": text,
        },
    }


def _has_working_root(payload: dict) -> bool:
    sessions = payload.get("snapshot", {}).get("sessions", [])
    events = payload.get("snapshot", {}).get("events", [])
    return (
        len(sessions) == 1
        and sessions[0].get("stream_id") == M.STREAM_ID
        and sessions[0].get("working") is True
        and any(
            event.get("stream_id") == M.STREAM_ID
            and event.get("kind") == "USER"
            and event.get("raw", {}).get("working") is True
            for event in events
        )
    )


def _write_fixture(
    path: Path,
    *,
    frame_interval_ms: int = FRAME_INTERVAL_MS,
    harness_run_id: str = "",
) -> None:
    def at_ms(seq: int) -> int:
        if frame_interval_ms < FRAME_INTERVAL_MS:
            return (seq - 1) * frame_interval_ms
        if seq == 1:
            return 0
        if seq == 2:
            return SEED_ACTIVITY_MS
        return STREAM_START_MS + (seq - 3) * frame_interval_ms

    frames = [
        _event(seq, at_ms(seq))
        for seq in range(1, FRAME_COUNT + 1)
    ]
    frames.append(
        {
            "id": "created-chat",
            "at_ms": D_EVENT_AT_MS,
            "type": "chat.event",
            "event": {
                "kind": "USER",
                "daemon_seq": FRAME_COUNT + 2,
                "timestamp": "2026-07-09T18:12:31.000Z",
                "text": "created chat under composite load",
                "stream_id": D_STREAM_ID,
                "session_name": D_SESSION_NAME,
                "host": M.HOST,
                "provider": M.PROVIDER,
            },
        }
    )
    frames.sort(key=lambda frame: int(frame["at_ms"]))
    payload = {
        "schema_version": 1,
        "name": name,
        "replay_frame_interval_ms": frame_interval_ms,
        "replay_catch_up_late_frames": frame_interval_ms < FRAME_INTERVAL_MS,
        "harness_run_id": harness_run_id,
        "stream": {
            "stream_id": M.STREAM_ID,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": M.SESSION_NAME,
            "title": "Composite chat load",
        },
        "snapshot": {
            "sessions": [
                {
                    "stream_id": M.STREAM_ID,
                    "host": M.HOST,
                    "provider": M.PROVIDER,
                    "session_name": M.SESSION_NAME,
                    "title": "Composite chat load",
                    "last_event_at": "2026-07-09T18:00:00.000Z",
                    "last_kind": "USER",
                    "last_text": "composite root turn",
                    "working": True,
                    "working_label": "Working",
                }
            ],
            "events": [
                {
                    "stream_id": M.STREAM_ID,
                    "host": M.HOST,
                    "provider": M.PROVIDER,
                    "session_name": M.SESSION_NAME,
                    "kind": "USER",
                    "daemon_seq": 0,
                    "timestamp": "2026-07-09T18:00:00.000Z",
                    "text": "composite root turn",
                    "raw": {"source": "terminal", "working": True, "working_label": "Working"},
                }
            ],
        },
        "frames": frames,
        "upload": {"required": True},
        "send_echo": {
            "daemon_seq": FRAME_COUNT + 1,
            "timestamp": "2026-07-09T18:12:30.000Z",
            "wait_for_send_s": 120,
        },
        # A debug-replayed USER frame creates a daemon inventory summary but no
        # backing process exists to complete lifecycle teardown. Once the app
        # starts delete, the test-only daemon entry drops that in-memory summary
        # and emits the authoritative inventory shrink. This models close
        # success without requiring a real host; two intervening 10 Hz frames
        # keep the control action under load.
        "authoritative_remove": {
            "after_frame_id": "stream-0009",
            "host": M.HOST,
            "session_name": D_SESSION_NAME,
        },
    }
    if not _has_working_root(payload):
        raise RuntimeError("composite fixture requires an explicit working root USER event")
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def params_for_interval(
    config: dict,
    *,
    frame_interval_ms: int = FRAME_INTERVAL_MS,
    backed_session: bool = False,
    delete_budget_ms: int = int(DELETE_SETTLE_BUDGET_MS),
) -> dict[str, str]:
    fixture = _fixture_path(config)
    fixture_run_id = fixture.stem.removeprefix("pentacle-composite-chat-load-")
    _write_fixture(
        fixture,
        frame_interval_ms=frame_interval_ms,
        harness_run_id=fixture_run_id,
    )
    payload = M.params_for_fixture(config, fixture.name)
    replay_tool = Path(__file__).resolve().parents[1] / "tools" / "multi_stream_scripted_replay.py"
    payload["mock_fixture_path"] = str(fixture)
    payload["scripted_daemon_fixture_path"] = str(fixture)
    payload["scripted_daemon_replay_tool_path"] = str(replay_tool)
    payload.update(
        {
            "harness_run_id": fixture_run_id,
            "entry_source": "search",
            "text": "p0 composite queued send",
            "image_base64": FIXTURE_IMAGE_B64,
            "image_mime": "image/png",
            "image_name": "p0-composite-load.png",
            "image_width": "1",
            "image_height": "1",
            "image_bytes": "68",
            "pre_open_wait_ms": str(PRE_OPEN_WAIT_MS),
            "repeat_count": str(REPEAT_COUNT),
            "list_dwell_ms": "120",
            "mount_timeout_ms": "12000",
            "working_wait_timeout_ms": "800",
            "js_probe_interval_ms": "50",
            "create_delete_stream_id": D_STREAM_ID,
            "create_delete_session_name": D_SESSION_NAME,
            # The fixture schedules the synthetic create inside the active replay.
            # Starting the observer immediately avoids a JS timer being starved
            # behind the intentionally dense websocket callback queue.
            "create_delete_start_delay_ms": "0.001",
            "create_delete_timeout_ms": str(max(6000, delete_budget_ms)),
            "delete_settle_budget_ms": str(delete_budget_ms),
            "composite_frame_interval_ms": str(frame_interval_ms),
            "create_delete_dwell_ms": "0",
        }
    )
    if backed_session:
        payload.update(
            {
                # Keep the chats list mounted after the first open so the real
                # gate records the user-visible row removal React commit.
                "repeat_count": "1",
                "scripted_daemon_bind_backed_session": "1",
                "scripted_daemon_no_keep_sessions": "1",
                "backed_stream_placeholder": D_STREAM_ID,
                "backed_session_placeholder": D_SESSION_NAME,
            }
        )
    return payload


def expected_harness_run_id(config: dict) -> str:
    return str(
        config.get("harness_run_id")
        or config.get("PENTACLE_RUN_ID")
        or config.get("scenario_run_id")
        or ""
    )


def requires_queued_send(*, backed_probe: bool, frame_interval_ms: int) -> bool:
    return not (backed_probe and frame_interval_ms == 8)


def requires_full_composite_proof(*, overload_probe: bool) -> bool:
    return not overload_probe


def params(config: dict) -> dict[str, str]:
    return params_for_interval(config)


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _events(stream, message: str, *, stream_id: str | None = None, kind: str | None = None):
    rows = []
    for event in stream.all_events():
        if event.message != message:
            continue
        if stream_id is not None and event.data.get("stream_id") != stream_id:
            continue
        if kind is not None and event.data.get("kind") != kind:
            continue
        rows.append(event)
    return rows


def _latency_ms(start, end) -> float:
    return round((end.received_at - start.received_at) * 1000.0, 1)


def _injector_frame_rows(config: dict, *, expected_run_id: str) -> list[dict]:
    injector_path = Path(str(config.get("scripted_daemon_log_path") or ""))
    rows: list[dict] = []
    try:
        for line in injector_path.read_text(encoding="utf-8", errors="replace").splitlines():
            payload = json.loads(line)
            if (
                payload.get("event") == "frame.sent"
                and payload.get("harness_run_id") == expected_run_id
            ):
                rows.append(payload)
    except (OSError, ValueError, TypeError):
        return []
    return rows


def _injector_replay_evidence(config: dict, *, expected_run_id: str) -> dict:
    rows = _injector_frame_rows(config, expected_run_id=expected_run_id)
    sequenced = {
        int(row["seq"]): row
        for row in rows
        if isinstance(row.get("seq"), int) and not isinstance(row.get("seq"), bool)
        and 1 <= int(row["seq"]) <= FRAME_COUNT
    }
    first = sequenced.get(1)
    last = sequenced.get(FRAME_COUNT)
    first_wall = first.get("injector_send_wall_ms") if first else None
    last_wall = last.get("injector_send_wall_ms") if last else None
    observed_rate_hz = None
    if (
        isinstance(first_wall, (int, float))
        and isinstance(last_wall, (int, float))
        and last_wall > first_wall
    ):
        observed_rate_hz = round((FRAME_COUNT - 1) * 1000.0 / (last_wall - first_wall), 2)
    return {
        "harness_run_id": expected_run_id,
        "frame_count": len(sequenced),
        "complete_sequence": sorted(sequenced) == list(range(1, FRAME_COUNT + 1)),
        "first_injector_send_wall_ms": first_wall,
        "last_injector_send_wall_ms": last_wall,
        "observed_rate_hz": observed_rate_hz,
    }


def _daemon_queue_evidence(config: dict, *, expected_run_id: str) -> dict:
    path = Path(str(config.get("scripted_daemon_live_log_path") or ""))
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    highwaters = [int(value) for value in re.findall(r"queue_highwater=(\d+)", text)]
    rows = _injector_frame_rows(config, expected_run_id=expected_run_id)
    depth_rows = [
        row for row in rows
        if isinstance(row.get("mobile_queue_depths"), list)
        and bool(row["mobile_queue_depths"])
        and all(isinstance(value, int) and not isinstance(value, bool) for value in row["mobile_queue_depths"])
    ]
    timing_rows = [
        row for row in rows
        if isinstance(row.get("injector_send_wall_ms"), (int, float))
        and isinstance(row.get("daemon_accept_wall_ms"), (int, float))
    ]
    observed = bool(rows) and len(depth_rows) == len(rows) and len(timing_rows) == len(rows)
    ack_depths = [int(value) for row in depth_rows for value in row["mobile_queue_depths"]]
    return {
        "observed": observed,
        "ack_frame_count": len(rows),
        "timing_frame_count": len(timing_rows),
        "queue_depth_frame_count": len(depth_rows),
        "queue_highwater": max([*highwaters, *ack_depths]) if observed else None,
        "queue_overflow": ("slow_consumer queue overflow" in text) if observed else None,
        "slow_consumer": ("slow_consumer disconnect" in text) if observed else None,
    }


def _open_latencies_ms(stream) -> list[float]:
    attempts = _events(stream, "harness:open_existing_chat_attempted", stream_id=M.STREAM_ID)
    mounts = _events(
        stream,
        "harness:ui_trace",
        stream_id=M.STREAM_ID,
        kind="session_screen_mount",
    )
    latencies: list[float] = []
    used: set[int] = set()
    for attempt in attempts:
        for index, mount in enumerate(mounts):
            if index in used:
                continue
            if mount.received_at < attempt.received_at:
                continue
            used.add(index)
            latencies.append(_latency_ms(attempt, mount))
            break
    return latencies


def _first_ui_trace(stream, kind: str, *, stream_id: str | None = None, not_before: float = 0.0):
    for event in stream.all_events():
        if event.received_at < not_before:
            continue
        if (
            event.message == "harness:ui_trace"
            and event.data.get("kind") == kind
            and (stream_id is None or event.data.get("stream_id") == stream_id)
        ):
            return event
    return None


def run(config: dict, stream, cap=None) -> Verdict:
    scenario_name = str(config.get("composite_scenario_name") or name)
    target_stream_id = str(config.get("create_delete_stream_id") or D_STREAM_ID)
    delete_budget_ms = float(config.get("delete_settle_budget_ms") or DELETE_SETTLE_BUDGET_MS)
    frame_interval_ms = int(config.get("composite_frame_interval_ms") or FRAME_INTERVAL_MS)
    backed_probe = str(config.get("backed_session_probe") or "") == "1"
    expected_run_id = expected_harness_run_id(config)
    overload_probe = backed_probe and frame_interval_ms == 8
    queued_send_required = requires_queued_send(
        backed_probe=backed_probe,
        frame_interval_ms=frame_interval_ms,
    )
    full_composite_proof_required = requires_full_composite_proof(overload_probe=overload_probe)
    ws_open = await_event(stream, EventSpec("chat:ws_open", timeout_s=20))
    if not ws_open:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing chat:ws_open").finish()

    queued = await_event(
        stream,
        EventSpec(
            "harness:ui_trace",
            where={"kind": "send_optimistic_queued"},
            timeout_s=10 if overload_probe else 75,
        ),
    )
    if not queued and queued_send_required:
        return Verdict(name=scenario_name, verdict="FAIL", error="send during stream did not enter queued path").finish()
    optimistic_id = str(queued.data.get("optimistic_id") or "") if queued else ""
    queued_row = sent = reconciled = None
    if queued:
        queued_row = await_event(
            stream,
            EventSpec("harness:row_rendered", where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id}, timeout_s=20),
            not_before=queued.received_at,
        )
        sent = await_event(
            stream,
            EventSpec("harness:ui_trace", where={"kind": "composite_send_sent"}, timeout_s=20),
            not_before=queued.received_at,
        )
        reconciled = await_event(
            stream,
            EventSpec(
                "chat.compose.optimistic_reconciled",
                where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id},
                timeout_s=45,
            ),
            not_before=queued.received_at,
        )

    action_anchor = queued or ws_open
    done = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "composite_load_done"}, timeout_s=35),
        not_before=action_anchor.received_at,
    )
    final_backlog_checkpoint = None
    if overload_probe and expected_run_id:
        final_backlog_checkpoint = await_event(
            stream,
            EventSpec(
                "harness:ui_trace",
                where={
                    "kind": "session_removal_backlog_ws_sample",
                    "harness_run_id": expected_run_id,
                    "seq": FRAME_COUNT,
                },
                timeout_s=20,
            ),
            not_before=ws_open.received_at,
        )
    open_latencies = _open_latencies_ms(stream)
    queued_render_ms = _latency_ms(queued, queued_row) if queued_row else None
    send_reconcile_ms = _latency_ms(queued, reconciled) if reconciled else None
    js_probe = _first_ui_trace(stream, "composite_load_done")
    max_js_drift = float(js_probe.data.get("max_drift_ms") or 0) if js_probe else 0.0
    measured_js_drift = float(
        js_probe.data.get("median_drift_ms")
        or js_probe.data.get("trimmed_max_drift_ms")
        or js_probe.data.get("max_drift_ms")
        or 0
    ) if js_probe else 0.0
    create_done = _first_ui_trace(stream, "composite_create_settled")
    create_ws_callback = _first_ui_trace(stream, "live_new_session_ws_callback", stream_id=target_stream_id)
    create_received = _first_ui_trace(stream, "live_new_session_event_received", stream_id=target_stream_id)
    create_applied = _first_ui_trace(stream, "live_new_session_event_applied", stream_id=target_stream_id)
    delete_start = _first_ui_trace(stream, "composite_delete_start")
    delete_done = _first_ui_trace(stream, "composite_delete_settled")
    create_settle_ms = float(create_done.data.get("duration_ms") or 0) if create_done else None
    create_receipt_to_applied_ms = (
        float(create_applied.data.get("receipt_to_applied_ms") or 0)
        if create_applied else None
    )
    socket_write_to_ws_callback_ms = (
        float(create_ws_callback.data.get("socket_write_start_to_ws_callback_ms") or 0)
        if create_ws_callback else None
    )
    ws_callback_to_handler_ms = (
        float(create_received.data.get("timestamp_emitter_wall") or 0)
        - float(create_ws_callback.data.get("ws_callback_wall_ms") or 0)
        if create_ws_callback and create_received else None
    )
    delete_settle_ms = float(delete_done.data.get("duration_ms") or 0) if delete_done else None
    list_removal = next(
        (
            event for event in _events(stream, "harness:ui_trace", kind="session_list_committed")
            if delete_start is not None
            and event.received_at >= delete_start.received_at
            and target_stream_id not in (event.data.get("stream_ids") or [])
        ),
        None,
    )
    list_removal_ms = (
        round((list_removal.received_at - delete_start.received_at) * 1000, 1)
        if list_removal is not None and delete_start is not None else None
    )

    failures: list[str] = []
    if not backed_probe and len(open_latencies) < 3:
        failures.append(f"repeat nav did not produce enough mounts: {len(open_latencies)}")
    if full_composite_proof_required and not done:
        failures.append("composite action/list navigation did not finish")
    if open_latencies and max(open_latencies) > OPEN_MOUNT_BUDGET_MS:
        failures.append(f"tap-to-mount {max(open_latencies)}ms > {OPEN_MOUNT_BUDGET_MS}ms")
    if measured_js_drift > JS_BLOCK_BUDGET_MS:
        failures.append(f"JS block drift {measured_js_drift}ms > {JS_BLOCK_BUDGET_MS}ms")
    if queued_send_required:
        if queued_render_ms is None:
            failures.append("queued optimistic row never rendered")
        elif queued_render_ms > QUEUED_RENDER_BUDGET_MS:
            failures.append(f"queued row render {queued_render_ms}ms > {QUEUED_RENDER_BUDGET_MS}ms")
        if sent is None:
            failures.append("queued send did not emit terminal sent proof")
        elif sent.data.get("optimistic_id") != optimistic_id or sent.data.get("status") != "ok":
            failures.append("queued send terminal proof did not match the queued optimistic row")
        if send_reconcile_ms is None:
            failures.append("send echo did not reconcile")
        elif send_reconcile_ms > SEND_RECONCILE_BUDGET_MS:
            failures.append(f"send reconcile {send_reconcile_ms}ms > {SEND_RECONCILE_BUDGET_MS}ms")
    if create_done is None:
        failures.append("create-under-load did not settle")
    elif create_done.data.get("status") != "present":
        failures.append(f"create-under-load status {create_done.data.get('status')}")
    elif create_settle_ms is not None and create_settle_ms > CREATE_SETTLE_BUDGET_MS:
        failures.append(f"create settle {create_settle_ms}ms > {CREATE_SETTLE_BUDGET_MS}ms")
    if not backed_probe and (create_received is None or create_received.data.get("stream_id") != target_stream_id):
        failures.append("create-under-load app receipt proof missing")
    if not backed_probe and (
        create_applied is None
        or create_applied.data.get("stream_id") != target_stream_id
        or create_applied.data.get("surfaced") is not True
    ):
        failures.append("create-under-load app surface proof missing")
    if backed_probe and list_removal_ms is None:
        failures.append("session list did not commit authoritative removal")
    elif backed_probe and list_removal_ms > delete_budget_ms:
        failures.append(f"session list removal {list_removal_ms}ms > {delete_budget_ms}ms")
    elif full_composite_proof_required and delete_done is None:
        failures.append("delete-under-load did not settle")
    elif delete_done.data.get("status") != "absent":
        failures.append(f"delete-under-load status {delete_done.data.get('status')}")
    elif not backed_probe and delete_settle_ms is not None and delete_settle_ms > delete_budget_ms:
        failures.append(f"delete settle {delete_settle_ms}ms > {delete_budget_ms}ms")

    control_callbacks = [
        event for event in _events(stream, "harness:ui_trace", kind="session_removal_ws_callback")
        if delete_start is None or event.received_at >= delete_start.received_at
    ]
    callback_order = [str(event.data.get("frame_type") or "") for event in control_callbacks]
    inventory_omitted = any(
        event.data.get("frame_type") == "session.inventory"
        and target_stream_id not in (event.data.get("stream_ids") or [])
        for event in control_callbacks
    )
    current_backlog_samples = [
        event for event in _events(stream, "harness:ui_trace", kind="session_removal_backlog_ws_sample")
        if event.data.get("harness_run_id") == expected_run_id
        and event.data.get("stream_id") == M.STREAM_ID
    ]
    backlog_samples = [
        event for event in current_backlog_samples
        if delete_start is not None
        and event.received_at >= delete_start.received_at
        and (list_removal is None or event.received_at <= list_removal.received_at)
    ]
    replay_evidence = _injector_replay_evidence(config, expected_run_id=expected_run_id)
    queue_evidence = _daemon_queue_evidence(config, expected_run_id=expected_run_id)
    reconnect_observed = any(event.message == "chat:ws_reconnect_succeeded" for event in stream.all_events())
    backed_evidence = None
    if backed_probe:
        backed_evidence, backed_error = verify_backed_session_closed(config)
        if backed_error:
            failures.append(backed_error)
        if "close.ok" not in callback_order and "close.degraded" not in callback_order:
            failures.append("close response callback proof missing")
        if any(event.data.get("deferred") is True for event in control_callbacks):
            failures.append("close response was deferred instead of using the production close core")
        if not inventory_omitted:
            failures.append("post-close inventory omission callback proof missing")
    if overload_probe:
        expected_rate_hz = 1000.0 / frame_interval_ms
        observed_rate_hz = replay_evidence.get("observed_rate_hz")
        checkpoint_seqs = {event.data.get("seq") for event in current_backlog_samples}
        required_checkpoints = set(range(64, FRAME_COUNT + 1, 64))
        if not expected_run_id:
            failures.append("overload replay run id missing")
        if replay_evidence.get("complete_sequence") is not True:
            failures.append(f"overload replay incomplete: {replay_evidence.get('frame_count')}/{FRAME_COUNT}")
        if not isinstance(observed_rate_hz, (int, float)) or not (expected_rate_hz * 0.9 <= observed_rate_hz <= expected_rate_hz * 1.1):
            failures.append(f"overload replay cadence {observed_rate_hz}Hz != {expected_rate_hz}Hz")
        if queue_evidence.get("observed") is not True:
            failures.append("daemon queue/timing evidence unobserved")
        if final_backlog_checkpoint is None or not required_checkpoints.issubset(checkpoint_seqs):
            failures.append("current-run backlog delivery checkpoints incomplete")
        if not backlog_samples:
            failures.append("current-run backlog delivery was not observed during delete")
        elif any(
            not isinstance(event.data.get("injector_send_wall_ms"), (int, float))
            or not isinstance(event.data.get("daemon_accept_wall_ms"), (int, float))
            or not isinstance(event.data.get("daemon_socket_write_start_wall_ms"), (int, float))
            or not isinstance(event.data.get("socket_write_start_to_ws_callback_ms"), (int, float))
            for event in backlog_samples
        ):
            failures.append("current-run backlog delivery timing incomplete")

    verdict = Verdict(
        name=scenario_name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "stream_id": M.STREAM_ID,
            "frame_count": FRAME_COUNT,
            "frame_interval_ms": frame_interval_ms,
            "open_mount_latencies_ms": open_latencies,
            "max_open_mount_latency_ms": max(open_latencies) if open_latencies else None,
            "js_max_drift_ms": max_js_drift,
            "js_measured_drift_ms": measured_js_drift,
            "js_drift_metric": "median_drift_ms",
            "queued_render_ms": queued_render_ms,
            "queued_row_rendered": queued_row is not None,
            "send_reconcile_ms": send_reconcile_ms,
            "send_reconciled": reconciled is not None,
            "create_settle_ms": create_settle_ms,
            "create_settled": create_done is not None,
            "create_event_received": create_received is not None,
            "create_event_surfaced": bool(create_applied and create_applied.data.get("surfaced")),
            "create_receipt_to_applied_ms": create_receipt_to_applied_ms,
            "create_ws_callback": create_ws_callback is not None,
            "socket_write_to_ws_callback_ms": socket_write_to_ws_callback_ms,
            "ws_callback_to_handler_ms": ws_callback_to_handler_ms,
            "create_transport_timing": dict(create_ws_callback.data) if create_ws_callback else None,
            "delete_settle_ms": list_removal_ms if backed_probe else delete_settle_ms,
            "delete_action_settle_ms": delete_settle_ms,
            "session_list_removal_ms": list_removal_ms,
            "delete_settled": delete_done is not None,
            "control_callback_order": callback_order,
            "inventory_omitted_target": inventory_omitted,
            "backlog_socket_samples": [dict(event.data) for event in backlog_samples],
            "backlog_delivery_checkpoints": [dict(event.data) for event in current_backlog_samples],
            "injector_replay": replay_evidence,
            "daemon_queue": queue_evidence,
            "reconnect_observed": reconnect_observed,
            "backed_session": backed_evidence,
            "optimistic_id": optimistic_id,
            "budgets_ms": {
                "open_mount": OPEN_MOUNT_BUDGET_MS,
                "js_block": JS_BLOCK_BUDGET_MS,
                "queued_render": QUEUED_RENDER_BUDGET_MS,
                "send_reconcile": SEND_RECONCILE_BUDGET_MS,
                "create_settle": CREATE_SETTLE_BUDGET_MS,
                "delete_settle": delete_budget_ms,
            },
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=scenario_name)
