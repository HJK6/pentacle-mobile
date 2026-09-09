from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_scroll_anchor_live_append"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_scroll_anchor_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name)
    payload["scroll_up_offset"] = "3"
    payload["live_append_seq"] = str(H.LATEST_SEQ + 1)
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    anchored = await_event(stream, EventSpec("harness:ui_trace", where={"kind": "transcript_anchor_configured", "stream_id": M.STREAM_ID}, timeout_s=15))
    before = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_anchor_sample", "phase": "scroll_up_after", "stream_id": M.STREAM_ID, "is_at_bottom": False}, timeout_s=15),
        not_before=anchored.received_at if anchored else None,
    )
    if before:
        M.inject_debug_event(config, H.history_event(H.LATEST_SEQ + 1))
    live = await_event(stream, EventSpec("chat:event_received", where={"stream_id": M.STREAM_ID, "seq": H.LATEST_SEQ + 1, "source": "chat.event"}, timeout_s=20), not_before=before.received_at if before else None)
    update = await_event(stream, EventSpec("harness:ui_trace", where={"kind": "transcript_live_append_visible", "stream_id": M.STREAM_ID, "seq": H.LATEST_SEQ + 1}, timeout_s=10), not_before=live.received_at if live else None)
    after = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_anchor_sample", "phase": "anchored_transcript_update", "stream_id": M.STREAM_ID}, timeout_s=8),
        not_before=update.received_at if update else None,
    )
    suppressed = any(
        event.message == "chat:autoscroll_decision"
        and event.data.get("stream_id") == M.STREAM_ID
        and event.data.get("enabled") is False
        and event.data.get("reason") == "user_not_at_bottom"
        for event in stream.all_events()
    )
    failures: list[str] = []
    if not anchored:
        failures.append("scroll-up anchor was not configured")
    if not before:
        failures.append("scroll-up anchor sample was not recorded")
    elif abs(float(before.data.get("offset") or 0) - 3) > 0.5:
        failures.append(f"scroll-up boundary probe settled at {before.data.get('offset')}, expected 3")
    if not live:
        failures.append("live append was not received after scroll-up")
    if not update:
        failures.append("live append did not produce a causal transcript list update")
    anchor_failure = H.anchor_movement_failure(before.data if before else None, after.data if after else None)
    if anchor_failure:
        failures.append(anchor_failure)
    if not suppressed:
        failures.append("live append did not record user_not_at_bottom autoscroll suppression")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "anchored": anchored is not None,
            "live_received": live is not None,
            "live_update_contains_latest": update is not None,
            "autoscroll_suppressed": suppressed,
            "before_anchor": before.data if before else None,
            "after_anchor": after.data if after else None,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
