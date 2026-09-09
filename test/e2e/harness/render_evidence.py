"""Shared render-evidence assertions for a mobile end-to-end harness.

The helpers distinguish transport events from content that was actually mounted.
They accept only row-level render evidence for assistant replies and provide
small, deterministic predicates for transcript landing checks.
"""
from __future__ import annotations

# Assistant reply bubble display rules. The bare "assistant" form is retained
# alongside the explicit bubble rule for compatibility with older adapters.
ASSISTANT_BUBBLE_RULES = frozenset({"bubble:assistant", "assistant"})
# Codex may also use a coalesced terminal-divider row as reply evidence.
CODEX_DIVIDER_RULES = frozenset({"terminal:divider"})

# Row-render oracles. harness:row_rendered carries an explicit `lifecycle`; the
# chat:transcript_row_rendered twin fires only on a real mount.
ROW_RENDER_EVENTS = frozenset({"harness:row_rendered", "chat:transcript_row_rendered"})

# Landing corroboration set (landing): a real mounted row, or a backfilled-
# history render. transcript_ready_settled's branch:harness_timeout fallback
# fires off a 250ms setTimeout even when nothing rendered, so it is NOT here.
LANDING_CORROBORATION_EVENTS = frozenset(
    {
        "harness:row_rendered",
        "chat:transcript_row_rendered",
        "chat:history_backfill_rendered",
    }
)

# Default send anchor: the synchronous send-press optimistic insert.
SEND_ANCHOR_EVENT = "chat.compose.optimistic_insert"


def reply_rules_for(provider) -> frozenset[str]:
    """Assistant-reply displayRule set for `provider` (codex also accepts the
    coalesced terminal-divider row)."""
    rules = set(ASSISTANT_BUBBLE_RULES)
    if str(provider or "").strip().lower() == "codex":
        rules |= CODEX_DIVIDER_RULES
    return frozenset(rules)


def _display_rule(data: dict) -> str:
    return str(data.get("display_rule") or data.get("displayRule") or "")


def _is_row_mount(name: str, data: dict) -> bool:
    if name == "chat:transcript_row_rendered":
        return True
    if name == "harness:row_rendered":
        return str(data.get("lifecycle") or "mount") == "mount"
    return False


def _stream_match(data: dict, stream_id) -> bool:
    return str(data.get("stream_id") or "") == str(stream_id)


def assistant_reply_rows(
    trace: list[dict],
    stream_id,
    *,
    not_before: float = 0.0,
    provider=None,
) -> list[dict]:
    """Mounted assistant-reply row-render events for the stream after
    `not_before`. provider='codex' also accepts the coalesced divider row."""
    if not stream_id:
        return []
    rules = reply_rules_for(provider)
    rows: list[dict] = []
    for ev in trace:
        if ev["name"] not in ROW_RENDER_EVENTS:
            continue
        if not _stream_match(ev["data"], stream_id):
            continue
        if ev["timestamp"] < not_before:
            continue
        if not _is_row_mount(ev["name"], ev["data"]):
            continue
        if _display_rule(ev["data"]) in rules:
            rows.append(ev)
    return rows


def _send_anchor_ts(trace: list[dict], stream_id) -> float | None:
    for ev in trace:
        if ev["name"] == SEND_ANCHOR_EVENT and _stream_match(ev["data"], stream_id):
            return ev["timestamp"]
    return None


def assert_assistant_reply_rendered(
    trace: list[dict],
    stream_id,
    *,
    provider=None,
    send_at: float | None = None,
) -> tuple[bool, str | None, dict]:
    """Reply-render: assert a rendered agent reply landed for the stream.

    A `harness:row_rendered{lifecycle:mount}` (or `chat:transcript_row_rendered`)
    with an assistant-bubble `displayRule` must appear AFTER the send. The send
    anchor defaults to the stream's first `chat.compose.optimistic_insert` (the
    synchronous send press); pass `send_at` to override. Event-counter evidence
    (`chat:event_received` / `chat:event_rendered`) does NOT satisfy this.

    Returns (ok, error, info).
    """
    rules = reply_rules_for(provider)
    info: dict = {
        "provider": provider,
        "assistant_reply_rules": sorted(rules),
        "send_anchor_event": SEND_ANCHOR_EVENT,
    }
    if not stream_id:
        return False, "no stream_id to assert a rendered reply for", info
    anchor = send_at if send_at is not None else _send_anchor_ts(trace, stream_id)
    info["send_at"] = anchor
    rows = assistant_reply_rows(trace, stream_id, not_before=anchor or 0.0, provider=provider)
    info["assistant_reply_rows"] = len(rows)
    if rows:
        info["first_reply_row"] = dict(rows[0]["data"])
        return True, None, info
    error = (
        "no rendered agent reply: zero harness:row_rendered{lifecycle:mount}/"
        "chat:transcript_row_rendered with an assistant-bubble displayRule "
        f"({sorted(rules)}) for the stream after the send"
    )
    return False, error, info


def landing_corroboration_rows(
    trace: list[dict],
    stream_id,
    *,
    not_before: float = 0.0,
) -> list[dict]:
    """Render events that corroborate a transcript landing for the stream."""
    if not stream_id:
        return []
    out: list[dict] = []
    for ev in trace:
        if ev["name"] not in LANDING_CORROBORATION_EVENTS:
            continue
        if not _stream_match(ev["data"], stream_id):
            continue
        if ev["timestamp"] < not_before:
            continue
        # harness:row_rendered counts only as a real mounted row.
        if ev["name"] == "harness:row_rendered" and str(ev["data"].get("lifecycle") or "mount") != "mount":
            continue
        out.append(ev)
    return out


def assert_transcript_landing_corroborated(
    trace: list[dict],
    stream_id,
    *,
    not_before: float = 0.0,
) -> tuple[bool, str | None, dict]:
    """Landing: `harness:transcript_ready_settled` is NOT sufficient landing
    evidence on its own — its branch:harness_timeout fallback fires off a 250ms
    setTimeout even when nothing rendered. Require >=1 corroborating
    harness:row_rendered / chat:transcript_row_rendered / chat:history_backfill_rendered
    for the stream.

    Returns (ok, error, info).
    """
    rows = landing_corroboration_rows(trace, stream_id, not_before=not_before)
    info: dict = {
        "landing_corroboration_events": sorted(LANDING_CORROBORATION_EVENTS),
        "corroborating_rows": len(rows),
    }
    if rows:
        info["first_corroboration"] = dict(rows[0]["data"])
        return True, None, info
    error = (
        "transcript landing uncorroborated: harness:transcript_ready_settled with zero "
        "harness:row_rendered/chat:transcript_row_rendered/chat:history_backfill_rendered "
        "(branch:harness_timeout is non-evidence)"
    )
    return False, error, info
