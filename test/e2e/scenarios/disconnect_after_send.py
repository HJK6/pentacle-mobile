"""Synthetic send/disconnect/reconnect scenario factory.

The scenario checks a deterministic optimistic-send prefix, a forced connection
close, and exactly one successful reconciliation after reconnect.
"""
from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

from . import _assertions as A
from . import _mock_chat_streamd as M
from ._run_state import load_seeded_stream
from ..harness.asserts import EventSpec, Verdict, await_event


SCENARIO_OVERALL_TIMEOUT_S = 120.0
RECONNECT_TIMEOUT_S = 70.0  # bounded reconnect window
FIXTURE_SESSION_NAME = "example-disconnect-after-send"
FIXTURE_IMAGE_B64 = "c3ludGhldGljLWltYWdl"


def _build_steps(stream_id: str):
    # The strict cursor validates the deterministic prefix. Completion events
    # are checked by presence and count because delivery can race the close.
    def P(d: dict) -> bool:
        return d.get("stream_id") == stream_id

    return [
        # 1
        A.strict("harness:harness_armed", count=1, label="01 harness_armed"),
        # 2-3 GROUP biometric
        A.group("biometric", "auth:biometric_prompt_scheduled", count=1, label="02 biometric_scheduled"),
        A.group(
            "biometric",
            "auth:biometric_prompt_resolved",
            count=1,
            where=lambda d: d.get("outcome") == "success" and d.get("harness") is True,
            label="03 biometric_resolved",
        ),
        # 4
        A.strict("chat:ws_open", count=A.gte(1), label="04 ws_open"),
        # 5
        A.strict(
            "harness:session_screen_mount",
            count=1,
            where=P,
            label="05 session_screen_mount",
        ),
        # 6 — optimistic_insert fires synchronously inside the composer
        # handler, BEFORE dispatchSend's await resolves.
        A.strict(
            "chat.compose.optimistic_insert",
            count=A.gte(1),
            where=P,
            label="06 optimistic_insert",
        ),
        # NEG
        A.neg("harness:disconnect_after_send_aborted", label="NEG disconnect_after_send_aborted"),
    ]


def _trace_from_stream(stream, *, not_before: float = 0.0) -> list[dict]:
    return [
        {"name": ev.message, "data": dict(ev.data), "timestamp": ev.received_at}
        for ev in stream.all_events()
        if ev.received_at >= not_before
    ]


def _setup_fail(name: str, host: str, reason: str) -> Verdict:
    return Verdict(
        name=name,
        verdict="SETUP_FAIL",
        steps=[],
        error=reason,
        extras={"host": host, "provider": "codex", "reason": reason},
    ).finish()


def _scripted_stream_id(host: str) -> str:
    return f"{M.HOST}:{host}-disconnect-after-send"


def _scripted_session_name(host: str) -> str:
    return f"{host}-disconnect-after-send"


def _fixture_path(config: dict, host: str) -> Path:
    run_id = str(
        config.get("scenario_run_id")
        or config.get("RUN_ID")
        or config.get("PENTACLE_RUN_ID")
        or "example-run"
    )
    return Path("/tmp") / f"example-disconnect-after-send-{host}-{run_id}.json"


def _write_fixture(path: Path, host: str) -> None:
    stream_id = _scripted_stream_id(host)
    payload = {
        "schema_version": 1,
        "name": f"disconnect_after_send_{host}",
        "stream": {
            "stream_id": stream_id,
            "host": M.HOST,
            "provider": M.PROVIDER,
            "session_name": _scripted_session_name(host),
            "title": f"Disconnect after send {host}",
        },
        "snapshot": {
            "sessions": [
                {
                    "stream_id": stream_id,
                    "host": M.HOST,
                    "provider": M.PROVIDER,
                    "session_name": _scripted_session_name(host),
                    "title": f"Disconnect after send {host}",
                    "working": False,
                    "online": True,
                }
            ],
            "events": [],
        },
        "frames": [
            {
                "id": "anchor",
                "at_ms": 0,
                "type": "chat.event",
                "wait_for_client": True,
                "event": {
                    "kind": "ASSIST",
                    "daemon_seq": 1,
                    "timestamp": "2026-07-09T18:20:00.000Z",
                    "text": f"ready for disconnect after send on {host}",
                },
            },
        ],
        "upload": {"required": True},
        "send_echo": {
            "daemon_seq": 2,
            "timestamp": "2026-07-09T18:20:01.000Z",
            "wait_for_send_s": 120,
            "echo_delay_ms": 1500,
        },
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def _resolve_seeded(config: dict, host: str) -> Optional[str]:
    if config.get("same_stream_recovery") and str(config.get("stream_id") or "").strip():
        return str(config["stream_id"]).strip()
    if str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip():
        return str(config.get("stream_id") or _scripted_stream_id(host))
    run_id = str(config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or "default")
    state_dir = config.get("state_dir")
    return load_seeded_stream(run_id=run_id, host=host, provider="codex", state_dir=state_dir)


def make_scenario(host: str):
    host = host.strip().lower()
    name = f"disconnect_after_send_{host}"

    def actions(_config):
        # dump_session_state runs synchronously between send_fixture_image
        # and disconnect_after_send so the snapshot lands while the
        # optimistic_insert is in flight. The
        # `harness:session_state_dump_complete` assertion in _build_steps
        # validates the dump fired in the strict window between
        # optimistic_insert and disconnect_after_send_scheduled.
        # autoaccept_biometric + disable_pentacle_auth are the standard
        # cold-launch unblockers.
        return [
            "autoaccept_biometric",
            "send_fixture_image",
            "dump_session_state",
            "disconnect_after_send",
        ]

    def params(config):
        fixture = _fixture_path(config, host)
        _write_fixture(fixture, host)
        out = {
            "host": M.HOST,
            "provider": M.PROVIDER,
            "entry_source": "search",
            "text": "disconnect test",
            "image_base64": FIXTURE_IMAGE_B64,
            "image_mime": "image/png",
            "image_name": "disconnect-after-send.png",
            "image_width": "1",
            "image_height": "1",
            "image_bytes": "68",
            "stream_id": _scripted_stream_id(host),
            "mock_fixture_path": str(fixture),
            "scripted_daemon_fixture_path": str(fixture),
            "scenario_run_id": str(
                config.get("scenario_run_id")
                or config.get("RUN_ID")
                or config.get("PENTACLE_RUN_ID")
                or fixture.stem
            ),
            "PENTACLE_EVENT_REPLAY_COMMAND": "",
        }
        if str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip():
            seeded = _resolve_seeded(config, host)
            if seeded:
                out["stream_id"] = seeded
        return out

    def preflight(config: dict, repo_root=None) -> str | None:
        if str(config.get("scripted_daemon_fixture_path") or config.get("mock_fixture_path") or "").strip():
            return M.preflight(config, repo_root)
        if not _resolve_seeded(config, host):
            return "no_seeded_codex_chat"
        return None

    def run(config: dict, stream, cap=None) -> Verdict:
        started = time.monotonic()
        not_before = float(config.get("recovery_not_before") or 0.0)
        send_terminal_event = str(
            config.get("recovery_send_terminal_event") or "harness:send_fixture_image_sent"
        )
        recovery_provider = str(config.get("recovery_provider") or "codex")
        if cap:
            cap.screenshot(f"{name}_start")

        stream_id = _resolve_seeded(config, host)
        if not stream_id:
            return _setup_fail(name, host, "no_seeded_codex_chat")

        # Wait for transcript_resumed before checking the bounded completion
        # window.
        resumed_seen = await_event(
            stream,
            EventSpec(
                "chat:transcript_resumed",
                where={"stream_id": stream_id},
                timeout_s=SCENARIO_OVERALL_TIMEOUT_S,
            ),
            not_before=not_before,
        )

        # Drain for the terminator: whichever of reconciled / failed arrives
        # first, we stop. Both have stream_id scoping.
        deadline = time.monotonic() + RECONNECT_TIMEOUT_S
        terminator_seen = False
        while time.monotonic() < deadline and not terminator_seen:
            ev = stream.next_event(timeout_s=1.0)
            if not ev:
                continue
            if ev.received_at < not_before:
                continue
            if ev.message == "chat.compose.optimistic_reconciled" and ev.data.get("stream_id") == stream_id:
                terminator_seen = True
            elif ev.message == "chat.compose.optimistic_failed" and ev.data.get("stream_id") == stream_id:
                terminator_seen = True

        trace = _trace_from_stream(stream, not_before=not_before)
        steps = _build_steps(stream_id)
        result = A.TelemetryAssertion(steps).check(trace)
        result.info["host"] = host
        result.info["stream_id"] = stream_id
        result.info["duration_s"] = round(time.monotonic() - started, 2)
        result.info["resumed_seen"] = bool(resumed_seen)

        # Completion events are checked by presence and count because delivery
        # can race the close.
        def _count(name_: str, where: dict | None = None) -> int:
            n = 0
            for ev in trace:
                if ev["name"] != name_:
                    continue
                if where is not None and any(ev["data"].get(k) != v for k, v in where.items()):
                    continue
                n += 1
            return n

        completion_errors: list[str] = []
        scope = {"stream_id": stream_id}
        sent_events = [
            ev for ev in trace
            if ev["name"] == send_terminal_event
            and ev["data"].get("stream_id") == stream_id
        ]
        if len(sent_events) != 1:
            completion_errors.append(
                f"expected 1 {send_terminal_event} for stream, got {len(sent_events)}"
            )
        elif sent_events[0]["data"].get("status") != "ok":
            completion_errors.append(f"{send_terminal_event} status was not ok")
        if _count("harness:disconnect_after_send_scheduled") < 1:
            completion_errors.append("expected >=1 harness:disconnect_after_send_scheduled, got 0")
        closed_events = [
            ev for ev in trace
            if ev["name"] == "harness:disconnect_after_send_closed"
            and ev["data"].get("stream_id") == stream_id
        ]
        if len(closed_events) < 1:
            completion_errors.append("expected >=1 harness:disconnect_after_send_closed for stream, got 0")
        if _count("chat:ws_close", {"reason": "harness_forced"}) < 1:
            completion_errors.append("expected >=1 chat:ws_close(reason=harness_forced), got 0")
        if _count("chat:ws_reconnect_attempt") < 1:
            completion_errors.append("expected >=1 chat:ws_reconnect_attempt, got 0")
        if _count("chat:ws_reconnect_succeeded") < 1:
            completion_errors.append("expected >=1 chat:ws_reconnect_succeeded, got 0")
        optimistic_id = str(closed_events[0]["data"].get("optimistic_id") or "") if closed_events else ""
        result.info["optimistic_id"] = optimistic_id
        if not optimistic_id:
            completion_errors.append("disconnect_after_send_closed missing optimistic_id")

        def _events(name_: str, where: dict | None = None) -> list[dict]:
            matches: list[dict] = []
            for ev in trace:
                if ev["name"] != name_:
                    continue
                if where is not None and any(ev["data"].get(k) != v for k, v in where.items()):
                    continue
                matches.append(ev)
            return matches

        optimistic_scope = {"stream_id": stream_id, "optimistic_id": optimistic_id} if optimistic_id else scope
        reconciled_events = _events("chat.compose.optimistic_reconciled", optimistic_scope)
        failed_events = _events("chat.compose.optimistic_failed", optimistic_scope)
        if closed_events and optimistic_id:
            closed_at = float(closed_events[0]["timestamp"])
            terminal_before_drop = [
                ev for ev in [*reconciled_events, *failed_events]
                if float(ev["timestamp"]) < closed_at
            ]
            if terminal_before_drop:
                completion_errors.append("send was not pending at drop; terminal optimistic event preceded forced close")
        if failed_events:
            completion_errors.append("expected reconciled-only end-state after reconnect, observed optimistic_failed")
        if len(reconciled_events) != 1:
            completion_errors.append(
                f"expected exactly one chat.compose.optimistic_reconciled for dropped optimistic, got {len(reconciled_events)}"
            )
        reconcile_at = float(reconciled_events[0]["timestamp"]) if reconciled_events else None
        stuck_renders = [
            ev for ev in _events("chat:event_rendered", optimistic_scope)
            if (reconcile_at is None or float(ev["timestamp"]) >= reconcile_at)
            and ev["data"].get("send_state") in {"sending", "failed"}
        ]
        if stuck_renders:
            completion_errors.append("rendered row remained in sending/failed state after reconnect")
        result.info["completion_errors"] = completion_errors

        passed = result.passed and not completion_errors
        verdict_str = "PASS" if passed else "FAIL"
        error_parts: list[str] = []
        if not result.passed:
            error_parts.append(A.format_failure_report(result))
        if completion_errors:
            error_parts.append("Completion-event contract: " + "; ".join(completion_errors))
        error = "; ".join(error_parts) if error_parts else None

        verdict = Verdict(
            name=name,
            verdict=verdict_str,
            steps=[],
            error=error,
            extras={
                "host": host,
                "provider": recovery_provider,
                "stream_id": stream_id,
                "assertion_result": result.to_dict(),
                "summary": result.summary,
                "terminator_outcome": result.terminator_outcome,
                "optimistic_id": optimistic_id,
            },
        )
        if cap:
            cap.screenshot(f"{name}_end")
        return verdict.finish()

    return SimpleNamespace(
        name=name,
        host=host,
        provider="codex",
        actions=actions,
        params=params,
        preflight=preflight,
        run=run,
        build_steps=_build_steps,
    )


IS_FACTORY = True
