from __future__ import annotations

from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_terminal_user_while_working"


def actions(config: dict) -> list[str]:
    return M.actions(config)


def _fixture_path() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "scripted_daemon" / "terminal_user_while_working.json"


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, "terminal_user_while_working.json")
    local_fixture = _fixture_path()
    base["mock_fixture_path"] = str(local_fixture)
    base["scripted_daemon_fixture_path"] = str(local_fixture)
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    early = M.await_received_and_rendered(stream, [20, 21], name=name)
    if early:
        return early

    row = await_event(
        stream,
        EventSpec("harness:row_rendered", where={"stream_id": M.STREAM_ID, "row_id": "21"}, timeout_s=20),
    )
    mount = await_event(
        stream,
        EventSpec("harness:transcript_item_mounted", where={"stream_id": M.STREAM_ID, "id": "21"}, timeout_s=20),
    )
    order = M.await_transcript_order(stream, [20, 21])
    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "working_session_seeded": True,
            "terminal_user_row_rendered": row is not None,
            "terminal_user_item_mounted": mount is not None,
            "final_transcript_seq_order": order,
        },
    )
    if row is None:
        verdict.verdict = "FAIL"
        verdict.error = "terminal USER row did not render"
    elif mount is None:
        verdict.verdict = "FAIL"
        verdict.error = "terminal USER transcript item did not mount"
    elif order != [20, 21]:
        verdict.verdict = "FAIL"
        verdict.error = f"final transcript order {order} != [20, 21]"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
