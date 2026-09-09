from __future__ import annotations

import json

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_history_phantom_local_remainder"


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat", "transcript_load_earlier_probe"]


def params(config: dict) -> dict[str, str]:
    fixture = H.fixture_path(config, name)
    hidden = [
        {**H.history_event(seq), "kind": "SYSTEM", "text": f"hidden local row {seq:04d}"}
        for seq in range(1, 41)
    ]
    visible = [H.history_event(seq) for seq in range(41, 49)]
    payload = {
        "schema_version": 1,
        "name": name,
        "stream": {
            "stream_id": M.STREAM_ID,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": M.SESSION_NAME,
            "title": "Exact local remainder probe",
        },
        "snapshot": {
            "sessions": [{
                "stream_id": M.STREAM_ID,
                "host": M.HOST,
                "provider": M.PROVIDER,
                "session_name": M.SESSION_NAME,
                "title": "Exact local remainder probe",
                "last_text": visible[-1]["text"],
                "last_kind": visible[-1]["kind"],
                "last_event_at": visible[-1]["timestamp"],
                "online": True,
            }],
            "events": [],
        },
        "history": {"events": [*hidden, *visible]},
        "frames": [{
            **H.event(49, at_ms=60_000),
            "event": {**H.history_event(49), "kind": "SYSTEM", "text": "late hidden sentinel"},
        }],
        "upload": {},
        "send_echo": {},
    }
    fixture.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    result = M.params_for_fixture(config, fixture.name)
    result["mock_fixture_path"] = str(fixture)
    result["scripted_daemon_fixture_path"] = str(fixture)
    result["pre_open_wait_ms"] = "5000"
    result["load_earlier_count"] = "1"
    return result


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    done = await_event(
        stream,
        EventSpec(
            "harness:ui_trace",
            where={"kind": "transcript_load_earlier_probe_done", "stream_id": M.STREAM_ID},
            timeout_s=25,
        ),
    )
    steps = [
        row for row in stream.all_events()
        if row.message == "harness:ui_trace"
        and row.data.get("kind") == "transcript_load_earlier_probe_step"
        and row.data.get("stream_id") == M.STREAM_ID
    ]
    affordance = H.first_event(
        stream,
        "harness:ui_trace",
        kind="transcript_load_earlier_affordance_visible",
    )
    failures: list[str] = []
    if not done:
        failures.append("load-earlier probe did not finish")
    elif done.data.get("status") != "no_remaining":
        failures.append(f"expected no_remaining, got {done.data.get('status')}")
    if steps:
        failures.append(f"phantom load-earlier press occurred {len(steps)} time(s)")
    if affordance and int(affordance.data.get("remaining_count") or 0) > 0:
        failures.append(f"affordance exposed phantom local remainder {affordance.data.get('remaining_count')}")
    final_count = int(done.data.get("transcript_count") or 0) if done else 0
    if final_count != 8:
        failures.append(f"expected stable eight-row transcript, got {final_count}")
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "probe_status": done.data.get("status") if done else None,
            "step_count": len(steps),
            "affordance_remaining_count": affordance.data.get("remaining_count") if affordance else None,
            "final_count": final_count,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)
