from __future__ import annotations

import os
import subprocess
import time

# TODO(target-compat): tighten if this scenario gains device-only requirements.
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from ..harness.asserts import EventSpec, assert_no_events, assert_sequence
from ..harness.scenario_control import run_command_action, setup_fail
from ..harness.simulator import scenario_simctl_command


def _command_env(config: dict) -> dict[str, str]:
    return {
        key: str(value)
        for key, value in config.items()
        if key.startswith("PENTACLE_") and value is not None
    }


def preflight(config: dict, repo_root=None) -> str | None:
    if str(config.get("PENTACLE_E2E_TARGET") or "").strip() == "simulator":
        return None
    if str(config.get("PENTACLE_BIOMETRIC_RESUME_COMMAND") or "").strip():
        return None
    return (
        "biometric_lock_resume requires a scripted background/foreground action. Set "
        "PENTACLE_BIOMETRIC_RESUME_COMMAND to send the app to background and foreground it again; "
        "manual fallback is: lock the device, unlock it, and return to the app within 15 seconds."
    )


def _simulator_background_foreground(config: dict):
    udid = str(config.get("PENTACLE_SIMULATOR_UDID") or os.environ.get("PENTACLE_SIMULATOR_UDID") or "").strip()
    bundle_id = str(config.get("PENTACLE_BUNDLE_ID") or "").strip()
    if not udid or not bundle_id:
        return setup_fail("biometric_lock_resume", "simulator resume requires UDID and bundle id")
    commands = [
        scenario_simctl_command("openurl", udid, "App-Prefs:"),
        scenario_simctl_command("launch", udid, bundle_id),
    ]
    for index, command in enumerate(commands):
        proc = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
        if proc.returncode != 0:
            return setup_fail(
                "biometric_lock_resume",
                f"simulator background/foreground step {index + 1} failed",
                command=command,
                stdout=proc.stdout.strip(),
                stderr=proc.stderr.strip(),
            )
        if index == 0:
            time.sleep(1)
    return None


def run(config: dict, stream, cap=None):
    """Assert background -> foreground schedules and resolves biometric auth."""
    command = str(config.get("PENTACLE_BIOMETRIC_RESUME_COMMAND") or "").strip()
    action = (
        run_command_action(
            name="biometric_lock_resume",
            command=command,
            timeout_s=20,
            env=_command_env(config),
        )
        if command
        else _simulator_background_foreground(config)
    )
    if action:
        return action
    verdict = assert_sequence(
        stream,
        [
            EventSpec("auth:biometric_prompt_scheduled", where={"trigger": "foreground"}, timeout_s=60),
            EventSpec("auth:biometric_prompt_resolved", where={"trigger": "foreground"}, timeout_s=45),
        ],
        name="biometric_lock_resume",
    )
    verdict.fold_negative_watch(assert_no_events(stream, window_s=3))
    if cap:
        cap.screenshot("biometric_lock_resume")
    return verdict.finish()
