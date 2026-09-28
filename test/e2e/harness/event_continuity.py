"""Event-continuity oracle for live-daemon two-turn scenarios.

spec_pentacle_mobile__e2e_event_continuity_assertion_2026_09.

`send_two_turns_claude` asserts UI markers (dock label, optimistic
insert/reconcile) but never that every `chat.event` the daemon emitted for
the stream actually reached — and rendered on — the client. A churn run can
lose an event and only fail via the UI. This module adds the missing proof.

Data model (verified against real run traces + `chat-stream-v2` source):

- `daemon_seq` is the daemon store's per-daemon `AUTOINCREMENT` `event_id`
  (`store.py session_event_tail`), stamped onto every broadcast `chat.event`
  (`ingest.py`). It is GLOBAL across streams, so one stream's received seqs
  are strictly increasing but NON-contiguous. Global/filtered gaps from other
  streams are legitimate and are never asserted as continuity failures.
- Client evidence, all already emitted (no new telemetry):
    * `chat:event_received {source:"chat.event", seq, stream_id, kind}` —
      live receipt (reconnect replay legitimately duplicates these RAW).
    * `harness:row_rendered` / `chat:transcript_row_rendered {row_id, ...}`
      where `row_id == str(daemon_seq)` for a committed event — the RENDERED
      set (USER rows render under their optimistic id, not the seq).

Oracle independence (Astra, operator-authorized 2026-09-06):
  The canonical EXPECTED set is the daemon's own per-stream record, fetched at
  the freeze deadline through an INDEPENDENT read-only observer connection —
  never the app's live WS (a fetch on the app socket could backfill the very
  gap this is meant to catch). The client applied/rendered evidence is FROZEN
  (snapshotted from the trace) BEFORE the expected history is queried. A fetch
  that cannot prove completeness for the bounded stream/range is INCONCLUSIVE
  and fails — never a smaller passing expected set.

The comparator here is PURE and fully unit-tested; the live observer fetch is a
thin runtime adapter (exercised by the next live churn re-run, not by pytest).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Iterable

CHAT_EVENT_RECEIVED = "chat:event_received"
ROW_RENDER_EVENTS = ("harness:row_rendered", "chat:transcript_row_rendered")
TRANSCRIPT_ORDER_DUMP = "harness:transcript_order_dump"

USER_KIND = "USER"
# Assistant textual reply kinds that constitute the visible "row for turn N".
CONTENT_KINDS = ("ASSIST_TEXT",)

# Proposed UX target for final-event render completion (app receipt -> rendered
# row). LABELLED proposed, not a baseline gate: reported, never a strict fail.
DEFAULT_RENDER_TARGET_MS = 2000.0
RENDER_TARGET_KIND = "proposed_ux_target"
RENDER_MS_START_POINT = "app_receipt"  # daemon-emit wall is not client-observable


# --------------------------------------------------------------------------
# Client-side evidence extraction (from a FROZEN trace: list of
# {"name", "data", "timestamp"} — the shape scenarios build via
# `_trace_from_stream`).
# --------------------------------------------------------------------------
def _is_chat_event(ev: dict) -> bool:
    d = ev.get("data") or {}
    return ev.get("name") == CHAT_EVENT_RECEIVED and d.get("source") == "chat.event"


def received_chat_events(trace: list[dict], stream_id) -> list[dict]:
    """Raw (with duplicates) chat.event receipts for the stream, in order."""
    out: list[dict] = []
    for ev in trace:
        if not _is_chat_event(ev):
            continue
        d = ev["data"]
        if str(d.get("stream_id") or "") != str(stream_id):
            continue
        out.append({"seq": d.get("seq"), "kind": d.get("kind"), "ts": ev.get("timestamp")})
    return out


def foreign_chat_event_count(trace: list[dict], stream_id) -> int:
    """chat.events received for a stream OUTSIDE the narrowed subscription."""
    n = 0
    for ev in trace:
        if not _is_chat_event(ev):
            continue
        if str(ev["data"].get("stream_id") or "") != str(stream_id):
            n += 1
    return n


def applied_seq_first_ts(trace: list[dict], stream_id) -> dict[int, float]:
    """Deduplicated applied set: daemon_seq -> earliest receipt timestamp."""
    out: dict[int, float] = {}
    for r in received_chat_events(trace, stream_id):
        seq, ts = r["seq"], r["ts"]
        if not isinstance(seq, int) or isinstance(seq, bool):
            continue
        if seq not in out or (ts is not None and ts < out[seq]):
            out[seq] = ts
    return out


def _is_row_mount(ev: dict) -> bool:
    if ev.get("name") == "chat:transcript_row_rendered":
        return True
    return str((ev.get("data") or {}).get("lifecycle") or "mount") == "mount"


def rendered_row_ts(trace: list[dict], stream_id) -> dict[int, list[float]]:
    """daemon_seq -> sorted render timestamps of distinct committed rows.

    Keys on row_id == str(daemon_seq): the rendered set. Multiple distinct
    rendered rows for one seq => a duplicate RENDERED (raw replay dups on the
    wire are NOT counted here; those live in `received_chat_events`).
    """
    out: dict[int, list[float]] = {}
    for ev in trace:
        if ev.get("name") not in ROW_RENDER_EVENTS:
            continue
        d = ev.get("data") or {}
        if str(d.get("stream_id") or "") != str(stream_id):
            continue
        if not _is_row_mount(ev):
            continue
        rid = str(d.get("row_id") or "")
        if not rid.isdecimal():
            continue
        out.setdefault(int(rid), []).append(ev.get("timestamp"))
    for seq in out:
        out[seq] = sorted(t for t in out[seq] if t is not None)
    return out


def logical_render_projection(
    trace: list[dict],
    stream_id,
    scenario_run_id: str,
    final_seq: int | None,
    final_received_ts: float | None,
) -> tuple[bool, list[int], list[int], float | None]:
    """Return the latest same-run projection that proves the final event is present."""
    candidates: list[tuple[float, list[int]]] = []
    if final_seq is None or final_received_ts is None or not scenario_run_id:
        return False, [], [], None
    for ev in trace:
        if ev.get("name") != TRANSCRIPT_ORDER_DUMP:
            continue
        data = ev.get("data") or {}
        if str(data.get("stream_id") or "") != str(stream_id):
            continue
        if str(data.get("scenario_run_id") or "") != scenario_run_id:
            continue
        timestamp = ev.get("timestamp")
        order = data.get("transcript_seq_order")
        if not isinstance(timestamp, (int, float)) or timestamp < final_received_ts:
            continue
        if not isinstance(order, list) or not all(isinstance(seq, int) and not isinstance(seq, bool) for seq in order):
            continue
        if final_seq not in order:
            continue
        candidates.append((float(timestamp), list(order)))
    if not candidates:
        return False, [], [], None
    timestamp, order = max(candidates, key=lambda item: item[0])
    counts: dict[int, int] = {}
    for seq in order:
        counts[seq] = counts.get(seq, 0) + 1
    duplicates = sorted(seq for seq, count in counts.items() if count > 1)
    return True, order, duplicates, timestamp


# --------------------------------------------------------------------------
# The pure comparator.
# --------------------------------------------------------------------------
def _expected_seqs(expected: Iterable[dict]) -> list[int]:
    seqs = [int(e["daemon_seq"]) for e in expected if e.get("daemon_seq") is not None]
    return seqs


def assert_event_continuity(
    trace: list[dict],
    subscription_stream_id,
    expected: list[dict],
    *,
    scenario_run_id: str,
    expected_complete: bool = True,
    render_target_ms: float = DEFAULT_RENDER_TARGET_MS,
    journey_min_user_turns: int = 2,
    content_kinds: tuple[str, ...] = CONTENT_KINDS,
) -> tuple[bool, str | None, dict]:
    """Compare the daemon's canonical per-stream record (`expected`) against the
    client's FROZEN deduplicated/applied/rendered evidence in `trace`.

    `expected` is the daemon record ordered ascending: [{"daemon_seq", "kind"}].
    `expected_complete` is the observer's completeness proof for the bounded
    range; False => INCONCLUSIVE (fails; never a smaller passing set).

    Returns (ok, error, info). Strict (hard) failures: incomplete expected set,
    any missing content, first/final not received, final not RENDERED, a later
    same-stream event than the record's final, a duplicate RENDERED seq, a
    missing journey turn, or hidden-session leakage. The final-event render
    LATENCY is a labelled proposed UX target — reported, never a hard fail.
    """
    exp = list(expected)
    exp_seqs = _expected_seqs(exp)
    exp_kind = {int(e["daemon_seq"]): str(e.get("kind") or "") for e in exp if e.get("daemon_seq") is not None}

    applied = applied_seq_first_ts(trace, subscription_stream_id)
    rendered = rendered_row_ts(trace, subscription_stream_id)
    foreign = foreign_chat_event_count(trace, subscription_stream_id)

    missing = [s for s in exp_seqs if s not in applied]
    received_count = sum(1 for s in exp_seqs if s in applied)
    first_seq = exp_seqs[0] if exp_seqs else None
    final_seq = exp_seqs[-1] if exp_seqs else None
    first_received = first_seq is not None and first_seq in applied
    final_received = final_seq is not None and final_seq in applied
    later_than_final = sorted(s for s in applied if final_seq is not None and s > final_seq)

    # Final RENDERED content event = the last renderable (assistant) turn event.
    content_seqs = [s for s in exp_seqs if exp_kind.get(s) in content_kinds]
    final_content_seq = max(content_seqs) if content_seqs else final_seq
    final_content_rendered = bool(final_content_seq is not None and rendered.get(final_content_seq))

    # Terminal control events need receipt, not a visible row. Still require a
    # same-run content projection observed after the final event was received.
    projection_complete, projection_order, projection_duplicates, projection_ts = logical_render_projection(
        trace,
        subscription_stream_id,
        scenario_run_id,
        final_content_seq,
        applied.get(final_seq) if final_seq is not None else None,
    )
    duplicate_rendered = projection_duplicates

    # Journey non-vacuity: the driven USER turns (+ >=1 assistant reply) present.
    exp_user = [s for s in exp_seqs if exp_kind.get(s) == USER_KIND]
    user_seen = [s for s in exp_user if s in applied]
    content_seen = [s for s in content_seqs if s in applied]
    journey_turns_present = (
        len(exp_user) >= journey_min_user_turns
        and len(user_seen) >= journey_min_user_turns
        and len(content_seen) >= 1
    )

    # Final-event render latency (app receipt -> rendered row). Reported metric.
    final_render_ms: float | None = None
    if final_content_rendered and final_content_seq in applied:
        recv_ts = applied[final_content_seq]
        rend_ts = rendered[final_content_seq][0]
        if recv_ts is not None and rend_ts is not None:
            final_render_ms = round(max(0.0, (rend_ts - recv_ts) * 1000.0), 1)
    within_target = None if final_render_ms is None else (final_render_ms <= render_target_ms)

    checks: list[str] = []
    if not expected_complete:
        checks.append("INCONCLUSIVE: expected history could not be proven complete for the bounded range")
    if not exp_seqs:
        checks.append("empty expected set (no daemon record fetched for the stream)")
    if not projection_complete:
        checks.append("logical render projection missing, stale, mismatched, or missing the final event")
    if missing:
        checks.append(f"missing {len(missing)} expected event(s) from applied set: {missing}")
    if exp_seqs and not first_received:
        checks.append(f"first event {first_seq} not in applied set")
    if final_seq is not None and not final_received:
        checks.append(f"final event {final_seq} not received")
    if later_than_final:
        checks.append(f"applied set has event(s) later than the record's final {final_seq}: {later_than_final}")
    if final_content_seq is not None and not final_content_rendered:
        checks.append(f"final event {final_content_seq} applied but NOT rendered")
    if duplicate_rendered:
        checks.append(f"duplicate RENDERED seq(s): {duplicate_rendered}")
    if not journey_turns_present:
        checks.append(
            f"journey turns absent/vacuous (expected>= {journey_min_user_turns} USER turns; "
            f"expected_user={len(exp_user)} user_seen={len(user_seen)} content_seen={len(content_seen)})"
        )
    if foreign:
        checks.append(f"hidden-session leakage: {foreign} chat.event(s) for streams outside the subscription")

    ok = not checks
    info = {
        "subscription_stream_id": str(subscription_stream_id),
        "expected_complete": expected_complete,
        "expected_count": len(exp_seqs),
        "received_count": received_count,
        "missing": missing,
        "first_event_seq": first_seq,
        "first_event_received": first_received,
        "final_event_seq": final_seq,
        "final_event_received": final_received,
        "later_than_final": later_than_final,
        "final_content_seq": final_content_seq,
        "final_event_rendered": final_content_rendered,
        "duplicate_rendered": duplicate_rendered,
        "render_projection_complete": projection_complete,
        "render_projection_seq_order": projection_order,
        "render_projection_timestamp": projection_ts,
        "journey_turns_present": journey_turns_present,
        "journey_user_turns_seen": len(user_seen),
        "foreign_stream_events": foreign,
        "final_event_render_ms": final_render_ms,
        "final_event_render_target_ms": render_target_ms,
        "final_event_render_target_kind": RENDER_TARGET_KIND,
        "final_event_render_within_target": within_target,
        "render_ms_start_point": RENDER_MS_START_POINT,
        "continuity_ok": ok,
    }
    error = None if ok else "; ".join(checks)
    return ok, error, info


# --------------------------------------------------------------------------
# Independent read-only observer fetch (runtime adapter — NOT unit-tested;
# never routed through the app's WS). Reuses the v2 wire `request_stream_events`
# full-range paging contract (server.py). Returns (expected, complete, source).
# --------------------------------------------------------------------------
async def _observer_fetch(
    ws_url: str,
    token: str | None,
    host: str,
    name: str,
    *,
    limit: int = 5000,
    open_timeout: float = 10.0,
    idle_timeout: float = 8.0,
    include_payload: bool = False,
) -> tuple[list[dict], bool]:
    import websockets  # local import: only needed on the live path

    stream_id = f"{host}:{name}"
    collected: dict[int, dict] = {}
    complete = False
    async with websockets.connect(ws_url, open_timeout=open_timeout, max_size=None) as ws:
        welcome = json.loads(await asyncio.wait_for(ws.recv(), timeout=open_timeout))
        if welcome.get("type") != "welcome":
            raise RuntimeError(f"unexpected daemon welcome: {welcome!r}")
        # Independent, read-only, narrowed to this stream. snapshot:False so the
        # observer never solicits a live push that could race the app.
        await ws.send(json.dumps({
            "type": "hello",
            "client": "harness-continuity-observer",
            "token": token or None,
            "subscribe": {"mode": "rpc", "snapshot": False},
        }))
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=open_timeout))
        if ready.get("type") != "ready":
            raise RuntimeError(f"unexpected daemon ready frame: {ready!r}")

        cursor: int | None = None
        # Page backward (before_daemon_seq) until an empty page proves we reached
        # the stream's first event => completeness for the bounded range.
        while True:
            req_id = f"continuity-{host}-{name}-{cursor}"
            await ws.send(json.dumps({
                "type": "request_stream_events",
                "request_id": req_id,
                "stream_id": stream_id,
                "host": host,
                "name": name,
                "limit": limit,
                "before_daemon_seq": cursor,
            }))
            page: list[dict] = []
            page_complete = False
            while True:
                try:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=idle_timeout))
                except asyncio.TimeoutError:
                    break
                ftype = frame.get("type")
                if ftype in (
                    "request_stream_events.error",
                    "request_stream_events.ok",
                    "request_stream_events.chunk",
                ) and frame.get("request_id") != req_id:
                    continue
                if ftype == "request_stream_events.error":
                    raise RuntimeError(f"request_stream_events.error: {frame.get('error')!r}")
                if ftype not in ("request_stream_events.ok", "request_stream_events.chunk"):
                    continue
                if str(frame.get("stream_id") or "") != stream_id:
                    continue
                for e in frame.get("events") or []:
                    ds = e.get("daemon_seq")
                    if isinstance(ds, int) and not isinstance(ds, bool):
                        collected[ds] = dict(e) if include_payload else {"daemon_seq": ds, "kind": e.get("kind")}
                        page.append(e)
                if ftype == "request_stream_events.ok" or frame.get("complete"):
                    page_complete = True
                    break
            if not page:
                # The server may clamp `limit`; only a matched empty terminal
                # page proves pagination reached the beginning of the stream.
                complete = page_complete
                break
            if not page_complete:
                break
            new_cursor = min(int(e["daemon_seq"]) for e in page if isinstance(e.get("daemon_seq"), int))
            if cursor is not None and new_cursor >= cursor:
                break  # cursor failed to advance; stop (not proven complete)
            cursor = new_cursor
    expected = [collected[s] for s in sorted(collected)]
    return expected, complete


def fetch_expected_history(
    ws_url: str,
    token: str | None,
    host: str,
    name: str,
    **kwargs: Any,
) -> tuple[list[dict], bool, str]:
    """Blocking wrapper around the independent observer fetch.

    Returns (expected, complete, source). `complete=False` => INCONCLUSIVE:
    the comparator will fail rather than pass on a truncated set.
    """
    expected, complete = asyncio.run(_observer_fetch(ws_url, token, host, name, **kwargs))
    return expected, complete, "observer_ws:request_stream_events"
