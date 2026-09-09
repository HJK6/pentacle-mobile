from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import Verdict


name = "chat_event_render_order"


def actions(config: dict) -> list[str]:
    return M.actions(config)


def params(config: dict) -> dict[str, str]:
    return M.params_for_fixture(config, "mock_chat_event_render_order.json")


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    early = M.await_received_and_rendered(stream, [1, 2], name=name)
    if early:
        return early
    early = M.await_rendered(stream, [3], name=name)
    if early:
        return early

    final_order = M.await_transcript_order(stream, [1, 2, 3])
    verdict = Verdict(name=name, verdict="PASS", extras={"final_transcript_seq_order": final_order})
    if final_order != [1, 2, 3]:
        verdict.verdict = "FAIL"
        verdict.error = f"final transcript order {final_order} != daemon order [1, 2, 3]"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
