"""Verify that a synthetic live append keeps a viewport at the bottom.

The scenario complements the scroll-up case: when the transcript is already at
the bottom, a new row should be visible without a separate user gesture. It
uses settled content-offset samples as the oracle.
"""

from __future__ import annotations

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from . import _mock_transcript_history as H
from ..harness.asserts import EventSpec, Verdict, await_event

name = "mock_autoscroll_at_bottom_follow"

# The screen treats offsets within this small band as "at the bottom".
NEAR_BOTTOM_OFFSET = 2
LIVE_SEQ = H.LATEST_SEQ + 1


def actions(_config: dict) -> list[str]:
    # No scroll action: the whole point is that the viewport is never touched.
    return ["autoaccept_biometric", "open_existing_chat", "transcript_bottom_follow_probe"]


def params(config: dict) -> dict[str, str]:
    payload = H.params(config, name, live_append=True)
    payload["live_append_seq"] = str(LIVE_SEQ)
    payload["expand_live_append"] = "1"
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def run(config: dict, stream, cap=None) -> Verdict:
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early

    # Baseline: the chat opened and settled at the bottom.
    opened = H.await_settled_anchor_sample(stream, phase="bottom_follow", timeout_s=15)
    live = await_event(
        stream,
        EventSpec(
            "chat:event_received",
            where={"stream_id": M.STREAM_ID, "seq": LIVE_SEQ, "source": "chat.event"},
            timeout_s=40,
        ),
        not_before=opened.received_at if opened else None,
    )
    expanded = await_event(
        stream,
        EventSpec(
            "harness:ui_trace",
            where={"kind": "transcript_live_row_expanded", "stream_id": M.STREAM_ID, "seq": LIVE_SEQ},
            timeout_s=10,
        ),
        not_before=live.received_at if live else None,
    )
    # Wait for the settled sample after the transcript change so an in-flight animation
    # is not mistaken for a failed follow.
    settled = H.await_settled_anchor_sample(
        stream,
        phase="bottom_follow",
        not_before=expanded.received_at if expanded else (live.received_at if live else None),
        quiet_s=1.0,
        timeout_s=15,
    )

    # Keep decision telemetry as diagnostics; the settled offset is the oracle.
    # A bounded 25-row transcript replaces its oldest row on append, so its length can remain
    # constant and legitimately produce ``no_transcript_growth`` while the newest row follows.
    autoscroll_decisions = [
        event.data
        for event in stream.all_events()
        if event.message == "chat:autoscroll_decision"
        and event.data.get("stream_id") == M.STREAM_ID
        and (live is None or event.received_at >= live.received_at)
    ]
    followed = any(decision.get("enabled") is True for decision in autoscroll_decisions)
    suppressed_reasons = [
        decision.get("reason")
        for decision in autoscroll_decisions
        if decision.get("enabled") is False
    ]

    failures: list[str] = []
    if not opened:
        failures.append("no bottom-follow anchor sample after open")
    elif opened.data.get("anchor_seq") == LIVE_SEQ:
        failures.append("live append preceded the settled session-open baseline")
    elif opened.data.get("offset") is not None and opened.data["offset"] > NEAR_BOTTOM_OFFSET:
        failures.append(
            f"chat did not open at the bottom: offset {opened.data['offset']} > {NEAR_BOTTOM_OFFSET}"
        )
    if not live:
        failures.append("live append was not received")
    if not expanded:
        failures.append("newest row did not expand after its first layout")
    if not settled:
        failures.append("live append produced no settled bottom-follow anchor sample")
    else:
        offset = settled.data.get("offset")
        anchor_seq = settled.data.get("anchor_seq")
        anchor_min_visible_percent = settled.data.get("anchor_min_visible_percent")
        if offset is None:
            failures.append("settled anchor sample carried no offset")
        elif offset > NEAR_BOTTOM_OFFSET:
            # A large settled offset means the new row was not followed.
            failures.append(
                f"viewport did not follow the live append: settled offset {offset} > {NEAR_BOTTOM_OFFSET}"
            )
        # Require positive visibility. A null anchor means no row was viewable.
        if anchor_seq != LIVE_SEQ:
            failures.append(
                f"newest row {LIVE_SEQ} is not the top viewable row after the append (anchor_seq={anchor_seq!r})"
            )
        if anchor_min_visible_percent != 100:
            failures.append(
                "settled anchor was not certified with 100% row visibility "
                f"(anchor_min_visible_percent={anchor_min_visible_percent!r})"
            )
    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "opened_anchor": opened.data if opened else None,
            "settled_anchor": settled.data if settled else None,
            "live_received": live is not None,
            "live_row_expanded": expanded is not None,
            "autoscroll_followed": followed,
            "autoscroll_suppressed_reasons": suppressed_reasons,
        },
    )
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=name)

