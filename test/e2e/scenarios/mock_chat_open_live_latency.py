from __future__ import annotations

import time
import json

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_chat_open_live_latency"
FIXTURE_IMAGE_B64 = "c3ludGhldGljLWltYWdl"
HISTORY_EVENT_COUNT = H.EVENT_COUNT
HISTORY_EVENT_PAYLOAD_BYTES = 8_192
LIVE_SEQ = HISTORY_EVENT_COUNT + 1
SEND_ECHO_SEQ = HISTORY_EVENT_COUNT + 2
# The synthetic latency budget is fixed so this example is reproducible.
LIVE_RENDER_BUDGET_MS = 1_000.0


def actions(config: dict) -> list[str]:
    del config
    return ["autoaccept_biometric", "open_existing_chat", "send_fixture_image"]


def params(config: dict) -> dict[str, str]:
    fixture = H.write_fixture(config, name, live_append=True, payload_bytes=HISTORY_EVENT_PAYLOAD_BYTES)
    fixture_payload = json.loads(fixture.read_text(encoding="utf-8"))
    fixture_payload["upload"] = {"required": True}
    fixture_payload["send_echo"] = {
        "daemon_seq": SEND_ECHO_SEQ,
        "timestamp": "2026-07-10T03:10:02.000Z",
        "wait_for_send_s": 30,
    }
    fixture.write_text(json.dumps(fixture_payload, separators=(",", ":")) + "\n", encoding="utf-8")
    payload = M.params_for_fixture(config, fixture.name)
    payload["mock_fixture_path"] = str(fixture)
    payload["scripted_daemon_fixture_path"] = str(fixture)
    payload.update(
        {
            "entry_source": "search",
            "text": "example live latency app send",
            "image_base64": FIXTURE_IMAGE_B64,
            "image_mime": "image/png",
            "image_name": "example-live-latency.png",
            "image_width": "1",
            "image_height": "1",
            "image_bytes": "68",
            "history_event_count": str(HISTORY_EVENT_COUNT),
            "history_fixture_bytes": str(fixture.stat().st_size),
        }
    )
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _first_event(stream, message: str, *, stream_id: str | None = None):
    for event in stream.all_events():
        if event.message != message:
            continue
        if stream_id is not None and event.data.get("stream_id") != stream_id:
            continue
        return event
    return None


def _latency_ms(start, end) -> float:
    return round((end.received_at - start.received_at) * 1000.0, 1)


def run(config: dict, stream, cap=None) -> Verdict:
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    opened = _first_event(stream, "harness:open_existing_chat_attempted", stream_id=M.STREAM_ID)
    mounted = _first_event(stream, "harness:session_screen_mount", stream_id=M.STREAM_ID)
    spinner = _first_event(stream, "chat.open.spinner_on_open", stream_id=M.STREAM_ID)
    instant = _first_event(stream, "chat.open.instant_open", stream_id=M.STREAM_ID)
    if not opened or not mounted:
        return Verdict(name=name, verdict="FAIL", error="missing open/mount telemetry").finish()
    open_ms = _latency_ms(opened, mounted)
    if not spinner and not instant:
        return Verdict(name=name, verdict="FAIL", error="missing chat open loading/instant telemetry").finish()

    received = await_event(
        stream,
        EventSpec("chat:event_received", where={"stream_id": M.STREAM_ID, "seq": LIVE_SEQ}, timeout_s=40),
    )
    if not received:
        return Verdict(name=name, verdict="FAIL", error=f"missing live event receive seq={LIVE_SEQ}").finish()
    rendered = await_event(
        stream,
        EventSpec("chat:event_rendered", where={"stream_id": M.STREAM_ID, "seq": LIVE_SEQ}, timeout_s=20),
        not_before=received.received_at,
    )
    if not rendered:
        return Verdict(name=name, verdict="FAIL", error=f"missing live event render seq={LIVE_SEQ}").finish()
    live_ms = _latency_ms(received, rendered)
    if live_ms > LIVE_RENDER_BUDGET_MS:
        return Verdict(name=name, verdict="FAIL", error=f"live event render latency {live_ms}ms").finish()

    optimistic = await_event(
        stream,
        EventSpec("chat.compose.optimistic_insert", where={"stream_id": M.STREAM_ID}, timeout_s=20),
    )
    if not optimistic:
        return Verdict(name=name, verdict="FAIL", error="missing optimistic insert for app send").finish()
    optimistic_id = str(optimistic.data.get("optimistic_id") or "")
    sent = await_event(
        stream,
        EventSpec("harness:send_fixture_image_sent", where={"stream_id": M.STREAM_ID}, timeout_s=20),
        not_before=optimistic.received_at,
    )
    if not sent or sent.data.get("status") != "ok":
        return Verdict(name=name, verdict="FAIL", error=f"app send did not dispatch: {getattr(sent, 'data', None)}").finish()
    reconciled = await_event(
        stream,
        EventSpec(
            "chat.compose.optimistic_reconciled",
            where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id},
            timeout_s=30,
        ),
        not_before=optimistic.received_at,
    )
    if not reconciled:
        return Verdict(name=name, verdict="FAIL", error="app send echo did not reconcile").finish()
    echo = await_event(
        stream,
        EventSpec(
            "chat:event_rendered",
            where={"stream_id": M.STREAM_ID, "correlated_daemon_seq": SEND_ECHO_SEQ, "optimistic_id": optimistic_id},
            timeout_s=20,
        ),
        not_before=reconciled.received_at,
    )
    if not echo:
        return Verdict(name=name, verdict="FAIL", error="reconciled app send echo did not render").finish()

    budget_failures, initial_latencies = H.initial_load_budget_failures(stream)
    fixture_events = int(config.get("history_event_count") or 0)
    fixture_bytes = int(config.get("history_fixture_bytes") or 0)
    if fixture_events < HISTORY_EVENT_COUNT or fixture_bytes < 2 * 1024 * 1024:
        budget_failures.append(f"fixture scale is {fixture_events} events/{fixture_bytes} bytes")

    verdict = Verdict(
        name=name,
        verdict="FAIL" if budget_failures else "PASS",
        error="; ".join(budget_failures) if budget_failures else None,
        extras={
            "open_mount_latency_ms": open_ms,
            "initial_load_latencies_ms": initial_latencies,
            "live_receive_to_render_ms": live_ms,
            "optimistic_id": optimistic_id,
            "spinner_seen": spinner is not None,
            "instant_open_seen": instant is not None,
            "live_seq": LIVE_SEQ,
            "history_event_count": fixture_events,
            "history_fixture_bytes": fixture_bytes,
            "latency_budgets_ms": {
                "tap_to_mount": H.OPEN_MOUNT_BUDGET_MS,
                "tap_to_first_paint": H.FIRST_PAINT_BUDGET_MS,
                "tap_to_load_earlier": H.LOAD_EARLIER_AFFORDANCE_BUDGET_MS,
                "broadcast_to_render": LIVE_RENDER_BUDGET_MS,
            },
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
