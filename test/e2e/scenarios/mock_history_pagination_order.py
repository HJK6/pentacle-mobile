from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_history_pagination_order"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_load_earlier_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name)
    payload["load_earlier_count"] = "2"
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    done = await_event(stream, EventSpec("harness:ui_trace", where={"kind": "transcript_load_earlier_probe_done", "stream_id": M.STREAM_ID}, timeout_s=25))
    steps = [
        row for row in stream.all_events()
        if row.message == "harness:ui_trace"
        and row.data.get("kind") == "transcript_load_earlier_probe_step"
        and row.data.get("stream_id") == M.STREAM_ID
    ]
    fetches = [
        row for row in stream.all_events()
        if row.message == "harness:ui_trace"
        and row.data.get("kind") == "transcript_load_earlier_fetch_result"
        and row.data.get("stream_id") == M.STREAM_ID
    ]
    budget_failures, budgets = H.initial_load_budget_failures(stream)
    failures: list[str] = []
    if not done:
        failures.append("load-earlier probe did not finish")
    elif done.data.get("status") != "done":
        failures.append(f"load-earlier status {done.data.get('status')}")
    if len(steps) != 2:
        failures.append(f"expected exactly two pagination steps, got {len(steps)}")
    elif any(not H.compact_window_retains_latest(row.data) for row in steps):
        failures.append("expanded pagination window lost the latest row")
    if len(fetches) < 2 or any(row.data.get("received_rows") != 48 for row in fetches[:2]):
        failures.append("repeated older-page fetches did not return two full 48-row pages")
    final_count = int(done.data.get("transcript_count") or 0) if done else 0
    initial_count = int(steps[0].data.get("before_count") or 0) if steps else 0
    expected_count = initial_count + 96
    if len(steps) == 2 and int(steps[1].data.get("before_count") or 0) != initial_count + 48:
        failures.append("first full page did not add exactly 48 committed rows")
    if done and final_count != expected_count:
        failures.append(f"two full pages committed {final_count - initial_count} rows, expected 96")
    if done and (done.data.get("unique_seq_count") != final_count or done.data.get("seqs_contiguous") is not True):
        failures.append("final pagination window is not unique and contiguous")
    if done and not H.compact_window_retains_latest(done.data):
        failures.append("latest row not reachable after pagination")
    failures.extend(budget_failures)
    verdict = Verdict(name=name, verdict="FAIL" if failures else "PASS", error="; ".join(failures) if failures else None, extras={"pagination_step_count": len(steps), "older_page_fetch_count": len(fetches), "seq_count": final_count, **budgets})
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
