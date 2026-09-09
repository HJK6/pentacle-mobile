from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import open_existing_chat


name = "open_released_ux_fixture"
STREAM_ID = "hostc:example-claude-session"


def actions(config: dict) -> list[str]:
    del config
    return ["disable_pentacle_auth", "open_existing_chat"]


def params(config: dict) -> dict[str, str]:
    del config
    return {
        "host": "hostc",
        "provider": "claude",
        "stream_id": STREAM_ID,
        "stream_id_override": STREAM_ID,
    }


def preflight(config: dict, repo_root=None) -> str | None:
    return open_existing_chat.preflight(config, repo_root)


def run(config: dict, stream, cap=None):
    return open_existing_chat.run(config, stream, cap)

