"""Shared render-evidence helpers for synthetic question scenarios.

The functions inspect a LogStream-like object with message, timestamp, and data
fields. They reject pane noise and require a mounted assistant row after an
answer, keeping question examples deterministic and independent of a device.
"""
from __future__ import annotations

import re
import time

from ..harness.render_evidence import ASSISTANT_BUBBLE_RULES

# Pane / TUI noise: box-drawing chars, prompt carets, and bare connection
# chatter. Shared by the example question scenarios.
NOISE_RE = re.compile(
    r"[─-╿]|^\s*[>›❯]\s|^\s*(reconnect ok|connected|connecting|disconnected)\s*$",
    re.I,
)


def rendered_noise_rows(stream, stream_id: str, start: float, end: float):
    """Mounted transcript rows whose text_prefix is pane/TUI noise within
    [start, end]. Shared by the question scenarios (NOISE_RE rejection)."""
    rows = []
    for event in stream.all_events():
        if event.received_at < start or event.received_at > end:
            continue
        if event.message != "harness:row_rendered":
            continue
        if str(event.data.get("stream_id") or "") != stream_id:
            continue
        if str(event.data.get("lifecycle") or "mount") != "mount":
            continue
        text = str(event.data.get("text_prefix") or "")
        if NOISE_RE.search(text):
            rows.append(event)
    return rows


def _scan_proceeded_row(stream, stream_id: str, not_before: float):
    for event in stream.all_events():
        if event.received_at < not_before:
            continue
        if event.message != "harness:row_rendered":
            continue
        if str(event.data.get("stream_id") or "") != stream_id:
            continue
        if str(event.data.get("lifecycle") or "mount") != "mount":
            continue
        rule = str(event.data.get("display_rule") or event.data.get("displayRule") or "")
        if rule in ASSISTANT_BUBBLE_RULES:
            return event
    return None


def proceeded_reply_row(stream, stream_id: str, not_before: float, timeout_s: float = 0.0):
    """(c) Return the first `harness:row_rendered{lifecycle:mount}` assistant
    row for the stream after `not_before` — the post-answer reply
    actually rendering, replacing the any-kind `chat:event_received` proceeded
    check. Polls the stream up to `timeout_s` so the assistant row can arrive
    after an interleaved USER-echo row on a live walk; returns None if no
    rendered assistant row landed in the window. With timeout_s=0 (unit tests
    feed a pre-populated stream) it is a single scan of `all_events`."""
    deadline = time.monotonic() + timeout_s
    while True:
        found = _scan_proceeded_row(stream, stream_id, not_before)
        if found is not None:
            return found
        if time.monotonic() >= deadline:
            return None
        stream.next_event(timeout_s=min(0.5, max(0.0, deadline - time.monotonic())))
