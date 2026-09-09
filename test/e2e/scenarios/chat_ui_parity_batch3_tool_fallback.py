from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": ["claude"]}

import time
from typing import Callable

from . import _biometric_matrix_fixture as BM
from . import _assertions as A
from ..harness.asserts import Verdict, await_event, EventSpec


name = "chat_ui_parity_tool_fallback"

TOOL_PROMPT = (
    "Use the example tool to run `printf example-tool-fallback`, "
    "then reply exactly `example assistant done`."
)
TOOL_ACTION_RULES = {
    "activity:command",
    "activity:tool-output",
    "activity:tool-batch",
    "activity:collapsed-tool",
    "activity:explored",
    "activity:file-change",
    "activity:code-block",
}
# A tool fallback may appear as one of these structured tool components.
# Check both activity rows and structured components so the example fails closed.
TOOL_COMPONENT_RULES = {
    "component:tool-invocation-card",
    "component:tool-result-card",
}
# Structured tool kinds carried in a rendered chat event.
TOOL_KINDS = {"TOOL", "TOOL-OUT", "TOOL_USE", "TOOL_RESULT"}
COMMAND_PREFIX_MARKERS = (
    "Bash",  # covers "Bash(", "Bash ", and "Bash\n<command>" (the live shape)
    "bash ",
    "$ ",
    "printf example-tool-fallback",
)
FINAL_ASSISTANT_TIMEOUT_S = 120.0


def actions(_config):
    out = [
        "autoaccept_biometric",
        "write_user_preference",
        "spawn_chat_then_send",
    ]
    if str(_config.get("PENTACLE_E2E_TARGET") or "").lower() != "simulator":
        out.insert(1, "disable_pentacle_auth")
    return out


def params(config):
    out = {
        "host": "hostc",
        "provider": "claude",
        "pref": "showToolActions",
        "value": "false",
        "text": TOOL_PROMPT,
    }
    if str(config.get("PENTACLE_E2E_TARGET") or "").lower() == "simulator":
        fixture = BM.write_spawn_chat_fixture(
            config,
            scenario_name=name,
            host="hostc",
            provider="claude",
            assistant_replies=["example assistant done"],
        )
        out["mock_fixture_path"] = str(fixture)
        out["scripted_daemon_fixture_path"] = str(fixture)
    return out


def preflight(config: dict, repo_root=None) -> str | None:
    host = str(config.get("host") or "hostc").strip()
    provider = str(config.get("provider") or "claude").strip()
    if not host:
        return "missing_host"
    if provider != "claude":
        return "requires_claude_provider"
    return None


def _build_steps(stream_id: str):
    def P(d: dict) -> bool:
        return d.get("stream_id") == stream_id

    return [
        A.strict("harness:harness_armed", count=1, label="01 harness_armed"),
        A.group(
            "pref",
            "harness:write_user_preference_done",
            count=1,
            where=lambda d: d.get("key") == "showToolActions" and d.get("value") is False,
            label="02 tools_hidden_pref",
        ),
        A.strict("chat:ws_open", count=1, label="03 ws_open"),
        A.strict("harness:spawn_chat_then_send_scheduled", count=1, label="04 spawn_scheduled"),
        A.strict("harness:session_screen_mount", count=1, where=P, label="05 session_screen_mount"),
        A.strict("harness:transcript_ready_settled", count=1, where=P, label="06 transcript_ready_settled"),
        A.strict("harness:spawn_chat_then_send_composed", count=1, where=P, label="07 composed"),
        A.strict("chat.compose.optimistic_insert", count=A.gte(1), where=P, label="08 optimistic_insert"),
        A.strict("harness:spawn_chat_then_send_sent", count=1, where=P, label="09 sent"),
        A.group(
            "final",
            "chat:event_rendered",
            count=A.gte(1),
            where=lambda d: _is_final_assistant_render(d, stream_id),
            label="10 final_assistant_rendered",
        ),
        A.neg("chat.compose.optimistic_failed", label="NEG optimistic_failed"),
    ]


def _trace_from_stream(stream) -> list[dict]:
    return [
        {"name": ev.message, "data": dict(ev.data), "timestamp": ev.received_at}
        for ev in stream.all_events()
    ]


def _is_final_assistant_render(data: dict, stream_id: str) -> bool:
    if data.get("stream_id") != stream_id:
        return False
    if data.get("display_rule") != "bubble:assistant":
        return False
    kind = str(data.get("kind") or "")
    return kind.startswith("ASSIST")


def _is_fallback_tool_render(data: dict, stream_id: str) -> bool:
    # chat-core CHAT_EVENT_RENDERED for the session-summary fallback. The rawless
    # fallback is mislabeled display_rule='bubble:assistant', so we must NOT rely on
    # display_rule alone — the emit also carries kind=fallbackKind, which is the
    # reliable tool signal.
    if data.get("stream_id") != stream_id:
        return False
    if data.get("source") != "session_summary_fallback":
        return False
    display_rule = str(data.get("display_rule") or "")
    kind = str(data.get("kind") or "")
    return (
        display_rule in TOOL_ACTION_RULES
        or display_rule in TOOL_COMPONENT_RULES
        or kind in TOOL_KINDS
    )


def _is_fallback_tool_row(data: dict, stream_id: str) -> bool:
    # mobile harness:row_rendered for the leaked fallback. The leak mounts with a
    # `fallback:` row_id as a tool component (e.g. component:tool-invocation-card) and
    # text "Bash\n<command>". Treat any of those structural signals as a leak.
    if data.get("stream_id") != stream_id:
        return False
    if data.get("lifecycle") != "mount":
        return False
    display_rule = str(data.get("displayRule") or data.get("display_rule") or "")
    text_prefix = str(data.get("text_prefix") or "")
    event_key = str(data.get("event_key") or "")
    row_id = str(data.get("row_id") or "")
    is_fallback_row = row_id.startswith("fallback:") or event_key == "uncorrelated_fallback"
    if is_fallback_row and (
        display_rule in TOOL_ACTION_RULES or display_rule in TOOL_COMPONENT_RULES
    ):
        return True
    if display_rule in TOOL_COMPONENT_RULES and event_key == "uncorrelated_fallback":
        return True
    return any(text_prefix.startswith(marker) for marker in COMMAND_PREFIX_MARKERS)


def _is_tool_fallback_leak(event, stream_id: str) -> bool:
    data = dict(event.data)
    if event.message == "chat:event_rendered":
        return _is_fallback_tool_render(data, stream_id)
    if event.message == "harness:row_rendered":
        return _is_fallback_tool_row(data, stream_id)
    return False


def _await_matching_event(stream, predicate: Callable, timeout_s: float, not_before: float | None = None):
    deadline = time.monotonic() + timeout_s
    cutoff = not_before or 0.0
    for event in stream.all_events():
        if event.received_at >= cutoff and predicate(event):
            return event
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if event and event.received_at >= cutoff and predicate(event):
            return event
    return None


def run(config: dict, stream, cap=None):
    started = time.monotonic()
    if cap:
        cap.screenshot(f"{name}_start")

    mounted = await_event(
        stream,
        EventSpec("harness:session_screen_mount", timeout_s=30.0),
    )
    stream_id = str(mounted.data.get("stream_id") or "") if mounted else ""
    if not stream_id:
        return Verdict(
            name=name,
            verdict="FAIL",
            error="missing harness:session_screen_mount stream_id",
            extras={"duration_s": round(time.monotonic() - started, 2)},
        ).finish()

    await_event(
        stream,
        EventSpec("harness:transcript_ready_settled", where={"stream_id": stream_id}, timeout_s=30.0),
    )
    sent = await_event(
        stream,
        EventSpec("harness:spawn_chat_then_send_sent", where={"stream_id": stream_id}, timeout_s=60.0),
    )
    if not sent:
        return Verdict(
            name=name,
            verdict="FAIL",
            error="missing harness:spawn_chat_then_send_sent",
            extras={"stream_id": stream_id, "duration_s": round(time.monotonic() - started, 2)},
        ).finish()

    final_assistant = _await_matching_event(
        stream,
        lambda ev: ev.message == "chat:event_rendered"
        and _is_final_assistant_render(dict(ev.data), stream_id),
        timeout_s=FINAL_ASSISTANT_TIMEOUT_S,
        not_before=sent.received_at,
    )

    trace_events = stream.all_events()
    end_cutoff = final_assistant.received_at if final_assistant else time.monotonic()
    leaks = [
        event
        for event in trace_events
        if sent.received_at <= event.received_at <= end_cutoff
        and _is_tool_fallback_leak(event, stream_id)
    ]

    trace = _trace_from_stream(stream)
    result = A.TelemetryAssertion(_build_steps(stream_id)).check(trace)
    result.info["stream_id"] = stream_id
    result.info["duration_s"] = round(time.monotonic() - started, 2)
    result.info["fallback_tool_leak_count"] = len(leaks)

    errors: list[str] = []
    if not final_assistant:
        errors.append(f"missing final assistant bubble after {FINAL_ASSISTANT_TIMEOUT_S}s")
    if leaks:
        errors.append(
            "tool fallback leaked while tools hidden: "
            + ", ".join(f"{event.message}:{dict(event.data)}" for event in leaks[:3])
        )
    if not result.passed:
        errors.append(A.format_failure_report(result))

    verdict = Verdict(
        name=name,
        verdict="PASS" if not errors else "FAIL",
        steps=[],
        error="; ".join(errors) if errors else None,
        extras={
            "stream_id": stream_id,
            "assertion_result": result.to_dict(),
            "summary": result.summary,
            "fallback_tool_leak_count": len(leaks),
        },
    )
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
