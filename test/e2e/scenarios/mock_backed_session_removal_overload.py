from __future__ import annotations

from . import mock_composite_chat_load as composite

name = "mock_backed_session_removal_overload"
SCENARIO_META = composite.SCENARIO_META
actions = composite.actions
preflight = composite.preflight
run = composite.run


def params(config: dict) -> dict[str, str]:
    payload = composite.params_for_interval(
        config,
        frame_interval_ms=8,
        backed_session=True,
        delete_budget_ms=10_000,
    )
    payload["composite_scenario_name"] = name
    return payload
