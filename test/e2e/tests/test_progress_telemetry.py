from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProgressStore:
    root: Path
    run_id: str

    @property
    def path(self) -> Path:
        return self.root / f"{self.run_id}.json"

    def write(self, **values: object) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "run_id": self.run_id,
            "status": "running",
            "completed": 0,
            "total": 0,
            **values,
        }
        self.path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")

    def read(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8"))


def test_progress_snapshot_is_written_with_a_stable_schema(tmp_path: Path) -> None:
    store = ProgressStore(tmp_path, "run-1")
    store.write(status="passed", completed=2, total=2)
    assert store.read() == {
        "completed": 2,
        "run_id": "run-1",
        "schema_version": 1,
        "status": "passed",
        "total": 2,
    }


def test_later_snapshot_replaces_only_the_same_run(tmp_path: Path) -> None:
    first = ProgressStore(tmp_path, "run-1")
    second = ProgressStore(tmp_path, "run-2")
    first.write(status="running", completed=1, total=3)
    second.write(status="running", completed=0, total=1)
    first.write(status="passed", completed=3, total=3)
    assert first.read()["status"] == "passed"
    assert second.read()["completed"] == 0


def test_progress_snapshot_round_trips_as_json(tmp_path: Path) -> None:
    store = ProgressStore(tmp_path, "run-3")
    store.write(status="failed", completed=1, total=2, error="sample failure")
    assert json.loads(store.path.read_text(encoding="utf-8")) == store.read()
