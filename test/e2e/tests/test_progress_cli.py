from __future__ import annotations

import json


def build_report(run_id: str, scenarios: list[dict]) -> dict:
    counts = {key: 0 for key in ("passed", "failed", "skipped", "total")}
    for scenario in scenarios:
        status = scenario["status"]
        counts["total"] += 1
        if status == "PASS":
            counts["passed"] += 1
        elif status == "FAIL":
            counts["failed"] += 1
        elif status == "SKIPPED":
            counts["skipped"] += 1
    return {
        "schema_version": 1,
        "run_id": run_id,
        "scenarios": scenarios,
        "summary": counts,
        "exit_code": 0 if counts["failed"] == 0 else 1,
    }


def test_report_is_deterministic_json() -> None:
    report = build_report("run-1", [
        {"name": "sample-one", "status": "PASS"},
        {"name": "sample-two", "status": "SKIPPED"},
    ])
    encoded = json.dumps(report, sort_keys=True)
    assert json.loads(encoded) == report
    assert report["summary"] == {"passed": 1, "failed": 0, "skipped": 1, "total": 2}
    assert report["exit_code"] == 0


def test_a_failed_scenario_sets_a_nonzero_exit_code() -> None:
    report = build_report("run-2", [{"name": "sample", "status": "FAIL"}])
    assert report["summary"]["failed"] == 1
    assert report["exit_code"] == 1


def test_empty_plan_is_a_successful_empty_report() -> None:
    report = build_report("run-3", [])
    assert report["summary"] == {"passed": 0, "failed": 0, "skipped": 0, "total": 0}
    assert report["exit_code"] == 0
