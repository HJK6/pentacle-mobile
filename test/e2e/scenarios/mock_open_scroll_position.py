from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_open_scroll_position"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat"]


def params(config: dict) -> dict[str, str]:
    return H.params(config, name)


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    rendered = await_event(stream, EventSpec("harness:transcript_order_dump", where={"stream_id": M.STREAM_ID}, timeout_s=15))
    initial_seqs = H.order_dump_seq_order(dict(rendered.data)) if rendered else []
    settled_seqs = H.await_visible_seq_order(stream, contains=H.LATEST_SEQ, min_count=16, timeout_s=15)
    budget_failures, budgets = H.initial_load_budget_failures(stream)
    failures: list[str] = []
    if not rendered:
        failures.append("missing transcript order dump")
    if H.LATEST_SEQ not in initial_seqs:
        failures.append("latest row not reachable in initial opened window")
    if len(initial_seqs) < 16:
        failures.append(f"initial opened transcript has fewer than initial rows: {len(initial_seqs)}")
    failures.extend(budget_failures)
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "initial_seq_count": len(initial_seqs),
            "initial_contains_latest": H.LATEST_SEQ in initial_seqs,
            "settled_seq_count": len(settled_seqs),
            "settled_contains_latest": H.LATEST_SEQ in settled_seqs,
            **budgets,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
