from __future__ import annotations

import json
import time

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from . import _wire_contract as W
from ..harness.asserts import Verdict

name = "mock_peer_tell_expand"
CARD_ID = "agent-message-card-51"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat"]


def params(config: dict) -> dict[str, str]:
    run_id = str(config.get("scenario_run_id") or "peer-tell")
    first = f"Peer tell {run_id}"
    final = f"Final peer detail {run_id}"
    fixture = H.fixture_path(config, name)
    events = [
        {**H.history_event(50), "kind": "ASSIST", "text": "Before peer tell"},
        {
            **H.history_event(51),
            "kind": "USER",
            "text": f"[from hostc:provider-example] [tell:{run_id}]\n{first}\nSecond peer detail\n{final}",
        },
        {**H.history_event(52), "kind": "ASSIST", "text": "After peer tell"},
    ]
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": {
            "stream_id": M.STREAM_ID,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": M.SESSION_NAME,
            "title": "Peer tell expand probe",
        },
        "snapshot": {
            "sessions": [{
                "stream_id": M.STREAM_ID,
                "host": M.HOST,
                "provider": M.PROVIDER,
                "session_name": M.SESSION_NAME,
                "title": "Peer tell expand probe",
                "last_text": events[-1]["text"],
                "last_kind": events[-1]["kind"],
                "last_event_at": events[-1]["timestamp"],
                "online": True,
            }],
            "events": [],
        },
        "history": {"events": events},
        "frames": [{
            **H.event(53, at_ms=60_000),
            "event": {**H.history_event(53), "kind": "SYSTEM", "text": "late hidden sentinel"},
        }],
        "upload": {},
        "send_echo": {},
    }
    fixture.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    result = M.params_for_fixture(config, fixture.name)
    result.update({
        "mock_fixture_path": str(fixture),
        "scripted_daemon_fixture_path": str(fixture),
        "peer_tell_first": first,
        "peer_tell_final": final,
        "pre_open_wait_ms": "5000",
    })
    return result


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _await_card_label(udid: str, predicate, timeout_s: float = 12) -> tuple[str | None, str | None]:
    deadline = time.monotonic() + timeout_s
    last_error = None
    while time.monotonic() < deadline:
        element, error = W.await_element(udid, CARD_ID, timeout_s=0.5)
        if error:
            last_error = error
        elif element is not None:
            label = str(element.get("AXLabel") or "")
            if predicate(label):
                return label, None
        time.sleep(0.1)
    return None, last_error or "peer tell card accessibility label did not reach the expected state"


def run(config: dict, stream, cap=None) -> Verdict:
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    early = M.await_received_and_rendered(stream, [50, 51, 52], name=name)
    if early:
        return early

    udid = str(config["PENTACLE_TARGET_UDID"])
    first = str(config["peer_tell_first"])
    final = str(config["peer_tell_final"])
    failures: list[str] = []
    collapsed, error = _await_card_label(udid, lambda label: first in label and final not in label)
    if error:
        failures.append(error)
    elif W.tap(udid, CARD_ID):
        failures.append("peer tell card could not be tapped")
    expanded, error = _await_card_label(udid, lambda label: first in label and final in label)
    if error:
        failures.append(error)
    elif W.tap(udid, CARD_ID):
        failures.append("expanded peer tell card could not be tapped")
    recollapsed, error = _await_card_label(udid, lambda label: first in label and final not in label)
    if error:
        failures.append(error)

    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "collapsed_first_line_only": bool(collapsed),
            "expanded_final_line": bool(expanded),
            "recollapsed_first_line_only": bool(recollapsed),
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)

