from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import mock_attachment_send_reconcile as base


name = "mock_attachment_photo_only_reconcile"


def actions(config: dict) -> list[str]:
    return base.actions(config)


def params(config: dict) -> dict[str, str]:
    payload = base.params(config)
    payload.update(
        {
            "text": "",
            "image_name": "mock-attachment-photo-only.png",
        }
    )
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return base.preflight(config, repo_root)


def run(config: dict, stream, cap=None):
    return base.run_attachment_reconcile(name, config, stream, cap=cap)
