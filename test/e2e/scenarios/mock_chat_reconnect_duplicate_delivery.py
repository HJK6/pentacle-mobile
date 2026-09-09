from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_chat_reconnect_duplicate_delivery"


def actions(config: dict) -> list[str]:
    return M.actions(config)


def params(config: dict) -> dict[str, str]:
    return M.params_for_fixture(config, "reconnect_duplicate.json")


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    initial = await_event(
        stream,
        EventSpec("chat:event_rendered", where={"stream_id": M.STREAM_ID, "seq": 20}, timeout_s=30),
    )
    if not initial:
        return Verdict(name=name, verdict="FAIL", error="missing initial duplicate-source rendered row").finish()
    reconnected = await_event(stream, EventSpec("chat:ws_reconnect_succeeded", timeout_s=45))
    if not reconnected:
        return Verdict(name=name, verdict="FAIL", error="missing chat:ws_reconnect_succeeded").finish()
    duplicate = await_event(
        stream,
        EventSpec("chat:event_received", where={"stream_id": M.STREAM_ID, "seq": 20}, timeout_s=30),
        not_before=reconnected.received_at,
    )
    if not duplicate:
        return Verdict(name=name, verdict="FAIL", error="missing duplicate receive after reconnect").finish()
    rendered = await_event(
        stream,
        EventSpec("chat:event_rendered", where={"stream_id": M.STREAM_ID, "seq": 20}, timeout_s=30),
        not_before=duplicate.received_at,
    )
    if not rendered:
        return Verdict(name=name, verdict="FAIL", error="missing rendered duplicate-source row").finish()

    received_count = M.count_events(stream, "chat:event_received", seq=20)
    row_mounts = M.count_events(stream, "harness:row_rendered", row_id="20")
    final_order = M.latest_rendered_order(stream, {20})
    final_transcript_order = M.await_transcript_order(stream, [20], not_before=duplicate.received_at)
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "received_count_seq20": received_count,
            "row_mounts_seq20": row_mounts,
            "final_rendered_seq_order": final_order,
            "final_transcript_seq_order": final_transcript_order,
        },
    )
    if received_count < 2:
        verdict.verdict = "FAIL"
        verdict.error = f"expected duplicate daemon_seq inbound twice, got {received_count}"
    elif row_mounts != 1:
        verdict.verdict = "FAIL"
        verdict.error = f"duplicate daemon_seq rendered/mounted {row_mounts} rows"
    elif final_order != [20]:
        verdict.verdict = "FAIL"
        verdict.error = f"final duplicate transcript order/count wrong: {final_order}"
    elif final_transcript_order != [20]:
        verdict.verdict = "FAIL"
        verdict.error = f"final duplicate transcript dump wrong: {final_transcript_order}"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
