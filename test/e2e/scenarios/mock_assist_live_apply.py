from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_assist_live_apply"


def actions(config: dict) -> list[str]:
    return M.actions(config)


def params(config: dict) -> dict[str, str]:
    return M.params_for_fixture(config, "assist_live_apply.json")


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    early = M.await_rendered(stream, [10], name=name)
    if early:
        return early
    early = M.await_received_and_rendered(stream, [11], name=name)
    if early:
        return early

    row = await_event(
        stream,
        EventSpec("harness:row_rendered", where={"stream_id": M.STREAM_ID, "row_id": "11"}, timeout_s=20),
    )
    mount = await_event(
        stream,
        EventSpec("harness:transcript_item_mounted", where={"stream_id": M.STREAM_ID, "id": "11"}, timeout_s=20),
    )
    mount_count = M.count_events(stream, "harness:session_screen_mount")
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "assist_row_rendered": row is not None,
            "assist_transcript_item_mounted": mount is not None,
            "session_mount_count": mount_count,
        },
    )
    if row is None:
        verdict.verdict = "FAIL"
        verdict.error = "ASSIST row did not mount/render"
    elif mount is None:
        verdict.verdict = "FAIL"
        verdict.error = "ASSIST transcript item did not mount"
    elif mount_count != 1:
        verdict.verdict = "FAIL"
        verdict.error = f"mock session remounted {mount_count} times"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
