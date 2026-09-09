"""Synthetic open-existing-chat send scenario factory.

Each factory is parameterized by a host label and provider. It reads an
injected seeded stream identifier, checks the ordered open/send lifecycle, and
requires row-level render evidence before reporting success.
"""
from __future__ import annotations

from . import _biometric_matrix_fixture as BM

SCENARIO_META = BM.SIMULATOR_META

import time
from types import SimpleNamespace
from typing import Optional

from . import _assertions as A
from ._run_state import load_seeded_stream
from ..harness.asserts import EventSpec, Verdict, await_event
from ..harness.render_evidence import (
    assert_assistant_reply_rendered,
    assert_transcript_landing_corroborated,
)


RECONCILE_TIMEOUT_S = 60.0


def _build_steps(stream_id: str):
    # The strict cursor validates the deterministic open/send prefix. The
    # completion events are checked by presence and count because delivery order
    # can vary between a user echo and the send result.
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
        A.strict("chat:ws_open", count=1, label="04 ws_open"),
        # 5
        A.strict("harness:open_chat_then_send_scheduled", count=1, label="05 open_scheduled"),
        # 6
        A.strict(
            "harness:open_existing_chat_attempted",
            count=1,
            where=P,
            label="06 open_existing_chat_attempted",
        ),
        # 7
        A.strict(
            "harness:session_screen_mount",
            count=1,
            where=P,
            label="07 session_screen_mount",
        ),
        # 8
        A.strict(
            "harness:transcript_ready_settled",
            count=1,
            where=P,
            label="08 transcript_ready_settled",
        ),
        # 9 — optimistic_insert fires synchronously inside the composer
        # handler, BEFORE dispatchSend's await resolves.
        A.strict(
            "chat.compose.optimistic_insert",
            count=A.gte(1),
            where=P,
            label="09 optimistic_insert",
        ),
        # NEG
        A.neg("chat.compose.optimistic_failed", label="NEG optimistic_failed"),
    ]


def _trace_from_stream(stream) -> list[dict]:
    return [
        {"name": ev.message, "data": dict(ev.data), "timestamp": ev.received_at}
        for ev in stream.all_events()
    ]


def _setup_fail(name: str, host: str, provider: str, reason: str) -> Verdict:
    return Verdict(
        name=name,
        verdict="SETUP_FAIL",
        steps=[],
        error=reason,
        extras={"host": host, "provider": provider, "reason": reason},
    ).finish()


def make_scenario(host: str, provider: str):
    host = host.strip().lower()
    provider = provider.strip().lower()
    if provider not in ("claude", "codex"):
        raise ValueError(f"unsupported provider for F2: {provider!r}")

    name = f"open_existing_chat_send_{host}_{provider}"

    def actions(config):
        out = ["autoaccept_biometric", "open_chat_then_send"]
        if str(config.get("PENTACLE_E2E_TARGET") or "").lower() != "simulator":
            out.insert(1, "disable_pentacle_auth")
        return out

    def params(config):
        text = "another please"
        seeded = _resolve_seeded(config, host, provider)
        if not seeded and str(config.get("PENTACLE_E2E_TARGET") or "").lower() == "simulator":
            seeded = BM.default_stream_id(config, host=host, provider=provider, scenario_name=name)
            BM.ensure_seeded(config, host=host, provider=provider, stream_id=seeded)
        out = {"host": host, "provider": provider, "text": text}
        if seeded:
            out["stream_id"] = seeded
            fixture = BM.write_existing_chat_fixture(
                config,
                scenario_name=name,
                host=host,
                provider=provider,
                stream_id=seeded,
            )
            out["mock_fixture_path"] = str(fixture)
            out["scripted_daemon_fixture_path"] = str(fixture)
        return out

    def preflight(config: dict, repo_root=None) -> str | None:
        # A missing seed is a setup failure; callers must provide the stream
        # explicitly rather than selecting an unrelated session.
        seeded = _resolve_seeded(config, host, provider)
        if not seeded:
            return "no_seeded_or_eligible_chat"
        return None

    def run(config: dict, stream, cap=None) -> Verdict:
        started = time.monotonic()
        if cap:
            cap.screenshot(f"{name}_start")

        seeded_stream_id = _resolve_seeded(config, host, provider)
        if not seeded_stream_id:
            return _setup_fail(name, host, provider, "no_seeded_or_eligible_chat")

        # Anchor assertions on the stream selected by the open action. The
        # injected snapshot may contain more than one eligible session.
        attempted = await_event(
            stream,
            EventSpec(
                "harness:open_existing_chat_attempted",
                timeout_s=RECONCILE_TIMEOUT_S,
            ),
        )
        if attempted:
            stream_id = str(attempted.data.get("stream_id") or seeded_stream_id)
        else:
            stream_id = seeded_stream_id

        # Wait for the final reconcile to land (or time out) so the trace is
        # complete by the time we check assertions.
        reconciled = await_event(
            stream,
            EventSpec(
                "chat.compose.optimistic_reconciled",
                where={"stream_id": stream_id},
                timeout_s=RECONCILE_TIMEOUT_S,
            ),
        )
        # `harness:open_chat_then_send_sent` fires AFTER reconcile (because
        # the resilience fix in pentacleStream resolves the pending send
        # off the chat.event USER echo that also triggers reconcile, so
        # the dispatchSend await unblocks in the same microtask burst).
        # Wait for it explicitly so the trace contains it before we
        # snapshot.
        if reconciled:
            await_event(
                stream,
                EventSpec(
                    "harness:open_chat_then_send_sent",
                    timeout_s=5.0,
                ),
                not_before=reconciled.received_at,
            )
            await_event(
                stream,
                EventSpec(
                    "harness:row_rendered",
                    where={"stream_id": stream_id},
                    timeout_s=10.0,
                ),
                not_before=reconciled.received_at,
            )

        trace = _trace_from_stream(stream)
        steps = _build_steps(stream_id)
        result = A.TelemetryAssertion(steps).check(trace)
        result.info["host"] = host
        result.info["provider"] = provider
        result.info["stream_id"] = stream_id
        result.info["duration_s"] = round(time.monotonic() - started, 2)

        # Completion-event contract: presence + count for the events that
        # race on daemon timing (see _build_steps note).
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
        if _count("harness:open_chat_then_send_sent") != 1:
            completion_errors.append(
                f"expected 1 harness:open_chat_then_send_sent, got "
                f"{_count('harness:open_chat_then_send_sent')}"
            )
        reconciles = _count("chat.compose.optimistic_reconciled", scope)
        if reconciles < 1:
            completion_errors.append(
                f"expected >=1 chat.compose.optimistic_reconciled, got {reconciles}"
            )
        result.info["completion_errors"] = completion_errors

        # A mounted assistant reply is required; transport counters alone do
        # not prove visible content.
        reply_ok, reply_err, reply_info = assert_assistant_reply_rendered(
            trace, stream_id, provider=provider
        )
        result.info["assistant_reply"] = reply_info
        # The settled landing must be corroborated by at least one rendered
        # row; a timeout fallback is not evidence.
        landing_ok, landing_err, landing_info = assert_transcript_landing_corroborated(
            trace, stream_id
        )
        result.info["transcript_landing"] = landing_info

        passed = result.passed and not completion_errors and reply_ok and landing_ok
        verdict_str = "PASS" if passed else "FAIL"
        error_parts: list[str] = []
        if not result.passed:
            error_parts.append(A.format_failure_report(result))
        if completion_errors:
            error_parts.append("Completion-event contract: " + "; ".join(completion_errors))
        if not reply_ok:
            error_parts.append("Reply-render evidence: " + (reply_err or "no rendered reply"))
        if not landing_ok:
            error_parts.append("Landing evidence: " + (landing_err or "uncorroborated landing"))
        error = "; ".join(error_parts) if error_parts else None

        verdict = Verdict(
            name=name,
            verdict=verdict_str,
            steps=[],
            error=error,
            extras={
                "host": host,
                "provider": provider,
                "stream_id": stream_id,
                "assertion_result": result.to_dict(),
                "summary": result.summary,
                "assistant_reply": reply_info,
                "transcript_landing": landing_info,
            },
        )
        if cap:
            cap.screenshot(f"{name}_end")
        return verdict.finish()

    return SimpleNamespace(
        name=name,
        host=host,
        provider=provider,
        actions=actions,
        params=params,
        preflight=preflight,
        run=run,
        build_steps=_build_steps,
    )


def _resolve_seeded(config: dict, host: str, provider: str) -> Optional[str]:
    direct = str(config.get("seeded_stream_id") or config.get("stream_id") or "").strip()
    if direct:
        return direct
    run_id = str(config.get("RUN_ID") or config.get("PENTACLE_RUN_ID") or "default")
    state_dir = config.get("state_dir")
    return load_seeded_stream(run_id=run_id, host=host, provider=provider, state_dir=state_dir)


IS_FACTORY = True
