from __future__ import annotations

from . import mock_composite_chat_load as composite

name = "mock_backed_session_removal_steady"
SCENARIO_META = composite.SCENARIO_META
actions = composite.actions
preflight = composite.preflight
run = composite.run


def params(config: dict) -> dict[str, str]:
    payload = composite.params_for_interval(config, backed_session=True)
    payload["composite_scenario_name"] = name
    return payload
