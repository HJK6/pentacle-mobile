"""Route-navigation smoke for a mobile tab bar.

The scenario observes focus events for Chats, Updates, and Settings. It is
limited to the event contract so it can run with either a device adapter or a
simulator adapter.
"""
from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from ..harness.asserts import EventSpec, Verdict, assert_sequence


name = "tab_navigation"


def actions(_config):
    return ["autoaccept_biometric", "disable_pentacle_auth", "tab_navigation"]


def params(_config: dict):
    return {}


def preflight(config: dict, repo_root=None) -> str | None:
    return None


def run(config: dict, stream, cap=None) -> Verdict:
    if cap:
        cap.screenshot(f"{name}_start")
    verdict = assert_sequence(
        stream,
        [
            EventSpec("harness:tab_navigation_scheduled", timeout_s=15),
            EventSpec("tabs:screen_focused", where={"tab": "chats"}, timeout_s=15),
            EventSpec("tabs:screen_focused", where={"tab": "updates"}, timeout_s=15),
            EventSpec("tabs:screen_focused", where={"tab": "settings"}, timeout_s=15),
            EventSpec("harness:tab_navigation_done", timeout_s=15),
        ],
        name=name,
    ).finish()
    verdict.extras["coverage_note"] = "route_navigation_tab_focus_smoke"
    if cap:
        cap.screenshot(f"{name}_end")
    return verdict

