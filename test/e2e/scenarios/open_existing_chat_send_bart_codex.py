"""Example flow shim: hosta x Codex."""
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from .open_existing_chat_send import make_scenario

_scenario = make_scenario("hosta", "codex")
name = _scenario.name
actions = _scenario.actions
params = _scenario.params
preflight = _scenario.preflight
run = _scenario.run
