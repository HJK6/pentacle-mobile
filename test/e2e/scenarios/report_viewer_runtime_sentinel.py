"""Arm the application's real public runtime sentinels; monitor is owned by the runner."""
from __future__ import annotations
from ..harness.asserts import EventSpec, Verdict, await_event

name = "report_viewer_runtime_sentinel"
SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}


def actions(_config):
    return ["autoaccept_biometric", "runtime_error_check"]


def params(config):
    result = {"runtime_sentinel": config["runtime_sentinel"]}
    if config.get("runtime_sentinel_release_url"):
        result["runtime_sentinel_release_url"] = config["runtime_sentinel_release_url"]
    return result


def run(config, stream, cap=None):
    event = await_event(stream, EventSpec("harness:runtime_sentinel_ready", {"scenario_run_id": config["scenario_run_id"], "sentinel": config["runtime_sentinel"]}, 20))
    return Verdict(name, "PASS" if event else "FAIL", error=None if event else "runtime sentinel did not render its ready event", extras={"ready": event.to_dict() if event else None}).finish()
