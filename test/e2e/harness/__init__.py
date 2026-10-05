"""Reusable primitives for the public mobile end-to-end harness."""

import os
from pathlib import Path


def scenario_simctl_command(*args, config=None):
    """Use the exact device-set contract supplied by the native gate."""
    key = "PENTACLE_SCENARIO_DEVICE_SET_ROOT"
    values = os.environ if config is None else config
    root = values.get(key)
    if not isinstance(root, str) or not root or "\0" in root or not Path(root).is_absolute():
        raise ValueError(f"{key} must name the exact absolute simulator device set")
    bound = os.environ.get(key)
    if config is not None and bound is not None and root != bound:
        raise ValueError(f"{key} differs from the bound simulator device set")
    return ["xcrun", "simctl", "--set", root, *args]
