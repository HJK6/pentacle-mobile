from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_transcript_history as H
from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, await_event
from ..harness.asserts import Verdict

name = "mock_cross_chat_contamination"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_switch_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name, include_second_stream=True)
    payload["switch_stream_id"] = H.SECOND_STREAM_ID
    payload["return_stream_id"] = M.STREAM_ID
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    switched = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_switch_probe_step", "phase": "to_next"}, timeout_s=20),
    )
    returned = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "transcript_switch_probe_step", "phase": "return"}, timeout_s=20),
    )
    if not switched:
        return Verdict(name=name, verdict="FAIL", error="missing switch to second chat").finish()
    if not returned:
        return Verdict(name=name, verdict="FAIL", error="missing return from second chat").finish()
    seqs_a = H.visible_seq_order(stream, stream_id=M.STREAM_ID)
    seqs_b = H.visible_seq_order_between(
        stream,
        stream_id=H.SECOND_STREAM_ID,
        not_before=switched.received_at,
        before=returned.received_at,
    )
    failures: list[str] = []
    for label, event in (("primary", switched), ("second", returned)):
        if int(event.data.get("stream_identity_mismatch_count") or 0) != 0:
            failures.append(f"{label} chat rendered rows owned by another stream")
        if int(event.data.get("stream_identity_match_count") or 0) != int(event.data.get("transcript_count") or 0):
            failures.append(f"{label} chat row identity coverage is incomplete")
    if len(seqs_a) < 16:
        failures.append(f"primary chat window too small: {len(seqs_a)}")
    if len(seqs_b) < 16:
        failures.append(f"second chat window too small: {len(seqs_b)}")
    if len(seqs_a) != len(set(seqs_a)):
        failures.append("primary chat contains duplicate seqs")
    if len(seqs_b) != len(set(seqs_b)):
        failures.append("second chat contains duplicate seqs")
    if seqs_a[:16] != seqs_b[:16]:
        failures.append("same-seq chats rendered different ordering windows")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={"primary_seq_count": len(seqs_a), "second_seq_count": len(seqs_b)},
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
