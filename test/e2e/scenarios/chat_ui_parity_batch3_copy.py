from __future__ import annotations

# Provider gating is handled by preflight() below (returns requires_codex_provider),
# matching how the flow codex scenarios gate provider via action params rather than a
# SCENARIO_META requirement — "codex" is not in the harness VALID_REQUIRES set
# ({biometric_hardware, real_network, real_keyboard, claude}).
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

import time

from . import _biometric_matrix_fixture as BM
from ..harness.asserts import EventSpec, Verdict, await_event


name = "chat_ui_parity_copy"

CODE_TEXT = 'const exampleCopy = "raw-code";'
MESSAGE_TEXT = (
    "Reply exactly with this fenced TypeScript code block and no prose:\n"
    "```ts\n"
    f"{CODE_TEXT}\n"
    "```"
)


def actions(_config):
    out = [
        "autoaccept_biometric",
        "spawn_chat_then_send",
        "copy_chat_sample",
    ]
    if str(_config.get("PENTACLE_E2E_TARGET") or "").lower() != "simulator":
        out.insert(1, "disable_pentacle_auth")
    return out


def params(config):
    out = {
        "host": "hostc",
        "provider": "codex",
        "text": MESSAGE_TEXT,
        "message_text": MESSAGE_TEXT,
        "code_text": CODE_TEXT,
        "copy_delay_ms": "1200",
    }
    if str(config.get("PENTACLE_E2E_TARGET") or "").lower() == "simulator":
        fixture = BM.write_spawn_chat_fixture(
            config,
            scenario_name=name,
            host="hostc",
            provider="codex",
            assistant_replies=[MESSAGE_TEXT],
        )
        out["mock_fixture_path"] = str(fixture)
        out["scripted_daemon_fixture_path"] = str(fixture)
    return out


def preflight(config: dict, repo_root=None) -> str | None:
    host = str(config.get("host") or "hostc").strip()
    provider = str(config.get("provider") or "codex").strip()
    if not host:
        return "missing_host"
    if provider != "codex":
        return "requires_codex_provider"
    return None


def _identity(text: str) -> str:
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{len(text)}:{h:08x}"


def run(config: dict, stream, cap=None):
    started = time.monotonic()
    if cap:
        cap.screenshot(f"{name}_start")

    mounted = await_event(stream, EventSpec("harness:session_screen_mount", timeout_s=30.0))
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
        EventSpec("harness:spawn_chat_then_send_sent", where={"stream_id": stream_id}, timeout_s=60.0),
    )
    message_event = await_event(
        stream,
        EventSpec(
            "chat:copy_invoked",
            where={
                "stream_id": stream_id,
                "copy_kind": "message",
                "copied_length": len(MESSAGE_TEXT),
                "identity": _identity(MESSAGE_TEXT),
            },
            timeout_s=20.0,
        ),
    )
    code_event = await_event(
        stream,
        EventSpec(
            "chat:copy_invoked",
            where={
                "stream_id": stream_id,
                "copy_kind": "code",
                "copied_length": len(CODE_TEXT),
                "identity": _identity(CODE_TEXT),
            },
            timeout_s=20.0,
        ),
        not_before=message_event.received_at if message_event else None,
    )
    confirmation = await_event(
        stream,
        EventSpec(
            "harness:row_rendered",
            where={
                "stream_id": stream_id,
                "component_name": "CopyConfirmation",
                "displayRule": "component:copy-confirmation",
                "text_prefix": "Copied",
                "lifecycle": "mount",
            },
            timeout_s=10.0,
        ),
        not_before=message_event.received_at if message_event else None,
    )

    errors: list[str] = []
    if not message_event:
        errors.append("missing message chat:copy_invoked")
    if not code_event:
        errors.append("missing code chat:copy_invoked")
    if not confirmation:
        errors.append("missing Copied confirmation render")

    if cap:
        cap.screenshot(f"{name}_end")
    return Verdict(
        name=name,
        verdict="PASS" if not errors else "FAIL",
        error="; ".join(errors) if errors else None,
        extras={
            "stream_id": stream_id,
            "message_identity": _identity(MESSAGE_TEXT),
            "code_identity": _identity(CODE_TEXT),
            "duration_s": round(time.monotonic() - started, 2),
        },
    ).finish()
