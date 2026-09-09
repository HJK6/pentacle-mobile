from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_history_pagination_empty_older_page"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_load_earlier_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name, history_start_seq=253)
    payload["load_earlier_count"] = "8"
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    done = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_load_earlier_probe_done", "stream_id": M.STREAM_ID}, timeout_s=25),
    )
    fetch = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_load_earlier_fetch_result", "stream_id": M.STREAM_ID, "received_rows": 0}, timeout_s=10),
    )
    steps = [
        row for row in stream.all_events()
        if row.message == "harness:ui_trace"
        and row.data.get("kind") == "transcript_load_earlier_probe_step"
        and row.data.get("stream_id") == M.STREAM_ID
    ]
    full_page_seen = any(
        row.message == "harness:ui_trace"
        and row.data.get("kind") == "transcript_load_earlier_fetch_result"
        and row.data.get("stream_id") == M.STREAM_ID
        and row.data.get("received_rows") == 48
        for row in stream.all_events()
    )
    failures: list[str] = []
    if not done:
        failures.append("load-earlier probe did not finish")
    elif done.data.get("status") not in ("done", "no_remaining"):
        failures.append(f"load-earlier status {done.data.get('status')}")
    if not full_page_seen:
        failures.append("missing full older page before empty boundary")
    if not fetch:
        failures.append("missing older-page fetch result")
    elif fetch.data.get("received_rows") != 0:
        failures.append(f"expected empty older page, got {fetch.data.get('received_rows')}")
    final_count = int(done.data.get("transcript_count") or 0) if done else 0
    initial_count = int(steps[0].data.get("before_count") or 0) if steps else 0
    if len(steps) != 2:
        failures.append(f"expected full then empty steps, got {len(steps)}")
    elif int(steps[1].data.get("before_count") or 0) != initial_count + 48:
        failures.append("full older page did not add exactly 48 committed rows")
    if done and final_count != initial_count + 48:
        failures.append("empty older page changed the committed transcript window")
    if done and (done.data.get("unique_seq_count") != final_count or done.data.get("seqs_contiguous") is not True):
        failures.append("empty-boundary window is not unique and contiguous")
    if done and not H.compact_window_retains_latest(done.data):
        failures.append("latest row disappeared after empty older page")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "seq_count": final_count,
            "full_page_seen": full_page_seen,
            "fetch_result": fetch.data if fetch else None,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
