"""Example flow shim: hosta (Codex implicit)."""
SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from .disconnect_after_send import make_scenario

_scenario = make_scenario("hosta")
name = _scenario.name
actions = _scenario.actions
params = _scenario.params
preflight = _scenario.preflight
run = _scenario.run
