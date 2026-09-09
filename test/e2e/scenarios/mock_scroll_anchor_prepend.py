from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_scroll_anchor_prepend"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_scroll_anchor_probe", "transcript_load_earlier_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name)
    payload["load_earlier_count"] = "1"
    payload["load_earlier_wait_for_scroll_up"] = "1"
    payload["scroll_up_offset"] = "480"
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    scrolled = await_event(stream, EventSpec("harness:ui_trace", where={"kind": "transcript_anchor_sample", "phase": "scroll_up_after", "stream_id": M.STREAM_ID, "is_at_bottom": False}, timeout_s=15))
    before_event = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_anchor_sample", "phase": "before_load_earlier", "stream_id": M.STREAM_ID}, timeout_s=8),
        not_before=scrolled.received_at if scrolled else None,
    )
    done = await_event(stream, EventSpec("harness:ui_trace", where={"kind": "transcript_load_earlier_probe_done", "stream_id": M.STREAM_ID}, timeout_s=25), not_before=before_event.received_at if before_event else None)
    after_event = H.await_settled_anchor_sample(stream, not_before=done.received_at if done else None)
    anchor_failure = H.anchor_movement_failure(before_event.data if before_event else None, after_event.data if after_event else None)
    failures: list[str] = []
    if not scrolled or scrolled.data.get("is_at_bottom") is not False:
        failures.append("prepend probe did not establish a scrolled-up viewport")
    if not done:
        failures.append("load-earlier probe did not finish")
    elif done.data.get("anchor_mode") != "maintain_visible_content_position":
        failures.append("missing prepend anchor mode")
    if anchor_failure:
        failures.append(anchor_failure)
    before_count = int(before_event.data.get("transcript_count") or 0) if before_event else 0
    after_count = int(after_event.data.get("transcript_count") or 0) if after_event else 0
    if before_event and after_event and after_count != before_count + 48:
        failures.append(f"prepend committed {after_count - before_count} rows, expected 48")
    if after_event and (after_event.data.get("unique_seq_count") != after_count or after_event.data.get("seqs_contiguous") is not True):
        failures.append("prepend result is not unique and contiguous")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "anchor_mode": done.data.get("anchor_mode") if done else None,
            "scrolled_anchor": scrolled.data if scrolled else None,
            "before_anchor": before_event.data if before_event else None,
            "after_anchor": after_event.data if after_event else None,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
