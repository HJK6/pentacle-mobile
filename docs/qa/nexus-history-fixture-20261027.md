# History fixture repair

The standalone `nexus_agents_history_questions` scenario selects the repo-local scripted fixture. Its unchanged loader requires a chat-event anchor and agent-question schema/dedup/options metadata. The fixture follows the existing durable free-text fixture shape; explicit `response_mode=free_text`, child/history identity and all scenario assertions remain unchanged.

Fail-first regression: `python3 -m pytest test/e2e/tests/test_nexus_agents_history_fixture.py`. On public main `ca9e53ee1e62cfb7ad66008e9232122629bf90a1`, the selected fixture is rejected for empty frames (4 failed, 1 passed). The repair passes all 5 tests, including four malformed-input controls.

This ports the original three-file repair while retaining the public fixture's assistant role, synthetic labels, timestamps and `history-question` identity. The regression expects that public question ID; the new anchor uses the same public labels/date. No loader or scenario changes are required. Public evidence documentation omits execution-host names and absolute local paths.

Evidence is retained by the release coordinator under `agent-outputs/pentacle-ready-burndown-20261026/t5-r43-rebase/`:

- `pytest-red.log` SHA256 `deec64a6babcc7d32081200054255bddaf05d93d7e61896ca6d2ba5b45f16b92`.
- `pytest-green.log` SHA256 `2cdd40cd48ded58089ba52a0af041f6aa1a7205bc5044553680fd71b8d3e5977`.

This source-only fixture repair does not establish full native, live or phone acceptance. The original lane's native result and separate navigation-harness failure remain separately tracked; no additional native run is claimed. No production app, loader or accessibility behavior changes. Roll back by reverting this fixture/test change.
