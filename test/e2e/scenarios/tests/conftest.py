"""pytest config for test/e2e/scenarios/tests/.

Adds the e2e scenarios root to sys.path so tests can import the underscore
private helpers (_assertions, _run_state) directly.
"""
from __future__ import annotations

import sys
from pathlib import Path


# tests/  -> scenarios/  -> e2e/
SCENARIOS_DIR = Path(__file__).resolve().parents[1]
E2E_DIR = SCENARIOS_DIR.parent

for entry in (str(SCENARIOS_DIR), str(E2E_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)
