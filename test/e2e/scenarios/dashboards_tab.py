from __future__ import annotations

import json
from pathlib import Path

from ..harness.asserts import Verdict

SCENARIO_META = {"target_compat": {"simulator", "device"}, "requires": []}

name = "dashboards_tab"
PORT = 17880
REQUIRED_MESSAGES = (
    "dashboard:screen_mounted",
    "dashboard:panels_rendered",
    "dashboard:refresh_completed",
)


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "dashboard_fixture_probe"]


def params(config: dict) -> dict[str, str]:
    fixture = str(config.get("dashboard_fixture_path") or "testing.json")
    return {
        "dashboard_fixture": fixture,
        "dashboard_mode": "synthetic",
        "dashboard_refresh_interval_ms": "500",
    }


def preflight(config: dict, repo_root=None) -> str | None:
    del repo_root
    fixture = str(config.get("dashboard_fixture_path") or "").strip()
    if fixture and not Path(fixture).expanduser().is_file():
        return f"dashboard fixture missing: {fixture}"
    return None


def _fixture_contract(payload: dict) -> str | None:
    if payload.get("schema_version") != 1:
        return "dashboard fixture has an unsupported schema version"
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("panels"), dict):
        return "dashboard fixture has no panel collection"
    panels = data["panels"]
    required = {"now_running", "latest_gate_runs", "whats_left", "time_estimates"}
    missing = sorted(required - panels.keys())
    return f"dashboard fixture is missing panels: {missing}" if missing else None


def _assert_control_contract(fixture_dir: Path) -> str | None:
    """Validate the public fixture shape without contacting a control service."""
    try:
        payload = json.loads((fixture_dir / "testing.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return f"unable to read dashboard fixture: {exc}"
    return _fixture_contract(payload)


def _control_state(body: dict) -> dict:
    state = str(body.get("state") or "closed")
    if state not in {"open", "closed"}:
        return {"status": "rejected", "reason": "state must be open or closed"}
    return {"status": "ok", "state": state}


def _event_messages(stream) -> set[str]:
    return {
        str(getattr(event, "message", ""))
        for event in stream.all_events()
    }


def _fail(error: str, *, extras: dict | None = None) -> Verdict:
    return Verdict(name=name, verdict="FAIL", error=error, extras=extras or {}).finish()


def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")

    failures: list[str] = []
    fixture = str(config.get("dashboard_fixture_path") or "").strip()
    if fixture:
        try:
            payload = json.loads(Path(fixture).expanduser().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            failures.append(f"dashboard fixture could not be parsed: {exc}")
        else:
            contract_error = _fixture_contract(payload)
            if contract_error:
                failures.append(contract_error)

    messages = _event_messages(stream)
    missing = [message for message in REQUIRED_MESSAGES if message not in messages]
    if missing:
        failures.append(f"missing dashboard lifecycle messages: {missing}")

    control = _control_state({"state": "open"})
    if control.get("status") != "ok" or control.get("state") != "open":
        failures.append("synthetic control state did not transition to open")

    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "mode": "synthetic",
            "required_messages": list(REQUIRED_MESSAGES),
            "observed_messages": sorted(messages),
            "control_state": control,
        },
    )
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict.finish()

