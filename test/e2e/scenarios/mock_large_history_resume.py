from __future__ import annotations

import time

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_large_history_resume"
LATEST_HISTORY_SEQ = 48
LIVE_BURST_SEQ = 49


def actions(config: dict) -> list[str]:
    return M.actions(config)


def params(config: dict) -> dict[str, str]:
    return M.params_for_fixture(config, "large_history_resume.json")


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def await_latest_history_before_close(stream) -> Verdict | None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if not event:
            continue
        if event.message == "chat:ws_close":
            return Verdict(
                name=name,
                verdict="FAIL",
                error="socket closed before newest history chunk rendered",
            ).finish()
        if (
            event.message == "chat:event_rendered"
            and event.data.get("stream_id") == M.STREAM_ID
            and event.data.get("seq") == LATEST_HISTORY_SEQ
        ):
            return None
    return Verdict(name=name, verdict="FAIL", error="newest history slice did not render before forced close").finish()


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    latest_failure = await_latest_history_before_close(stream)
    if latest_failure:
        return latest_failure

    reconnected = await_event(stream, EventSpec("chat:ws_reconnect_succeeded", timeout_s=45))
    if not reconnected:
        return Verdict(name=name, verdict="FAIL", error="missing reconnect after forced mid-history close").finish()

    oldest = await_event(
        stream,
        EventSpec("chat:event_received", where={"stream_id": M.STREAM_ID, "seq": 1}, timeout_s=30),
        not_before=reconnected.received_at,
    )
    if not oldest:
        return Verdict(name=name, verdict="FAIL", error="older history was not received after reconnect").finish()

    live = await_event(
        stream,
        EventSpec("chat:event_rendered", where={"stream_id": M.STREAM_ID, "seq": LIVE_BURST_SEQ}, timeout_s=30),
        not_before=reconnected.received_at,
    )
    if not live:
        return Verdict(name=name, verdict="FAIL", error="live burst did not render during resumed history").finish()

    final_expected = list(range(34, LIVE_BURST_SEQ + 1))
    final_order = M.await_transcript_order(stream, final_expected, timeout_s=15, not_before=live.received_at)
    received_latest = M.count_events(stream, "chat:event_received", seq=LATEST_HISTORY_SEQ)
    row_mounts_latest = M.count_events(stream, "harness:row_rendered", row_id=str(LATEST_HISTORY_SEQ))
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "received_count_latest": received_latest,
            "row_mounts_latest": row_mounts_latest,
            "final_transcript_seq_order": final_order,
        },
    )
    if final_order != final_expected:
        verdict.verdict = "FAIL"
        verdict.error = f"final transcript order wrong: {final_order}"
    elif row_mounts_latest != 1:
        verdict.verdict = "FAIL"
        verdict.error = f"latest row mounted {row_mounts_latest} times"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
