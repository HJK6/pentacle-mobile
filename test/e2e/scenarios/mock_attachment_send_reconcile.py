from __future__ import annotations

import json
import time
from pathlib import Path

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event


name = "mock_attachment_send_reconcile"
FIXTURE_IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="


def actions(config: dict) -> list[str]:
    del config
    return ["autoaccept_biometric", "open_existing_chat", "send_fixture_image"]


def params(config: dict) -> dict[str, str]:
    payload = M.params_for_fixture(config, "attachment_send_reconcile.json")
    payload.update(
        {
            "text": "caption from fixture",
            "image_base64": FIXTURE_IMAGE_B64,
            "image_mime": "image/png",
            "image_name": "mock-attachment-send.png",
            "image_width": "1",
            "image_height": "1",
            "image_bytes": "68",
        }
    )
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _read_daemon_logs(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _await_daemon_log(path: Path, event: str, *, timeout_s: float = 30.0) -> dict | None:
    deadline = time.monotonic() + timeout_s
    latest: dict | None = None
    while time.monotonic() < deadline:
        for row in _read_daemon_logs(path):
            if row.get("event") == event:
                latest = row
        if latest is not None:
            return latest
        time.sleep(0.2)
    return latest


def _count_daemon_logs(path: Path, event: str) -> int:
    return sum(1 for row in _read_daemon_logs(path) if row.get("event") == event)


def _is_failure_evidence(event, optimistic_id: str) -> bool:
    if event.data.get("stream_id") != M.STREAM_ID:
        return False
    if event.data.get("optimistic_id") != optimistic_id and event.data.get("row_id") != optimistic_id:
        return False
    if event.message == "chat.compose.optimistic_failed":
        return True
    if event.message in {"chat:event_rendered", "harness:row_rendered", "chat:transcript_row_rendered"}:
        return event.data.get("send_state") == "failed"
    return False


def _await_failure_evidence(stream, optimistic_id: str, *, not_before: float, timeout_s: float = 30.0):
    deadline = time.monotonic() + timeout_s
    for event in stream.all_events():
        if event.received_at >= not_before and _is_failure_evidence(event, optimistic_id):
            return event
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if event and event.received_at >= not_before and _is_failure_evidence(event, optimistic_id):
            return event
    return None


def run_attachment_reconcile(
    scenario_name: str,
    config: dict,
    stream,
    cap=None,
    expect_failure_retry: bool = False,
) -> Verdict:
    early = M.await_mock_session_open(stream, name=scenario_name)
    if early:
        return early

    optimistic = await_event(
        stream,
        EventSpec("chat.compose.optimistic_insert", where={"stream_id": M.STREAM_ID}, timeout_s=30),
    )
    if not optimistic:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing optimistic insert for fixture image send").finish()
    optimistic_id = str(optimistic.data.get("optimistic_id") or "")
    if not optimistic_id:
        return Verdict(name=scenario_name, verdict="FAIL", error="optimistic insert missing optimistic_id").finish()

    fixture_sent = await_event(
        stream,
        EventSpec(
            "harness:send_fixture_image_sent",
            where={"stream_id": M.STREAM_ID},
            timeout_s=30,
        ),
        not_before=optimistic.received_at,
    )
    if not fixture_sent:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing send_fixture_image action telemetry").finish()
    if fixture_sent.data.get("status") != "ok":
        return Verdict(
            name=scenario_name,
            verdict="FAIL",
            error=f"send_fixture_image did not dispatch successfully: {fixture_sent.data}",
        ).finish()
    expected_text = config.get("text")
    if expected_text is not None and bool(str(expected_text).strip()) != bool(fixture_sent.data.get("has_text")):
        return Verdict(
            name=scenario_name,
            verdict="FAIL",
            error=f"send_fixture_image text-shape mismatch: expected text={bool(str(expected_text).strip())} got {fixture_sent.data}",
        ).finish()
    if int(fixture_sent.data.get("attachment_count") or 0) < 1:
        return Verdict(
            name=scenario_name,
            verdict="FAIL",
            error=f"send_fixture_image did not dispatch an attachment: {fixture_sent.data}",
        ).finish()

    log_path_raw = str(config.get("scripted_daemon_log_path") or "")
    if not log_path_raw:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing scripted_daemon_log_path").finish()
    log_path = Path(log_path_raw)
    upload = _await_daemon_log(log_path, "upload.ok", timeout_s=30)
    sent = _await_daemon_log(log_path, "send.received", timeout_s=30)
    if not upload:
        return Verdict(name=scenario_name, verdict="FAIL", error="daemon log missing upload.ok").finish()
    if not sent:
        return Verdict(name=scenario_name, verdict="FAIL", error="daemon log missing send.received").finish()
    if int(sent.get("attachment_count") or 0) < 1:
        return Verdict(name=scenario_name, verdict="FAIL", error=f"daemon send had no attachments: {sent}").finish()
    if sent.get("has_localPath") is not False:
        return Verdict(name=scenario_name, verdict="FAIL", error=f"daemon send leaked localPath: {sent}").finish()

    retry_sent = None
    failed = None
    retry = None
    if expect_failure_retry:
        failed = _await_failure_evidence(stream, optimistic_id, not_before=optimistic.received_at)
        if not failed:
            return Verdict(name=scenario_name, verdict="FAIL", error="missing failed optimistic state before retry").finish()
        retry = await_event(
            stream,
            EventSpec(
                "chat.compose.optimistic_retry",
                where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id},
                timeout_s=30,
            ),
            not_before=failed.received_at,
        )
        if not retry:
            return Verdict(name=scenario_name, verdict="FAIL", error="missing optimistic retry telemetry").finish()
        retry_sent = await_event(
            stream,
            EventSpec(
                "harness:retry_failed_send_sent",
                where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id},
                timeout_s=30,
            ),
            not_before=retry.received_at,
        )
        if not retry_sent or retry_sent.data.get("status") != "ok":
            return Verdict(
                name=scenario_name,
                verdict="FAIL",
                error=f"missing successful retry_failed_send action telemetry: {getattr(retry_sent, 'data', None)}",
            ).finish()
        failed_log = _await_daemon_log(log_path, "send.failed", timeout_s=30)
        if not failed_log:
            return Verdict(name=scenario_name, verdict="FAIL", error="daemon log missing send.failed").finish()
        if _count_daemon_logs(log_path, "send.received") < 2:
            return Verdict(name=scenario_name, verdict="FAIL", error="daemon log missing retry send.received").finish()

    reconciled = await_event(
        stream,
        EventSpec(
            "chat.compose.optimistic_reconciled",
            where={"stream_id": M.STREAM_ID, "optimistic_id": optimistic_id},
            timeout_s=30,
        ),
        not_before=optimistic.received_at,
    )
    if not reconciled:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing optimistic reconcile for fixture image send").finish()

    rendered = await_event(
        stream,
        EventSpec(
            "chat:event_rendered",
            where={"stream_id": M.STREAM_ID, "correlated_daemon_seq": 31, "optimistic_id": optimistic_id},
            timeout_s=30,
        ),
        not_before=reconciled.received_at,
    )
    if not rendered:
        return Verdict(name=scenario_name, verdict="FAIL", error="missing rendered USER echo for fixture image send").finish()

    attachment_count = int(rendered.data.get("attachment_count") or 0)
    send_state = rendered.data.get("send_state")
    verdict = Verdict(
        name=scenario_name,
        verdict="PASS",
        extras={
            "optimistic_id": optimistic_id,
            "fixture_action": dict(fixture_sent.data),
            "daemon_upload": upload,
            "daemon_send": sent,
            "rendered": dict(rendered.data),
            **({"retry_action": dict(retry_sent.data), "retry": dict(retry.data), "failure": dict(failed.data)} if retry_sent and retry and failed else {}),
        },
    )
    if attachment_count < 1:
        verdict.verdict = "FAIL"
        verdict.error = f"rendered USER echo missing attachment_count: {rendered.data}"
    elif send_state in {"sending", "failed"}:
        verdict.verdict = "FAIL"
        verdict.error = f"rendered USER echo still has send_state={send_state}"
    return M.finish_with_negative_watch(stream, verdict, cap=cap, screenshot_name=scenario_name)


def run(config: dict, stream, cap=None) -> Verdict:
    return run_attachment_reconcile(name, config, stream, cap=cap)
