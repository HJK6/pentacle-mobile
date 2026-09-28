"""mock_v2_daemon.py — self-contained standalone v2-wire mock chat_streamd for the
pentacle-mobile e2e scripted-daemon transport.

The v1 scripted daemon (the real 30.9k-line `services/chat-stream/chat_streamd.py`,
monkeypatched by `mock_chat_streamd_entry.py`) was deleted with the v1 tree
(`154784e8 retire chat-stream v1`), taking ~17 sibling modules with it. This
process replaces it: a small async websocket server that speaks the v2 client
contract the app already talks to in production (welcome / operator-auth-v2 /
ready / snapshot / request_stream_events / session.inventory / chat.event) plus
the harness `debug_replay_*` injection seam the scripted injector drives. It has
NO pentacle-repo dependency — the operator-auth HMAC scheme is vendored in
`_mock_operator_auth.py`.

Contract sources: v2 `services/chat-stream-v2/server.py` (app-facing frames) and
v1 `chat_streamd.py` debug-replay handlers (harness frames). Owned by
spec_pentacle_mobile__scripted_v2_mock_daemon_harness_2026_09.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from websockets.asyncio.server import serve

# The launch script's TCP port-readiness probe (and the runner's endpoint-liveness
# checks) open a raw socket without a WebSocket handshake; websockets logs that as
# an ERROR ("did not receive a valid HTTP request"). It is benign — silence it so
# the retained daemon log stays clean.
logging.getLogger("websockets.server").setLevel(logging.CRITICAL)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _mock_operator_auth as operator_auth  # noqa: E402

# Frame-size budget for a single request_stream_events response (mirrors v2
# STREAM_EVENTS_FRAME_BUDGET_BYTES). The app pages via `limit`/`before_daemon_seq`,
# so a single page is small; chunk only if a page still overflows.
STREAM_EVENTS_FRAME_BUDGET_BYTES = 900 * 1024
RECENT_LIMIT_DEFAULT = 500
SEED_HISTORY_PRODUCER = "pentacle.mobile.seed_history.v1"
MOCK_REMOVE_PRODUCER = "pentacle.mobile.mock_remove_session.v1"


def _now() -> float:
    return time.time()


def _event_seq(event: dict[str, Any]) -> int:
    try:
        return int(event.get("daemon_seq") or 0)
    except (TypeError, ValueError):
        return 0


class MockDaemon:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.local_host = args.host
        self.recent_limit = int(args.recent_limit)
        self.registry: operator_auth.OperatorCredentialRegistry | None = None
        if args.credential_registry:
            self.registry = operator_auth.OperatorCredentialRegistry(Path(args.credential_registry))
        # Per-socket state.
        self.clients: dict[Any, dict[str, Any]] = {}
        self.challenges: dict[Any, tuple[str, float]] = {}
        self.observer_clients: set[Any] = set()
        # Stream state.
        self.recent_by_stream: dict[str, list[dict[str, Any]]] = {}
        self.session_summaries: dict[str, dict[str, Any]] = {}
        self.stream_events_config: dict[str, dict[str, Any]] = {}
        self.thread_history: dict[str, dict[str, Any]] = {}
        self.send_echo: dict[str, Any] | None = None

    # ---- lifecycle ---------------------------------------------------------
    async def handler(self, websocket: Any) -> None:
        nonce, expires_at = operator_auth.new_nonce()
        self.challenges[websocket] = (nonce, expires_at)
        self.clients[websocket] = {"client_kind": None, "authorized": not self._has_auth_gate(), "subscribe": {}}
        await self._send(websocket, {
            "type": "welcome",
            "runtime_sha": "",
            "auth_required": False,
            "auth": {"operator": {
                "protocol_version": operator_auth.AUTH_PROTOCOL_VERSION,
                "scheme": operator_auth.AUTH_SCHEME,
                "nonce": nonce,
                "expires_at": expires_at,
            }},
        })
        try:
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    await self._send(websocket, {"type": "protocol.error", "error_code": "bad_json"})
                    continue
                if not isinstance(msg, dict):
                    await self._send(websocket, {"type": "protocol.error", "error_code": "bad_envelope"})
                    continue
                await self._dispatch(websocket, msg)
        except Exception:  # noqa: BLE001 — a dropped socket must not crash the daemon
            pass
        finally:
            self.clients.pop(websocket, None)
            self.challenges.pop(websocket, None)
            self.observer_clients.discard(websocket)

    def _has_auth_gate(self) -> bool:
        # No legacy hello-token gate: the harness client is authorized on connect
        # (v1 parity when no auth_token is set). App clients still send auth_v2,
        # which is verified in `hello` when present.
        return False

    async def _dispatch(self, ws: Any, msg: dict[str, Any]) -> None:
        mtype = str(msg.get("type") or "")
        handler = {
            "hello": self._on_hello,
            "ping": self._on_ping,
            "daemon.stats": self._on_daemon_stats,
            "request_stream_events": self._on_request_stream_events,
            "thread.read": self._on_thread_read,
            "prompt.answer": self._on_prompt_answer,
            "debug_replay_snapshot_config": self._on_snapshot_config,
            "debug_replay_stream_events_config": self._on_stream_events_config,
            "debug_replay_send_echo_config": self._on_send_echo_config,
            "debug_replay_event": self._on_debug_event,
            "debug_replay_notification": self._on_debug_notification,
            "debug_replay_close": self._on_debug_close,
            "notification.await": self._on_notification_await,
        }.get(mtype)
        if handler is None:
            return
        await handler(ws, msg)

    # ---- handshake ---------------------------------------------------------
    async def _on_hello(self, ws: Any, msg: dict[str, Any]) -> None:
        client_kind = str(msg.get("client") or "")
        state = self.clients.setdefault(ws, {})
        state["client_kind"] = client_kind
        auth_v2 = msg.get("auth_v2")
        if isinstance(auth_v2, dict) and self.registry is not None:
            try:
                self._verify_operator(ws, client_kind, auth_v2)
            except operator_auth.OperatorAuthError:
                await self._send(ws, {"type": "hello.error", "error_code": "operator_auth_invalid"})
                return
        state["authorized"] = True
        subscribe = msg.get("subscribe") if isinstance(msg.get("subscribe"), dict) else {}
        state["subscribe"] = subscribe
        events_mode = str(subscribe.get("events_mode") or "full")
        mode = str(subscribe.get("mode") or "").lower()
        exclude = subscribe.get("exclude_event_types") if isinstance(subscribe.get("exclude_event_types"), list) else []
        snapshot_requested = subscribe.get("snapshot") is not False and mode != "rpc"
        if not snapshot_requested:
            await self._send(ws, {"type": "ready", "snapshot": False, "events_mode": events_mode})
            if mode != "rpc" and "hosts.stats" not in exclude:
                await self._send(ws, self._hosts_stats_frame())
            return
        await self._send(ws, {"type": "hello"})
        await self._send(ws, self._snapshot_frame(events_mode, exclude))
        if "hosts.stats" not in exclude:
            await self._send(ws, self._hosts_stats_frame())

    def _verify_operator(self, ws: Any, client_kind: str, auth_v2: dict[str, Any]) -> None:
        if set(auth_v2) != {"scheme", "credential_id", "proof"}:
            raise operator_auth.OperatorAuthError("invalid operator auth frame")
        if auth_v2.get("scheme") != operator_auth.AUTH_SCHEME:
            raise operator_auth.OperatorAuthError("unsupported operator auth scheme")
        challenge = self.challenges.get(ws)
        if challenge is None or challenge[1] < _now():
            raise operator_auth.OperatorAuthError("operator auth challenge unavailable")
        proof = operator_auth.decode_b64url(auth_v2.get("proof"), expected_bytes=operator_auth.AUTH_PROOF_BYTES)
        trust = self.registry.verify(
            auth_v2.get("credential_id"), client_kind, challenge[0], operator_auth.encode_b64url(proof),
        )
        self.clients[ws]["trust"] = trust

    async def _on_ping(self, ws: Any, msg: dict[str, Any]) -> None:
        await self._send(ws, {"type": "pong"})

    async def _on_daemon_stats(self, ws: Any, msg: dict[str, Any]) -> None:
        counts: dict[str, int] = {}
        for state in self.clients.values():
            kind = state.get("client_kind")
            if kind:
                counts[kind] = counts.get(kind, 0) + 1
        await self._send(ws, {"type": "daemon.stats.ok", "request_id": msg.get("request_id"), "stats": {"clients": counts}})

    # ---- app-facing snapshot / stats --------------------------------------
    def _snapshot_frame(self, events_mode: str, exclude: list[str]) -> dict[str, Any]:
        snapshot: dict[str, Any] = {
            "type": "snapshot",
            "events_mode": events_mode,
            "sessions": self._sorted_summaries(),
            "notifications": [],
            "updates": [],
            "hosts": {self.local_host: {"host": self.local_host, "online": True, "host_status": "online"}},
            "working_states": {},
        }
        if "limits.update" not in exclude:
            snapshot["limits"] = [
                {"id": "claude", "label": "Claude", "pct": None, "resets_at_iso": None, "resets_text": None, "upstream_reported_at": None, "probed_at": None},
                {"id": "fable", "label": "Fable", "pct": None, "resets_at_iso": None, "resets_text": None, "upstream_reported_at": None, "probed_at": None},
                {"id": "codex", "label": "Codex", "pct": None, "resets_at_iso": None, "resets_text": None, "upstream_reported_at": None, "probed_at": None},
            ]
            snapshot["limits_health"] = None
        return snapshot

    def _hosts_stats_frame(self) -> dict[str, Any]:
        return {"type": "hosts.stats", "hosts": {self.local_host: {"host": self.local_host, "online": True, "host_status": "online"}}}

    def _sorted_summaries(self) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.session_summaries.values()]
        rows.sort(key=lambda r: (str(r.get("last_event_at") or ""), str(r.get("stream_id") or "")), reverse=True)
        return rows

    async def _emit_session_inventory(self) -> None:
        await self._broadcast_app({"type": "session.inventory", "sessions": self._sorted_summaries()})

    # ---- request_stream_events (cold-open history) ------------------------
    async def _on_request_stream_events(self, ws: Any, msg: dict[str, Any]) -> None:
        request_id = msg.get("request_id")
        host = str(msg.get("host") or "")
        session_name = str(msg.get("session_name") or "")
        stream_id = str(msg.get("stream_id") or (f"{host}:{session_name}" if host and session_name else ""))
        if not stream_id:
            await self._send(ws, {"type": "request_stream_events.error", "error_code": "internal_error", "error": "stream_id unresolved", "request_id": request_id})
            return
        try:
            limit = int(msg.get("limit") if msg.get("limit") is not None else RECENT_LIMIT_DEFAULT)
        except (TypeError, ValueError):
            limit = RECENT_LIMIT_DEFAULT
        limit = max(0, min(limit, RECENT_LIMIT_DEFAULT))
        before = msg.get("before_daemon_seq")
        events = sorted(self.recent_by_stream.get(stream_id, []), key=_event_seq)
        if before is not None:
            try:
                cutoff = int(before)
                events = [e for e in events if _event_seq(e) < cutoff]
            except (TypeError, ValueError):
                pass
        # `complete` means THIS request's response is fully delivered (all chunks),
        # NOT "no older history exists". The app fetches a bounded newest window
        # (cold-open mount-fetch uses fetch_limit=25) and pages OLDER history via
        # fresh requests carrying before_daemon_seq — so a single window response
        # is always `complete: true`, and returning `false` here makes the app's
        # mount-fetch retry-storm (chat_open_slo stalled after the first open).
        # Only when one response's serialized events exceed the frame budget do we
        # split into `.chunk` (complete:false) frames terminated by a final `.ok`.
        page = events[-limit:] if limit else []
        base = {"type": "request_stream_events.ok", "stream_id": stream_id, "request_id": request_id}
        if self._encoded_len({**base, "events": page, "complete": True}) <= STREAM_EVENTS_FRAME_BUDGET_BYTES:
            await self._send(ws, {**base, "events": page, "complete": True})
            return
        # Oversized: emit newest-chunk-first `.chunk` pages (oldest-first within a
        # chunk), then a terminal empty `.ok complete:true`.
        chunks = self._chunk_events(page, base)
        for chunk in reversed(chunks):
            await self._send(ws, {**base, "type": "request_stream_events.chunk", "events": chunk, "complete": False})
        await self._send(ws, {**base, "events": [], "complete": True})

    async def _on_thread_read(self, ws: Any, msg: dict[str, Any]) -> None:
        request_id = msg.get("request_id")
        parent_stream_id = str(msg.get("parent_stream_id") or "")
        child_stream_id = str(msg.get("child_stream_id") or "")
        entry = self.thread_history.get(f"{parent_stream_id}|{child_stream_id}")
        if not parent_stream_id or not child_stream_id or not entry:
            await self._send(ws, {"type": "thread.error", "request_id": request_id, "ok": False, "error_code": "not_direct_child", "message": "direct child history unavailable"})
            return
        cursor = msg.get("cursor")
        pages = entry.get("pages") if isinstance(entry.get("pages"), list) else []
        page = next((candidate for candidate in pages if isinstance(candidate, dict) and candidate.get("cursor") == cursor), None)
        if page is None:
            await self._send(ws, {"type": "thread.error", "request_id": request_id, "ok": False, "error_code": "cursor_invalid", "message": "history cursor unavailable"})
            return
        await self._send(ws, {
            "type": "thread.read.ok", "request_id": request_id, "ok": True,
            "parent_stream_id": parent_stream_id, "child_stream_id": child_stream_id,
            "parent_generation": str(entry.get("parent_generation") or ""),
            "child_generation": str(entry.get("child_generation") or ""),
            "rows": page.get("rows") if isinstance(page.get("rows"), list) else [],
            "next_cursor": page.get("next_cursor"),
        })

    async def _on_prompt_answer(self, ws: Any, msg: dict[str, Any]) -> None:
        question_id = str(msg.get("question_id") or "")
        if not question_id:
            await self._send(ws, {"type": "prompt.answer.error", "request_id": msg.get("request_id"), "error_code": "question_id_required", "error": "question_id is required"})
            return
        await self._send(ws, {"type": "prompt.answer.ok", "request_id": msg.get("request_id"), "question_id": question_id})

    @staticmethod
    def _encoded_len(frame: dict[str, Any]) -> int:
        return len(json.dumps(frame, separators=(",", ":")))

    def _chunk_events(self, page: list[dict[str, Any]], base: dict[str, Any]) -> list[list[dict[str, Any]]]:
        chunks: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        for event in page:  # page is oldest->newest
            current.append(event)
            if self._encoded_len({**base, "events": current, "complete": False}) > STREAM_EVENTS_FRAME_BUDGET_BYTES and len(current) > 1:
                chunks.append(current[:-1])
                current = [event]
        if current:
            chunks.append(current)
        return chunks

    # ---- harness: debug_replay_* ------------------------------------------
    async def _ack(self, ws: Any, request_id: Any, status: str, *, ack_type: str, reason: str | None = None, extra: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"type": ack_type, "request_id": request_id, "status": status}
        if reason:
            frame["reason"] = reason
        if extra:
            frame.update(extra)
        await self._send(ws, frame)

    async def _on_snapshot_config(self, ws: Any, msg: dict[str, Any]) -> None:
        self.observer_clients.add(ws)
        snapshot = msg.get("snapshot")
        if not isinstance(snapshot, dict):
            await self._ack(ws, msg.get("request_id"), "error", ack_type="debug_replay_snapshot_config.ack", reason="malformed_config")
            return
        default_host = str(msg.get("host") or self.local_host)
        sessions = snapshot.get("sessions") if isinstance(snapshot.get("sessions"), list) else []
        for session in sessions:
            if not isinstance(session, dict):
                continue
            row = dict(session)
            row.setdefault("host", default_host)
            sid = str(row.get("stream_id") or "")
            if not sid:
                continue
            self.session_summaries[sid] = row
        configured_history = snapshot.get("thread_history")
        if isinstance(configured_history, dict):
            self.thread_history = {
                str(key): dict(value) for key, value in configured_history.items()
                if isinstance(value, dict)
            }
        events = snapshot.get("events") if isinstance(snapshot.get("events"), list) else []
        count = 0
        for event in events:
            if isinstance(event, dict) and event.get("stream_id"):
                self._append_recent(event)
                count += 1
        await self._emit_session_inventory()
        await self._ack(ws, msg.get("request_id"), "ok", ack_type="debug_replay_snapshot_config.ack", extra={"sessions": len(sessions), "events": count})

    async def _on_stream_events_config(self, ws: Any, msg: dict[str, Any]) -> None:
        self.observer_clients.add(ws)
        stream_id = str(msg.get("stream_id") or msg.get("expected_stream_id") or "")
        events = msg.get("events")
        if not stream_id or not isinstance(events, list):
            await self._ack(ws, msg.get("request_id"), "error", ack_type="debug_replay_stream_events_config.ack", reason="malformed_config")
            return
        normalized = sorted([dict(e) for e in events if isinstance(e, dict)], key=_event_seq)
        self.recent_by_stream[stream_id] = normalized
        self.stream_events_config[stream_id] = {
            "close_after_chunks": max(0, int(msg.get("close_after_chunks") or 0)),
            "close_once": msg.get("close_once") is not False,
        }
        await self._ack(ws, msg.get("request_id"), "ok", ack_type="debug_replay_stream_events_config.ack", extra={"enabled": True, "stream_id": stream_id, "events": len(normalized)})

    async def _on_send_echo_config(self, ws: Any, msg: dict[str, Any]) -> None:
        if msg.get("enabled") is False:
            self.send_echo = None
            await self._ack(ws, msg.get("request_id"), "ok", ack_type="debug_replay_send_echo_config.ack", extra={"enabled": False})
            return
        # Send-echo (the daemon fabricating a chat.event / upload_blob echo when the
        # app sends) is not implemented by this mock — the three target scenarios all
        # carry send_echo={} so the injector never enables it. Fail loudly instead of
        # acking ok, so a future send/attachment scenario driven onto this mock raises
        # at config time rather than hanging on the debug_replay_observed it awaits.
        await self._ack(ws, msg.get("request_id"), "error", ack_type="debug_replay_send_echo_config.ack", reason="send_echo_unsupported_by_mock")

    async def _on_debug_event(self, ws: Any, msg: dict[str, Any]) -> None:
        event = msg.get("event")
        request_id = msg.get("request_id")
        if not isinstance(event, dict) or not str(event.get("stream_id") or "") or not str(event.get("kind") or ""):
            await self._ack(ws, request_id, "error", ack_type="debug_replay_event.ack", reason="malformed_event")
            return
        expected = str(msg.get("expected_stream_id") or "")
        if expected and expected != str(event.get("stream_id")):
            await self._ack(ws, request_id, "error", ack_type="debug_replay_event.ack", reason="stream_id_mismatch")
            return
        self._index_session(event)
        self._append_recent(event)
        await self._broadcast_app({"type": "chat.event", "event": event})
        await self._ack(ws, request_id, "ok", ack_type="debug_replay_event.ack")

    async def _on_debug_notification(self, ws: Any, msg: dict[str, Any]) -> None:
        notification = msg.get("notification")
        request_id = msg.get("request_id")
        if not isinstance(notification, dict):
            await self._ack(ws, request_id, "error", ack_type="debug_replay_notification.ack", reason="malformed_notification")
            return
        producer = str(notification.get("producer") or "")
        if producer == SEED_HISTORY_PRODUCER:
            await self._seed_history(ws, msg, notification)
            return
        if producer == MOCK_REMOVE_PRODUCER:
            await self._remove_session(ws, msg, notification)
            return
        # Generic notification (report/question updates for the freeze gate):
        # register it and broadcast so the app's Updates surface reflects it.
        record = self._notification_record(notification)
        await self._broadcast_app({"type": "notification", "notification": record})
        await self._ack(ws, request_id, "ok", ack_type="debug_replay_notification.ack", extra={"notification": record})

    async def _seed_history(self, ws: Any, msg: dict[str, Any], notification: dict[str, Any]) -> None:
        request_id = msg.get("request_id")
        stream_id = str(notification.get("stream_id") or "")
        raw_events = notification.get("events")
        if not stream_id or not isinstance(raw_events, list):
            await self._ack(ws, request_id, "error", ack_type="debug_replay_notification.ack", reason="malformed_seed")
            return
        normalized: list[dict[str, Any]] = []
        for raw_event in raw_events:
            event = self._normalize_seed_event(raw_event)
            if event is None or event["stream_id"] != stream_id:
                await self._ack(ws, request_id, "error", ack_type="debug_replay_notification.ack", reason="malformed_seed_event")
                return
            normalized.append(event)
        normalized.sort(key=_event_seq)
        if normalized:
            self._index_session(normalized[0])
        ring = self.recent_by_stream.setdefault(stream_id, [])
        ring.extend(normalized)
        await self._ack(ws, request_id, "ok", ack_type="debug_replay_notification.ack", extra={"seeded": len(normalized), "stream_id": stream_id, "ring_size": len(ring)})

    async def _remove_session(self, ws: Any, msg: dict[str, Any], notification: dict[str, Any]) -> None:
        request_id = msg.get("request_id")
        stream_id = str(notification.get("stream_id") or "")
        dropped = bool(stream_id) and self.session_summaries.pop(stream_id, None) is not None
        if dropped:
            self.recent_by_stream.pop(stream_id, None)
            self.stream_events_config.pop(stream_id, None)
            await self._emit_session_inventory()
        await self._ack(ws, request_id, "ok" if dropped else "error", ack_type="debug_replay_notification.ack", reason=None if dropped else "stream_unknown", extra={"dropped": dropped})

    async def _on_debug_close(self, ws: Any, msg: dict[str, Any]) -> None:
        target = str(msg.get("client") or msg.get("target_client") or "")
        reason = str(msg.get("close_reason") or msg.get("reason") or "")
        try:
            code = int(msg.get("code") or 4000)
        except (TypeError, ValueError):
            code = 4000
        if not 1000 <= code <= 4999:
            code = 4000
        closed = 0
        for other, state in list(self.clients.items()):
            if other is ws:
                continue
            if target and state.get("client_kind") != target:
                continue
            closed += 1
            try:
                await other.close(code, reason)
            except Exception:  # noqa: BLE001
                pass
        await self._ack(ws, msg.get("request_id"), "ok", ack_type="debug_replay_close.ack", extra={"closed": closed, "target_client": target})

    async def _on_notification_await(self, ws: Any, msg: dict[str, Any]) -> None:
        # Minimal: the scripted resolution is driven by a follow-up notification;
        # answer immediately as resolved so the injector proceeds.
        await self._send(ws, {"type": "notification.await.ok", "request_id": msg.get("request_id"), "answer": {"state": "resolved", "notification_id": msg.get("notification_id")}})

    # ---- helpers -----------------------------------------------------------
    def _append_recent(self, event: dict[str, Any]) -> None:
        stream_id = str(event.get("stream_id") or "")
        if not stream_id:
            return
        ring = self.recent_by_stream.setdefault(stream_id, [])
        ring.append(event)
        if len(ring) > self.recent_limit:
            del ring[: len(ring) - self.recent_limit]

    def _index_session(self, event: dict[str, Any]) -> None:
        stream_id = str(event.get("stream_id") or "")
        if not stream_id:
            return
        row = self.session_summaries.get(stream_id)
        if row is None:
            host = str(event.get("host") or (stream_id.split(":", 1)[0] if ":" in stream_id else self.local_host))
            session_name = str(event.get("session_name") or (stream_id.split(":", 1)[1] if ":" in stream_id else ""))
            row = {
                "stream_id": stream_id,
                "host": host,
                "session_name": session_name,
                "provider": str(event.get("provider") or "codex"),
                "title": session_name,
                "online": True,
            }
            self.session_summaries[stream_id] = row
        row["last_event_at"] = str(event.get("timestamp") or row.get("last_event_at") or "")
        row["last_kind"] = str(event.get("kind") or row.get("last_kind") or "")
        row["last_text"] = str(event.get("text") or "")

    def _notification_record(self, notification: dict[str, Any]) -> dict[str, Any]:
        record = dict(notification)
        record.setdefault("notification_id", f"mock-notif-{int(_now() * 1000)}")
        return record

    def _normalize_seed_event(self, raw_event: Any) -> dict[str, Any] | None:
        if not isinstance(raw_event, dict):
            return None
        stream_id = str(raw_event.get("stream_id") or "")
        host = str(raw_event.get("host") or "")
        session_name = str(raw_event.get("session_name") or "")
        if not stream_id and host and session_name:
            stream_id = f"{host}:{session_name}"
        if (not host or not session_name) and ":" in stream_id:
            parsed = stream_id.split(":", 1)
            host = host or parsed[0]
            session_name = session_name or parsed[1]
        if not stream_id or not host or not session_name:
            return None
        daemon_seq = raw_event.get("daemon_seq")
        if not isinstance(daemon_seq, int):
            return None
        raw = dict(raw_event.get("raw")) if isinstance(raw_event.get("raw"), dict) else {}
        raw.setdefault("source", "scripted-daemon")
        raw.setdefault("session_name", session_name)
        payload: dict[str, Any] = {
            "daemon_seq": daemon_seq,
            "host": host,
            "provider": str(raw_event.get("provider") or "codex"),
            "session_id": str(raw_event.get("session_id") or ""),
            "session_name": session_name,
            "stream_id": stream_id,
            "timestamp": str(raw_event.get("timestamp") or ""),
            "kind": str(raw_event.get("kind") or "EVENT"),
            "text": str(raw_event.get("text") or ""),
            "raw": raw,
        }
        if isinstance(raw_event.get("attachments"), list):
            payload["attachments"] = raw_event["attachments"]
        return payload

    async def _broadcast_app(self, frame: dict[str, Any]) -> None:
        payload = json.dumps(frame, separators=(",", ":"))
        for ws, state in list(self.clients.items()):
            # A freshly-connected socket is `client_kind=None, authorized=True`
            # (no auth gate) until its `hello` is dispatched. Broadcasting an
            # app frame into that pre-handshake window lands a chat.event on a
            # harness injector's socket BEFORE its own `ready` reply, breaking
            # its `welcome -> hello -> ready` handshake (the burst-phase
            # "unexpected daemon ready frame (daemon_seq N)" race). App frames
            # are only owed to a client that has completed hello, so gate on
            # client_kind being set — which also keeps harness clients excluded.
            if not state.get("client_kind") or state.get("client_kind") == "harness":
                continue
            if not state.get("authorized"):
                continue
            try:
                await ws.send(payload)
            except Exception:  # noqa: BLE001
                pass

    async def _send(self, ws: Any, frame: dict[str, Any]) -> None:
        await ws.send(json.dumps(frame, separators=(",", ":")))


async def _amain(args: argparse.Namespace) -> None:
    daemon = MockDaemon(args)
    async with serve(daemon.handler, args.bind, args.port, max_size=None):
        await asyncio.get_running_loop().create_future()  # run forever


def main() -> int:
    parser = argparse.ArgumentParser(description="standalone v2-wire mock chat_streamd for the pentacle-mobile harness")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--host", default="mock-host", help="local host name reported in snapshots")
    parser.add_argument("--credential-registry", default="", help="path to the operator-auth-v2 credential registry JSON")
    parser.add_argument("--recent-limit", type=int, default=20000)
    parser.add_argument("--enable-debug-replay-ws", action="store_true", default=True)
    args = parser.parse_args()
    try:
        asyncio.run(_amain(args))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
