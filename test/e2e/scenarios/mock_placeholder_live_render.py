from __future__ import annotations

import time

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_placeholder_live_render"
FIXTURE_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="


def actions(config: dict) -> list[str]:
    del config
    return ["autoaccept_biometric", "open_existing_chat", "send_fixture_image"]


def params(config: dict) -> dict[str, str]:
    payload = M.params_for_fixture(config, "placeholder_live_render.json")
    payload.update(
        {
            "entry_source": "search",
            "text": "example placeholder echo",
            "image_base64": FIXTURE_IMAGE_B64,
            "image_mime": "image/png",
            "image_name": "example-placeholder.png",
            "image_width": "1",
            "image_height": "1",
            "image_bytes": "68",
        }
    )
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _await_trace_without_pending(stream, *, optimistic_id: str):
    def matches(event) -> bool:
        if event.message != "harness:ui_trace":
            return False
        if event.data.get("kind") != "transcript_list_update":
            return False
        if event.data.get("stream_id") != M.STREAM_ID:
            return False
        if event.data.get("pending_count") != 0:
            return False
        order = event.data.get("row_order")
        if not isinstance(order, list):
            return False
        for row in order:
            if not isinstance(row, dict):
                continue
            if row.get("id") == optimistic_id and row.get("send_state") is None and row.get("pending") is False:
                return True
        return False

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        for event in stream.all_events():
            if matches(event):
                return event
        stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
    return None


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    early = M.await_received_and_rendered(stream, [91, 92], name=name)
    if early:
        return early

    terminal_mount = await_event(
        stream,
        EventSpec("harness:transcript_item_mounted", where={"stream_id": M.STREAM_ID, "id": "92"}, timeout_s=20),
    )
    if not terminal_mount:
        return Verdict(name=name, verdict="FAIL", error="queued terminal steering row did not mount").finish()

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
            where={"stream_id": M.STREAM_ID, "correlated_daemon_seq": 93, "optimistic_id": optimistic_id},
            timeout_s=20,
        ),
        not_before=reconciled.received_at,
    )
    if not echo:
        return Verdict(name=name, verdict="FAIL", error="reconciled app send echo did not render").finish()

    settled_trace = _await_trace_without_pending(stream, optimistic_id=optimistic_id)
    if not settled_trace or settled_trace.data.get("pending_count") != 0:
        return Verdict(name=name, verdict="FAIL", error="app send stayed pending after echo").finish()

    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "live_seq": 91,
            "queued_terminal_seq": 92,
            "echo_seq": 93,
            "optimistic_id": optimistic_id,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)

