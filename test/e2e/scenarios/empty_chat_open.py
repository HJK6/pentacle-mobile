from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _biometric_matrix_fixture as BM
from ..harness.asserts import EventSpec, Verdict, await_event
from ._run_state import save_owned_session


name = "empty_chat_open"


def actions(_config):
    out = [
        "autoaccept_biometric",
        "spawn_chat_then_send",
        "fail_next_history_fetch",
        "open_chat_while_ws_down",
    ]
    if str(_config.get("PENTACLE_E2E_TARGET") or "").lower() != "simulator":
        out.insert(1, "disable_pentacle_auth")
    return out


def params(config):
    host = str(config.get("host") or "hostc")
    provider = str(config.get("provider") or "codex")
    out = {
        "host": host,
        "provider": provider,
        "text": "Reply with one short sentence for the empty-chat-open behavior.",
    }
    if str(config.get("PENTACLE_E2E_TARGET") or "").lower() == "simulator":
        fixture = BM.write_spawn_chat_fixture(
            config,
            scenario_name=name,
            host=host,
            provider=provider,
            assistant_replies=["empty chat open scripted assistant reply"],
        )
        out["mock_fixture_path"] = str(fixture)
        out["scripted_daemon_fixture_path"] = str(fixture)
    return out


def preflight(config: dict, repo_root=None) -> str | None:
    return None


def _record_owned_session(config: dict, stream_id: str) -> str | None:
    if str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip():
        return None
    host = str(config.get("host") or "hostc")
    run_id = str(config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or "default")
    state_dir = config.get("state_dir")
    session_name = stream_id.split(":", 1)[1] if ":" in stream_id else stream_id
    try:
        save_owned_session(
            run_id=run_id,
            stream_id=stream_id,
            host=host,
            session_name=session_name,
            source=name,
            state_dir=state_dir,
        )
    except OSError as exc:  # pragma: no cover — disk failure
        return str(exc)
    return None


def _events(stream, message: str, stream_id: str, not_before: float):
    return [
        event for event in stream.all_events()
        if event.received_at >= not_before
        and event.message == message
        and str(event.data.get("stream_id") or "") == stream_id
    ]


def _pre_hydration_empty_state_events(stream, stream_id: str, not_before: float):
    return [
        event for event in _events(stream, "chat:empty_state_rendered", stream_id, not_before)
        if event.data.get("has_hydrated") is False or event.data.get("history_fetch_in_flight") is True
    ]


def _duration_display_rule(event) -> str:
    return str(event.data.get("display_rule") or event.data.get("displayRule") or "")


def _is_content_render(event) -> bool:
    seq = event.data.get("seq")
    try:
        authoritative_seq = int(seq)
    except (TypeError, ValueError):
        authoritative_seq = -1
    return (
        authoritative_seq >= 0
        and str(event.data.get("kind") or "") in {"USER", "ASSIST", "SYSTEM"}
        and _duration_display_rule(event) != "system:blank"
    )


def _find_authoritative_content_render(stream, stream_id: str, not_before: float):
    for event in stream.all_events():
        if (
            event.received_at >= not_before
            and event.message == "chat:event_rendered"
            and str(event.data.get("stream_id") or "") == stream_id
            and _is_content_render(event)
        ):
            return event
    return None


def _await_authoritative_content_render(stream, stream_id: str, not_before: float, timeout_s: float):
    deadline = not_before + timeout_s
    cursor = not_before
    while cursor < deadline:
        current = _find_authoritative_content_render(stream, stream_id, not_before)
        if current:
            return current
        event = await_event(
            stream,
            EventSpec("chat:event_rendered", where={"stream_id": stream_id}, timeout_s=max(0.1, deadline - cursor)),
            not_before=cursor,
        )
        if not event:
            return _find_authoritative_content_render(stream, stream_id, not_before)
        if _is_content_render(event):
            return event
        cursor = max(cursor + 0.001, event.received_at + 0.001)
    return None


def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")

    ws_open = await_event(stream, EventSpec("chat:ws_open", timeout_s=20))
    if not ws_open:
        return Verdict(name=name, verdict="SETUP_FAIL", error="initial websocket open signal absent").finish()

    mounted = await_event(
        stream,
        EventSpec("harness:session_screen_mount", timeout_s=20),
        not_before=ws_open.received_at,
    )
    if not mounted:
        return Verdict(name=name, verdict="SETUP_FAIL", error="fresh-stream screen mount signal absent").finish()
    stream_id = str(mounted.data.get("stream_id") or "")
    if not stream_id:
        return Verdict(name=name, verdict="FAIL", error="mount event missing stream_id").finish()
    owned_persist_error = _record_owned_session(config, stream_id)

    placeholder = await_event(
        stream,
        EventSpec("harness:transcript_ready_settled", where={"stream_id": stream_id}, timeout_s=10),
        not_before=mounted.received_at,
    )
    if not placeholder:
        return Verdict(name=name, verdict="FAIL", error="fresh pre-event stream did not reach placeholder-ready state").finish()

    pre_hydration_empty = _pre_hydration_empty_state_events(stream, stream_id, mounted.received_at)
    if pre_hydration_empty:
        return Verdict(
            name=name,
            verdict="FAIL",
            error="empty state rendered before chat detail hydration completed",
            extras={"stream_id": stream_id, "events": len(pre_hydration_empty)},
        ).finish()

    sent = await_event(
        stream,
        EventSpec("harness:spawn_chat_then_send_sent", where={"stream_id": stream_id}, timeout_s=90),
        not_before=mounted.received_at,
    )
    if not sent or str(sent.data.get("status") or "") != "ok":
        return Verdict(name=name, verdict="SETUP_FAIL", error="spawn_chat_then_send did not send").finish()

    live = _await_authoritative_content_render(stream, stream_id, placeholder.received_at, 30)
    if not live:
        return Verdict(name=name, verdict="FAIL", error="live events did not render after fresh placeholder state").finish()

    failure = await_event(
        stream,
        EventSpec("question:reopen_fetch_failed", where={"stream_id": stream_id}, timeout_s=10),
        not_before=mounted.received_at,
    )
    if not failure or "harness forced request_stream_events failure" not in str(failure.data.get("error") or ""):
        return Verdict(name=name, verdict="FAIL", error="forced failed history fetch was not observed").finish()

    rendered = await_event(
        stream,
        EventSpec("chat:history_backfill_rendered", where={"stream_id": stream_id}, timeout_s=10),
        not_before=failure.received_at,
    )
    if not rendered:
        return Verdict(name=name, verdict="FAIL", error="forced failed history fetch did not retry into rendered backfill").finish()

    closed = await_event(
        stream,
        EventSpec("chat:ws_close", where={"reason": "harness_forced"}, timeout_s=40),
        not_before=rendered.received_at,
    )
    if not closed:
        return Verdict(name=name, verdict="SETUP_FAIL", error="open_chat_while_ws_down did not force websocket close").finish()

    mounted_down = await_event(
        stream,
        EventSpec("harness:session_screen_mount", where={"stream_id": stream_id}, timeout_s=10),
        not_before=closed.received_at,
    )
    if not mounted_down:
        return Verdict(name=name, verdict="SETUP_FAIL", error="session screen did not mount while websocket was down").finish()

    down_opened = await_event(
        stream,
        EventSpec("harness:open_chat_while_ws_down_done", where={"stream_id": stream_id}, timeout_s=10),
        not_before=closed.received_at,
    )
    if not down_opened:
        return Verdict(name=name, verdict="SETUP_FAIL", error="open_chat_while_ws_down did not report opened stream").finish()

    reopened = await_event(stream, EventSpec("chat:ws_open", timeout_s=40), not_before=mounted_down.received_at)
    if not reopened:
        return Verdict(name=name, verdict="FAIL", error="websocket did not reopen after mounted-while-down state").finish()

    refetch = await_event(
        stream,
        EventSpec("question:reopen_fetch_ready", where={"stream_id": stream_id}, timeout_s=10),
        not_before=reopened.received_at,
    )
    if not refetch:
        return Verdict(name=name, verdict="FAIL", error="mounted screen did not refetch after reconnect").finish()

    backfilled_after_reconnect = await_event(
        stream,
        EventSpec("chat:history_backfill_rendered", where={"stream_id": stream_id}, timeout_s=10),
        not_before=refetch.received_at,
    )
    if not backfilled_after_reconnect:
        return Verdict(name=name, verdict="FAIL", error="reconnect refetch did not render history backfill").finish()

    failures = _events(stream, "question:reopen_fetch_failed", stream_id, mounted.received_at)
    attempts = _events(stream, "question:reopen_fetch_attempt", stream_id, mounted.received_at)
    successes = _events(stream, "question:reopen_fetch_ready", stream_id, mounted.received_at)
    if failures and len(attempts) <= len(failures):
        return Verdict(
            name=name,
            verdict="FAIL",
            error="failed history fetch was not retried",
            extras={"stream_id": stream_id, "attempts": len(attempts), "failures": len(failures)},
        ).finish()

    verdict = Verdict(
        name=name,
        verdict="PASS",
        extras={
            "stream_id": stream_id,
            "attempts": len(attempts),
            "successes": len(successes),
            "failures": len(failures),
            "arms": {
                "fresh_placeholder_then_live": True,
                "ws_down_then_reconnect_backfill": True,
                "forced_failed_fetch_retried": True,
            },
        },
    )
    if owned_persist_error:
        verdict.extras["owned_persist_error"] = owned_persist_error
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()
