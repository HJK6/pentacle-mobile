from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StartupEvidence:
    package_present: bool
    launched: bool
    ready: bool
    event_count: int


def cause_chain(evidence: StartupEvidence) -> dict[str, object]:
    return {
        "package": "present" if evidence.package_present else "missing",
        "launch": "observed" if evidence.launched else "not_observed",
        "ready": "observed" if evidence.ready else "not_observed",
        "events": evidence.event_count,
        "verdict": (
            "PASS"
            if evidence.package_present and evidence.launched and evidence.ready
            else "FAIL"
        ),
    }


def test_missing_package_is_distinguished_from_a_late_start() -> None:
    result = cause_chain(StartupEvidence(False, False, False, 0))
    assert result == {
        "package": "missing",
        "launch": "not_observed",
        "ready": "not_observed",
        "events": 0,
        "verdict": "FAIL",
    }


def test_a_started_but_not_ready_application_reports_each_link() -> None:
    result = cause_chain(StartupEvidence(True, True, False, 2))
    assert result["package"] == "present"
    assert result["launch"] == "observed"
    assert result["ready"] == "not_observed"
    assert result["events"] == 2
    assert result["verdict"] == "FAIL"


def test_complete_startup_chain_passes() -> None:
    assert cause_chain(StartupEvidence(True, True, True, 3))["verdict"] == "PASS"
