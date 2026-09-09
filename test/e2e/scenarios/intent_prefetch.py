from __future__ import annotations

import time

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from ..harness.asserts import EventSpec, StepResult, Verdict, assert_no_events, await_event


name = "intent_prefetch"


def actions(_config):
    return ["open_existing_chat"]


def params(config):
    out = {
        "host": str(config.get("host") or "hostc"),
        "entry_source": str(config.get("entry_source") or "search"),
    }
    stream_id = str(config.get("stream_id") or "").strip()
    if stream_id:
        out["stream_id"] = stream_id
    return out


def preflight(_config: dict, repo_root=None) -> str | None:
    return None


def _await_step(stream, spec: EventSpec, cutoff: float | None) -> StepResult:
    started = time.monotonic()
    event = await_event(stream, spec, not_before=cutoff)
    return StepResult(expected=spec, event=event, elapsed_s=time.monotonic() - started)


def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")

    steps: list[StepResult] = []
    attempted = await_event(stream, EventSpec("harness:open_existing_chat_attempted", timeout_s=20))
    steps.append(StepResult(EventSpec("harness:open_existing_chat_attempted", timeout_s=20), attempted, 0.0))
    if not attempted:
        return Verdict(name=name, verdict="SETUP_FAIL", steps=steps, error="no existing chat opened").finish()

    stream_id = str(attempted.data.get("stream_id") or "")
    if not stream_id:
        return Verdict(name=name, verdict="FAIL", steps=steps, error="open attempt missing stream_id").finish()

    cutoff = attempted.received_at
    expected = [
        EventSpec("chat.intent_prefetch.started", where={"stream_id": stream_id}, timeout_s=5),
        EventSpec("harness:session_screen_mount", where={"stream_id": stream_id}, timeout_s=5),
        EventSpec("chat.open.instant_open", where={"stream_id": stream_id}, timeout_s=5),
        EventSpec("harness:transcript_ready_settled", where={"stream_id": stream_id}, timeout_s=5),
    ]
    for spec in expected:
        step = _await_step(stream, spec, attempted.received_at)
        steps.append(step)
        if not step.passed:
            return Verdict(
                name=name,
                verdict="FAIL",
                steps=steps,
                error=f"missing event {spec.message!r} for stream {stream_id}",
                extras={"stream_id": stream_id},
            ).finish()

    coalesced_events = [
        event for event in stream.all_events()
        if event.message == "chat.intent_prefetch.coalesced"
        and str(event.data.get("stream_id") or "") == stream_id
        and event.received_at >= attempted.received_at
    ]
    spinner_events = [
        event for event in stream.all_events()
        if event.message == "chat.open.spinner_on_open"
        and str(event.data.get("stream_id") or "") == stream_id
        and event.received_at >= attempted.received_at
    ]
    if spinner_events:
        return Verdict(
            name=name,
            verdict="FAIL",
            steps=steps,
            error="spinner_on_open fired for intent-prefetched stream",
            extras={"stream_id": stream_id, "spinner_events": [event.to_dict() for event in spinner_events]},
        ).finish()

    verdict = Verdict(
        name=name,
        verdict="PASS",
        steps=steps,
        extras={
            "stream_id": stream_id,
            "entry_source": str(config.get("entry_source") or "search"),
            "coalesced_count": len(coalesced_events),
        },
    )
    verdict.fold_negative_watch(assert_no_events(stream, window_s=2))
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()

