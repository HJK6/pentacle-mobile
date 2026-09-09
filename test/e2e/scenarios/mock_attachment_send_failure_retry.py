from __future__ import annotations

SCENARIO_META = {"target_compat": {"device", "simulator"}, "requires": []}

from . import mock_attachment_send_reconcile as base


name = "mock_attachment_send_failure_retry"


def actions(config: dict) -> list[str]:
    del config
    return ["autoaccept_biometric", "open_existing_chat", "send_fixture_image", "retry_failed_send"]


def params(config: dict) -> dict[str, str]:
    payload = base.params(config)
    fixture = "attachment_send_failure_retry.json"
    retry_payload = base.M.params_for_fixture(config, fixture)
    payload.update(retry_payload)
    payload.update(
        {
            "text": "caption from fixture",
            "image_name": "mock-attachment-send-failure-retry.png",
        }
    )
    return payload


def preflight(config: dict, repo_root=None) -> str | None:
    return base.preflight(config, repo_root)


def run(config: dict, stream, cap=None):
    return base.run_attachment_reconcile(name, config, stream, cap=cap, expect_failure_retry=True)
