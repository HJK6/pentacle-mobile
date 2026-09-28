from __future__ import annotations


import fcntl


import json


import os


import signal


import stat


import subprocess


import sys


import threading


import time


from contextlib import ExitStack


from pathlib import Path


import pytest


from e2e import progress_telemetry as telemetry


from e2e import rev10_contract_matrix as contract_matrix


class FakeClock:
    def __init__(self) -> None:
        self.wall = 1_752_710_400.0
        self.mono = 100.0

    def wall_time(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return self.mono

    def advance(self, seconds: float) -> None:
        self.wall += seconds
        self.mono += seconds


def _mutated_stat(info: os.stat_result, field: str, *, max_size: int = 65536) -> os.stat_result:
    values = list(info)
    if field == "type":
        values[stat.ST_MODE] = stat.S_IFDIR | stat.S_IMODE(info.st_mode)
    elif field == "owner":
        values[stat.ST_UID] = os.geteuid() + 1
    elif field == "mode":
        values[stat.ST_MODE] = stat.S_IFMT(info.st_mode) | 0o644
    elif field == "size":
        values[stat.ST_SIZE] = max_size + 1
    elif field == "link":
        values[stat.ST_NLINK] = 2
    else:
        raise AssertionError(field)
    return os.stat_result(values)


def _snapshot(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": 1,
        "run_id": "run-1",
        "suite": "all-flows",
        "phase": "running",
        "status": "running",
        "started_at": "2025-07-16T00:00:00.000Z",
        "updated_at": "2025-07-16T00:00:01.000Z",
        "heartbeat_at": "2025-07-16T00:00:01.000Z",
        "elapsed_ms": 1000,
        "sequence": 2,
        "completed": 0,
        "total": 1,
        "percent_complete": 0,
        "current_scenario": "scenario-1",
        "current_scenario_started_at": "2025-07-16T00:00:01.000Z",
        "pass": 0,
        "fail": 0,
        "setup_fail": 0,
        "skipped": 0,
        "waived": 0,
        "source_commit": "9327ba2",
        "app_sha256": None,
        "host": "samplehost",
        "simulator_ownership": "none",
        "exit_code": None,
        "interruption_reason": "none",
        "telemetry_error_code": "none",
        "estimated_ms_remaining": None,
    }
    value.update(changes)
    return value


def _ticket(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": 1,
        "run_id": "run-1",
        "owner_pid": os.getpid(),
        "repo": "pentacle-mobile",
        "sha": "9327ba2",
        "host": "samplehost",
        "stage": "sim-e2e",
        "suite": "all-flows",
        "started_at": "2025-07-16T00:00:00.000Z",
        "progress_file": "progress/run-1.json",
    }
    value.update(changes)
    return value


def test_rev10_generated_contract_matrix_is_total() -> None:
    resolutions = [contract_matrix.resolve(cell) for cell in contract_matrix.iter_cells()]
    counts = contract_matrix.summary()
    assert counts["total"] == (
        len(contract_matrix.WRITER_SEAMS)
        * len(contract_matrix.BARRIER_TYPES)
        * len(contract_matrix.TERMINAL_STATES)
        * len(contract_matrix.PARITY_DIMENSIONS)
        * len(contract_matrix.METADATA_FIELDS)
    )
    assert counts["mapped"] + counts["excluded"] == counts["total"]
    assert all(resolution.test_name or resolution.exclusion for resolution in resolutions)
    assert {resolution.test_name for resolution in resolutions if resolution.test_name} == {
        "test_generated_public_terminal_matrix",
        "test_reader_post_observation_metadata_refresh_matrix",
        "test_snapshot_temp_directory_metadata_race_matrix",
        "test_stable_registry_object_metadata_boundary_matrix",
        "test_ticket_canonical_schema_generated_matrix",
        "test_ticket_publication_failure_rollback_generated_matrix",
        "test_writer_parent_boundary_generated_matrix",
    }


# Coordinator parity belongs to the retained private all_flows runner.
# These public witnesses exercise only the explicit-input helper seams.
_REV10_CONTRACT_CASES = [case for case in contract_matrix.mapped_cases()
                         if case.probe_plan.name != "test_generated_public_terminal_matrix"]


@pytest.mark.parametrize(
    "contract_case",
    _REV10_CONTRACT_CASES,
    ids=lambda case: case.pytest_id,
)
def test_rev10_contract_cell_witness(
    contract_case: contract_matrix.MappedCase,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert contract_matrix.cell_from_pytest_id(contract_case.pytest_id) == contract_case.cell
    assert contract_matrix.resolve(contract_case.cell) == contract_case.resolution
    plan = contract_case.probe_plan
    assert plan.cell == contract_case.cell
    assert plan.name == contract_case.resolution.test_name
    assert plan.probe_points
    if plan.name == "test_ticket_canonical_schema_generated_matrix":
        _probe_ticket_canonical_schema(plan)
    elif plan.name == "test_snapshot_temp_directory_metadata_race_matrix":
        _probe_snapshot_temp_directory_metadata_race(plan, tmp_path, monkeypatch)
    elif plan.name == "test_writer_parent_boundary_generated_matrix":
        _probe_writer_parent_boundary(plan, tmp_path, monkeypatch)
    elif plan.name == "test_reader_post_observation_metadata_refresh_matrix":
        _probe_reader_post_observation_metadata_refresh(plan, tmp_path, monkeypatch)
    elif plan.name == "test_ticket_publication_failure_rollback_generated_matrix":
        _probe_ticket_publication_failure_rollback(plan, tmp_path)
    elif plan.name == "test_stable_registry_object_metadata_boundary_matrix":
        _probe_stable_registry_object_metadata_boundary(plan, tmp_path)
    else:
        raise AssertionError(f"unhandled rev10 runtime probe: {plan.name}")


def test_public_contract_subset_has_unique_helper_witnesses() -> None:
    assert len(_REV10_CONTRACT_CASES) == 170
    assert len({case.pytest_id for case in _REV10_CONTRACT_CASES}) == 170
    assert all(case.probe_plan.name != "test_generated_public_terminal_matrix"
               for case in _REV10_CONTRACT_CASES)
    assert contract_matrix.summary() == {"total": 136080, "mapped": 268, "excluded": 135812}


def test_rev10_contract_probe_expansions_are_engine_owned() -> None:
    plans = [case.probe_plan for case in _REV10_CONTRACT_CASES]
    stable = [plan for plan in plans if plan.name == "test_stable_registry_object_metadata_boundary_matrix"]
    canonical = [plan for plan in plans if plan.name == "test_ticket_canonical_schema_generated_matrix"]
    rollback = [plan for plan in plans if plan.name == "test_ticket_publication_failure_rollback_generated_matrix"]
    assert sum(len(plan.probe_points) for plan in stable) == 40
    assert canonical[0].probe_points == contract_matrix.TICKET_CANONICAL_PROBES
    assert rollback[0].probe_points == contract_matrix.TICKET_PUBLICATION_PROBES


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("a", True),
        ("A_1.x-y", True),
        ("", False),
        ("-bad", False),
        ("a/b", False),
        ("a" * 80, True),
        ("a" * 81, False),
    ],
)
def test_safe_id_grammar(value: str, valid: bool) -> None:
    assert telemetry.is_safe_id(value) is valid


def test_canonical_json_is_byte_exact_and_rejects_duplicate_keys() -> None:
    value = {"b": 2, "a": "é"}
    assert telemetry.canonical_bytes(value) == b'{"a":"\xc3\xa9","b":2}\n'
    assert telemetry.decode_canonical(telemetry.canonical_bytes(value), max_bytes=100) == value
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.decode_canonical(b'{"a":1,"a":2}\n', max_bytes=100)
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.decode_canonical(b'{ "a":1}\n', max_bytes=100)


def _probe_ticket_canonical_schema(plan: contract_matrix.ProbePlan) -> None:
    for case in plan.probe_points:
        value = _ticket()
        payload = telemetry.canonical_bytes(value)
        if case == "round_trip":
            assert telemetry.validate_ticket(telemetry.decode_canonical(payload, max_bytes=4096)) == value
            continue
        if case == "duplicate":
            payload = payload[:-2] + b',"run_id":"run-1"}\n'
        elif case == "unknown":
            value["unknown"] = "value"
            payload = telemetry.canonical_bytes(value)
        elif case == "missing":
            value.pop("host")
            payload = telemetry.canonical_bytes(value)
        elif case == "wrong_type":
            value["owner_pid"] = True
            payload = telemetry.canonical_bytes(value)
        elif case == "whitespace":
            payload = b" " + payload
        elif case == "order":
            payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
            assert payload != telemetry.canonical_bytes(value)
        elif case == "encoding":
            payload = b"{\xff}\n"
        else:
            value["progress_file"] = "../run-1.json"
            payload = telemetry.canonical_bytes(value)
        with pytest.raises(telemetry.TelemetryFailure):
            telemetry.validate_ticket(telemetry.decode_canonical(payload, max_bytes=4096))


@pytest.mark.parametrize(
    ("completed", "total", "terminal_success", "expected"),
    [
        (0, 0, False, 0),
        (0, 0, True, 100),
        (1, 3, False, 33.33),
        (2, 3, False, 66.67),
        (1, 8, False, 12.5),
        (1, 200, False, 0.5),
    ],
)
def test_percentage_is_exact_half_up(
    completed: int, total: int, terminal_success: bool, expected: int | float
) -> None:
    assert telemetry.percent_complete(completed, total, terminal_success) == expected


def test_snapshot_schema_rejects_unknown_boolean_numeric_and_cross_field_errors() -> None:
    telemetry.validate_snapshot(_snapshot())
    bad = _snapshot(extra="secret")
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(bad)
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(_snapshot(completed=True))
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(_snapshot(completed=1, **{"pass": 0}))
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(_snapshot(current_scenario=None))
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(_snapshot(percent_complete=0.0))
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.validate_snapshot(_snapshot(current_scenario="unsafe\u202e", current_scenario_started_at=_snapshot()["current_scenario_started_at"]))


def test_atomic_writer_publishes_mode_0600_and_cleans_private_temp(tmp_path: Path) -> None:
    destination = tmp_path / "progress" / "run-1.json"
    destination.parent.mkdir()
    with telemetry.AtomicProgressWriter(destination) as writer:
        writer.publish(_snapshot(sequence=1))
        parsed = telemetry.read_progress(progress_file=destination)
        assert parsed["sequence"] == 1
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
        assert stat.S_IMODE(writer.temp_dir_path.stat().st_mode) == 0o700
        assert list(writer.temp_dir_path.iterdir()) == []


def test_atomic_writer_lock_contention_fails_before_publish(tmp_path: Path) -> None:
    destination = tmp_path / "run.json"
    with telemetry.AtomicProgressWriter(destination):
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            with telemetry.AtomicProgressWriter(destination):
                pass
    assert raised.value.code == "lock_contended"
    assert not destination.exists()


@pytest.mark.parametrize("unsafe", ["symlink", "world_writable", "group_writable"])
def test_secure_tree_rejects_unsafe_destination_parent(tmp_path: Path, unsafe: str) -> None:
    parent = tmp_path / "parent"
    parent.mkdir()
    destination = parent / "run.json"
    if unsafe == "symlink":
        real = tmp_path / "real"
        real.mkdir()
        parent.rmdir()
        parent.symlink_to(real, target_is_directory=True)
    else:
        parent.chmod(0o707 if unsafe == "world_writable" else 0o770)
    with pytest.raises(telemetry.TelemetryFailure) as raised:
        telemetry.AtomicProgressWriter(destination)
    assert raised.value.code == "unsafe_path"


def test_secure_tree_accepts_sticky_world_writable_ancestor(tmp_path: Path) -> None:
    # A world-writable ANCESTOR is acceptable when sticky (like /tmp, mode 1777):
    # the sticky bit forbids other users renaming/deleting our files. The leaf the
    # writer creates stays strict (0o700), so integrity holds.
    ancestor = tmp_path / "sticky"
    ancestor.mkdir()
    ancestor.chmod(0o1777)
    destination = ancestor / "progress" / "run.json"
    with telemetry.AtomicProgressWriter(destination) as writer:  # must NOT raise unsafe_path
        writer.publish(_snapshot(sequence=1))
        assert telemetry.read_progress(progress_file=destination)["sequence"] == 1


def test_secure_tree_still_rejects_nonsticky_world_writable_ancestor(tmp_path: Path) -> None:
    ancestor = tmp_path / "open"
    ancestor.mkdir()
    ancestor.chmod(0o0777)  # world-writable but NOT sticky
    with pytest.raises(telemetry.TelemetryFailure) as raised:
        telemetry.AtomicProgressWriter(ancestor / "progress" / "run.json")
    assert raised.value.code == "unsafe_path"


def test_secure_tree_rejects_syncthing_root(tmp_path: Path) -> None:
    synced = tmp_path / "synced"
    synced.mkdir()
    (synced / ".stfolder").mkdir()
    with pytest.raises(telemetry.TelemetryFailure) as raised:
        telemetry.AtomicProgressWriter(synced / "progress" / "run.json")
    assert raised.value.code == "unsafe_path"


@pytest.mark.parametrize("point", ["after_snapshot_temp_fsync", "before_snapshot_rename"])
def test_pre_rename_failure_matrix_preserves_predecessor(tmp_path: Path, point: str) -> None:
    destination = tmp_path / "run.json"
    fail = {"armed": False}

    def injector(current: str) -> None:
        if fail["armed"] and point == current:
            raise OSError("secret raw failure")

    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        writer.publish(_snapshot(sequence=1))
        fail["armed"] = True
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=2))
        assert raised.value.code == "write_failed"
        assert telemetry.read_progress(progress_file=destination)["sequence"] == 1


@pytest.mark.parametrize(
    "point", ["after_snapshot_rename", "after_temp_dir_fsync", "after_destination_dir_fsync"],
)
def test_post_rename_failure_matrix_retains_visible_sequence_and_latches(
    tmp_path: Path, point: str
) -> None:
    destination = tmp_path / "run.json"
    fail = {"armed": False}

    def injector(current: str) -> None:
        if fail["armed"] and current == point:
            raise OSError("/secret/token")

    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        writer.publish(_snapshot(sequence=1))
        fail["armed"] = True
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=2))
        assert raised.value.post_rename is True
        assert telemetry.read_progress(progress_file=destination)["sequence"] == 2
        with pytest.raises(telemetry.TelemetryFailure):
            writer.publish(_snapshot(sequence=3))


@pytest.mark.parametrize(
    "point", ["after_snapshot_rename", "after_temp_dir_fsync", "after_destination_dir_fsync"],
)
def test_reader_observes_each_visibility_and_durability_boundary(
    tmp_path: Path, point: str
) -> None:
    destination = tmp_path / "run.json"
    observed: list[int] = []

    def injector(current: str) -> None:
        if current == point:
            observed.append(int(telemetry.read_progress(progress_file=destination)["sequence"]))

    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        writer.publish(_snapshot(sequence=1))
    assert observed == [1]


WRITER_BOUNDARIES = list(contract_matrix.WRITER_SEAMS[:-1])


def _probe_snapshot_temp_directory_metadata_race(
    plan: contract_matrix.ProbePlan,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    point = plan.probe_points[0]
    mutation = plan.cell.metadata_field
    destination = tmp_path / "run.json"
    detached: Path | None = None
    owner_mutated = False
    original_fstat = telemetry.os.fstat

    def wrapped_fstat(fd: int) -> os.stat_result:
        info = original_fstat(fd)
        if owner_mutated and fd == writer.temp_fd:
            return _mutated_stat(info, "owner")
        return info

    monkeypatch.setattr(telemetry.os, "fstat", wrapped_fstat)

    def injector(current: str) -> None:
        nonlocal detached, owner_mutated
        if current == point:
            if mutation == "mode":
                writer.temp_dir_path.chmod(0o777)
            elif mutation == "type":
                detached = writer.temp_dir_path.with_name(f"{writer.temp_dir_path.name}.detached")
                writer.temp_dir_path.rename(detached)
                writer.temp_dir_path.write_bytes(b"replacement")
            else:
                owner_mutated = True

    writer = telemetry.AtomicProgressWriter(destination, fault_injector=injector)
    try:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=1))
        assert raised.value.post_rename is (WRITER_BOUNDARIES.index(point) >= WRITER_BOUNDARIES.index("after_snapshot_rename"))
    finally:
        writer.close()
        if detached is not None:
            writer.temp_dir_path.unlink()
            detached.rename(writer.temp_dir_path)
        elif mutation == "mode":
            writer.temp_dir_path.chmod(0o700)


def _probe_writer_parent_boundary(
    plan: contract_matrix.ProbePlan,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    point = plan.probe_points[0]
    relative = plan.cell.barrier_type == "destination_parent_relative"
    mutation = plan.cell.metadata_field
    parity = plan.cell.parity
    caller = tmp_path / "caller"
    parent = caller / "tree" / "parent"
    parent.mkdir(parents=True)
    retained = caller / "retained-tree"
    replacement = caller / "tree" / "parent"
    anchor_fd = os.open(caller, os.O_RDONLY | os.O_DIRECTORY)
    destination: Path | str = "tree/parent/run.json" if relative else parent / "run.json"
    swapped = False
    owner_mutated = False
    original_stat = telemetry.os.stat
    parent_identity = original_stat(parent)

    def wrapped_stat(path: object, *args: object, **kwargs: object) -> os.stat_result:
        info = original_stat(path, *args, **kwargs)
        if owner_mutated and (info.st_dev, info.st_ino) == (parent_identity.st_dev, parent_identity.st_ino):
            return _mutated_stat(info, "owner")
        return info

    monkeypatch.setattr(telemetry.os, "stat", wrapped_stat)

    def injector(current: str) -> None:
        nonlocal swapped, owner_mutated
        if not swapped and current == point:
            swapped = True
            if mutation in {"type", "chain"}:
                (caller / "tree").rename(retained)
                replacement.mkdir(parents=True)
            elif mutation == "mode":
                parent.chmod(0o777)
            else:
                owner_mutated = True

    writer = telemetry.AtomicProgressWriter(
        destination,
        anchor_fd=anchor_fd if relative else None,
        anchor_display=caller if relative else None,
        fault_injector=injector,
    )
    try:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=1))
        post_rename = WRITER_BOUNDARIES.index(point) >= WRITER_BOUNDARIES.index("after_snapshot_rename")
        assert raised.value.post_rename is post_rename
        if parity == "visible_sequence":
            assert mutation == "chain"
            assert not (replacement / "run.json").exists()
            retained_snapshot = retained / "parent" / "run.json"
            assert retained_snapshot.exists() is post_rename
        elif parity == "fail_closed" and mutation in {"type", "chain"}:
            assert not (replacement / "run.json").exists()
        elif parity == "fail_closed":
            assert (parent / "run.json").exists() is post_rename
        else:
            raise AssertionError(f"unhandled writer-parent parity: {parity}")
    finally:
        writer.close()
        os.close(anchor_fd)
        if mutation == "mode":
            parent.chmod(0o700)


def test_orphan_snapshot_temp_cleanup_is_bounded_and_inode_matched(tmp_path: Path) -> None:
    destination = tmp_path / "run.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        orphan = writer.temp_dir_path / f"{os.getpid()}.1.{'a' * 32}.snapshot.tmp"
        orphan.write_bytes(telemetry.canonical_bytes(_snapshot(sequence=1)))
        orphan.chmod(0o600)
    unrelated = destination.parent / "unrelated"
    unrelated.write_text("keep", encoding="utf-8")
    with telemetry.AtomicProgressWriter(destination) as next_writer:
        assert not orphan.exists()
        assert unrelated.read_text(encoding="utf-8") == "keep"
        assert list(next_writer.temp_dir_path.iterdir()) == []


def test_unknown_snapshot_temp_fails_closed_without_deleting(tmp_path: Path) -> None:
    destination = tmp_path / "run.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        unknown = writer.temp_dir_path / "unknown"
        unknown.write_text("keep", encoding="utf-8")
    with pytest.raises(telemetry.TelemetryFailure):
        telemetry.AtomicProgressWriter(destination)
    assert unknown.read_text(encoding="utf-8") == "keep"


def test_writer_rejects_existing_symlink_without_mutating_target(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_text("keep", encoding="utf-8")
    destination = tmp_path / "run.json"
    destination.symlink_to(target)
    with telemetry.AtomicProgressWriter(destination) as writer:
        with pytest.raises(telemetry.TelemetryFailure):
            writer.publish(_snapshot(sequence=1))
    assert destination.is_symlink()
    assert target.read_text(encoding="utf-8") == "keep"


def test_progress_coordinator_orders_main_and_heartbeat_updates(tmp_path: Path) -> None:
    clock = FakeClock()
    destination = tmp_path / "run.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer,
            run_id="run-1",
            total=2,
            source_commit="9327ba2",
            app_sha256=None,
            host="samplehost",
            simulator_ownership="none",
            wall_clock=clock.wall_time,
            monotonic_clock=clock.monotonic,
        )
        first = coordinator.emit_initial()
        assert first["sequence"] == 1 and first["completed"] == 0
        coordinator.set_phase("preflight")
        clock.advance(1)
        coordinator.scenario_started("one")
        barrier = threading.Barrier(3)

        def heartbeat() -> None:
            barrier.wait()
            coordinator.heartbeat()

        def complete() -> None:
            barrier.wait()
            coordinator.scenario_completed("PASS")

        left = threading.Thread(target=heartbeat)
        right = threading.Thread(target=complete)
        left.start(); right.start(); barrier.wait(); left.join(); right.join()
        current = telemetry.read_progress(progress_file=destination)
        assert current["sequence"] == 5
        assert current["completed"] == 1
    assert current["pass"] == 1


@pytest.mark.parametrize(
    "emission",
    [
        "initial", "phase", "provenance", "scenario_started",
        "complete_PASS", "complete_FAIL", "complete_SETUP_FAIL", "complete_SKIPPED", "complete_WAIVED",
        "teardown", "terminal_pass", "terminal_fail", "terminal_sigint", "terminal_sigterm",
        "terminal_error",
    ],
)
def test_heartbeat_collision_serializes_every_main_emission(
    tmp_path: Path, emission: str
) -> None:
    entered = threading.Event()
    release = threading.Event()
    armed = False

    def injector(point: str) -> None:
        if armed and point == "after_snapshot_temp_fsync" and threading.current_thread().name == "main-emission":
            entered.set()
            assert release.wait(2)

    with telemetry.AtomicProgressWriter(tmp_path / f"{emission}.json", fault_injector=injector) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
        )
        if emission != "initial":
            coordinator.emit_initial()
        if emission.startswith("complete_"):
            coordinator.scenario_started("scenario")
        armed = True

        def main_emit() -> None:
            actions = {
                "initial": coordinator.emit_initial,
                "phase": lambda: coordinator.set_phase("preflight"),
                "provenance": lambda: coordinator.set_provenance(app_sha256="a" * 64),
                "scenario_started": lambda: coordinator.scenario_started("scenario"),
                "complete_PASS": lambda: coordinator.scenario_completed("PASS"),
                "complete_FAIL": lambda: coordinator.scenario_completed("FAIL"),
                "complete_SETUP_FAIL": lambda: coordinator.scenario_completed("SETUP_FAIL"),
                "complete_SKIPPED": lambda: coordinator.scenario_completed("SKIPPED"),
                "complete_WAIVED": lambda: coordinator.scenario_completed("WAIVED"),
                "teardown": lambda: coordinator.set_phase("teardown"),
                "terminal_pass": lambda: coordinator.terminal("passed", 0),
                "terminal_fail": lambda: coordinator.terminal("failed", 1),
                "terminal_sigint": lambda: coordinator.terminal("interrupted", 130, interruption_reason="sigint"),
                "terminal_sigterm": lambda: coordinator.terminal("interrupted", 143, interruption_reason="sigterm"),
                "terminal_error": lambda: coordinator.terminal_telemetry_error("write_failed"),
            }
            actions[emission]()

        main_failures: list[BaseException] = []
        heartbeat_failures: list[BaseException] = []

        def capture(call: object, failures: list[BaseException]) -> None:
            try:
                assert callable(call)
                call()
            except BaseException as exc:  # noqa: BLE001
                failures.append(exc)

        main = threading.Thread(target=capture, args=(main_emit, main_failures), name="main-emission")
        main.start()
        assert entered.wait(2)
        heartbeat = threading.Thread(
            target=capture, args=(coordinator.heartbeat, heartbeat_failures), name="colliding-heartbeat",
        )
        heartbeat.start()
        time.sleep(0.01)
        assert heartbeat.is_alive()
        release.set()
        main.join(2); heartbeat.join(2)
        assert not main.is_alive() and not heartbeat.is_alive() and main_failures == []
        terminal = emission.startswith("terminal_")
        assert (len(heartbeat_failures) == 1) is terminal
        snapshot = telemetry.read_progress(progress_file=tmp_path / f"{emission}.json")
        if emission == "phase":
            assert snapshot["phase"] == "preflight"
        elif emission == "provenance":
            assert snapshot["app_sha256"] == "a" * 64
        elif emission == "scenario_started":
            assert snapshot["current_scenario"] == "scenario"
        elif emission.startswith("complete_"):
            field = {
                "PASS": "pass", "FAIL": "fail", "SETUP_FAIL": "setup_fail",
                "SKIPPED": "skipped", "WAIVED": "waived",
            }[emission.removeprefix("complete_")]
            assert snapshot["completed"] == snapshot[field] == 1
        elif emission == "teardown":
            assert snapshot["phase"] == "teardown"
        elif terminal:
            assert snapshot["phase"] == "terminal" and snapshot["status"] != "running"
        else:
            assert snapshot["phase"] == "initializing" and snapshot["sequence"] == 2


def test_fake_clock_heartbeat_timestamp_and_reader_age_tolerance(tmp_path: Path) -> None:
    clock = FakeClock()
    destination = tmp_path / "age.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
            wall_clock=clock.wall_time, monotonic_clock=clock.monotonic,
        )
        initial = coordinator.emit_initial()
        clock.advance(14.4)
        heartbeat = coordinator.heartbeat()
    read = telemetry.read_progress(progress_file=destination)
    assert heartbeat["sequence"] == initial["sequence"] + 1 and heartbeat["completed"] == 0
    observed = telemetry._parse_utc_ms(read["heartbeat_at"]).timestamp()
    assert abs(clock.wall_time() - observed) <= 1.0


def test_fake_long_child_exposes_heartbeat_without_completion_movement(tmp_path: Path) -> None:
    destination = tmp_path / "heartbeat.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
        )
        coordinator.emit_initial()
        coordinator.scenario_started("long-child")
        publisher = telemetry.HeartbeatPublisher(coordinator, interval=0.01)
        publisher.start()
        deadline = time.monotonic() + 1
        observed = None
        while time.monotonic() < deadline:
            candidate = telemetry.read_progress(progress_file=destination)
            if candidate["sequence"] >= 3:
                observed = candidate
                break
        publisher.stop()
        assert observed is not None
        assert observed["completed"] == 0 and observed["current_scenario"] == "long-child"


def test_heartbeat_failure_hands_off_to_main_and_allows_one_terminal_error_attempt(tmp_path: Path) -> None:
    armed = {"value": False}

    def injector(point: str) -> None:
        if armed["value"] and point == "before_snapshot_rename":
            armed["value"] = False
            raise OSError("secret heartbeat failure")

    abort = threading.Event()
    destination = tmp_path / "heartbeat-failure.json"
    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
        )
        coordinator.emit_initial()
        coordinator.scenario_started("long-child")
        armed["value"] = True
        publisher = telemetry.HeartbeatPublisher(coordinator, interval=0.01, abort_event=abort)
        publisher.start()
        assert abort.wait(1.0)
        publisher.stop()
        terminal = coordinator.terminal_telemetry_error("write_failed")
        assert terminal is not None
        assert terminal["status"] == "telemetry_error" and terminal["exit_code"] == 74
        assert terminal["completed"] == terminal["total"] == 1


@pytest.mark.parametrize("failure_point", ["pre", "post"])
def test_terminal_error_attempt_failure_disposition_matrix(
    tmp_path: Path, failure_point: str
) -> None:
    armed = False
    failures = 0

    def injector(point: str) -> None:
        nonlocal failures
        wanted = "before_snapshot_rename" if failure_point == "pre" else "after_snapshot_rename"
        if armed and point == wanted:
            failures += 1
            raise OSError("secret")

    destination = tmp_path / f"terminal-error-{failure_point}.json"
    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
        )
        initial = coordinator.emit_initial()
        armed = True
        with pytest.raises(telemetry.TelemetryFailure):
            coordinator.heartbeat()
        terminal = coordinator.terminal_telemetry_error("write_failed")
        assert terminal is None
    visible = telemetry.read_progress(progress_file=destination)
    assert visible["sequence"] == initial["sequence"] + (1 if failure_point == "post" else 0)
    assert failures == (1 if failure_point == "post" else 2)


@pytest.mark.parametrize(
    ("verdict", "field"),
    [("PASS", "pass"), ("FAIL", "fail"), ("SETUP_FAIL", "setup_fail"), ("SKIPPED", "skipped"), ("WAIVED", "waived")],
)
def test_each_terminal_result_advances_exactly_once(
    tmp_path: Path, verdict: str, field: str
) -> None:
    clock = FakeClock()
    with telemetry.AtomicProgressWriter(tmp_path / f"{field}.json") as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=1, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
            wall_clock=clock.wall_time, monotonic_clock=clock.monotonic,
        )
        coordinator.emit_initial()
        coordinator.scenario_started("scenario")
        value = coordinator.scenario_completed(verdict)
        assert value["completed"] == 1
        assert value[field] == 1
        assert sum(value[name] for name in ("pass", "fail", "setup_fail", "skipped", "waived")) == 1


@pytest.mark.parametrize(
    ("status", "exit_code", "reason"),
    [("passed", 0, "none"), ("failed", 1, "none"), ("interrupted", 130, "sigint"), ("interrupted", 143, "sigterm")],
)
def test_terminal_snapshot_contract(
    tmp_path: Path, status: str, exit_code: int, reason: str
) -> None:
    clock = FakeClock()
    with telemetry.AtomicProgressWriter(tmp_path / f"{exit_code}.json") as writer:
        coordinator = telemetry.ProgressCoordinator(
            writer, run_id="run-1", total=0, source_commit="9327ba2",
            app_sha256=None, host="samplehost", simulator_ownership="none",
            wall_clock=clock.wall_time, monotonic_clock=clock.monotonic,
        )
        coordinator.emit_initial()
        terminal = coordinator.terminal(status, exit_code, interruption_reason=reason)
        assert terminal["phase"] == "terminal"
        assert terminal["percent_complete"] == (100 if status == "passed" else 0)
        with pytest.raises(telemetry.TelemetryFailure):
            coordinator.heartbeat()


def test_registry_advertises_only_live_owner_and_dead_ticket_is_ignored(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    progress = runs / "progress" / "run-1.json"
    with telemetry.TelemetryRun(
        progress_file=progress,
        runs_dir=runs,
        run_id="run-1",
        advertised=True,
        source_commit="9327ba2",
        host="samplehost",
        total=0,
    ) as run:
        run.coordinator.emit_initial()
        live = telemetry.read_active_runs(runs)
        assert live["ignored_dead"] == 0
        assert live["active_runs"][0]["run"]["run_id"] == "run-1"
    dead = telemetry.read_active_runs(runs)
    assert dead == {"schema_version": 1, "active_runs": [], "ignored_dead": 0}


def test_sigkill_owner_becomes_dead_and_next_writer_reaps_ticket(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    helper = (
        "import sys,time; from pathlib import Path; "
        "from progress_telemetry import TelemetryRun; "
        "r=TelemetryRun(progress_file=Path(sys.argv[1])/\'progress\'/\'run-1.json\',"
        "runs_dir=Path(sys.argv[1]),run_id=\'run-1\',advertised=True,"
        "source_commit=\'9327ba2\',host=\'merlin\',total=0); "
        "r.__enter__(); r.coordinator.emit_initial(); print(\'READY\',flush=True); time.sleep(60)"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", helper, str(runs)],
        stdout=subprocess.PIPE, text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
    )
    assert proc.stdout is not None and proc.stdout.readline().strip() == "READY"
    ticket_path = runs / "progress" / "active" / "run-1.json"
    dead_inode = ticket_path.stat().st_ino
    os.kill(proc.pid, signal.SIGKILL)
    proc.wait(timeout=5)
    dead = telemetry.read_active_runs(runs)
    assert dead["ignored_dead"] == 1 and dead["active_runs"] == []
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2",
        host="samplehost", total=0,
    ) as run:
        run.coordinator.emit_initial()
        assert ticket_path.stat().st_ino != dead_inode


def test_registry_split_lock_state_fails_closed_without_mutation(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as run:
        run.coordinator.emit_initial()
        os.close(run.ticket_fd)
        run.ticket_fd = -1
        ticket = runs / "progress" / "active" / "run-1.json"
        before = ticket.read_bytes()
        with pytest.raises(telemetry.ReaderFailure):
            telemetry.read_active_runs(runs)
        assert ticket.read_bytes() == before


def test_registry_opposite_split_lock_state_fails_closed_without_mutation(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as run:
        run.coordinator.emit_initial()
        assert run.writer is not None
        os.close(run.writer.lock_fd)
        run.writer.lock_fd = -1
        ticket = runs / "progress" / "active" / "run-1.json"
        before = ticket.read_bytes()
        with pytest.raises(telemetry.ReaderFailure):
            telemetry.read_active_runs(runs)
        assert ticket.read_bytes() == before


def test_normal_cleanup_never_unlinks_replaced_ticket_inode(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    ticket = runs / "progress" / "active" / "run-1.json"
    replacement = b"replacement\n"
    with pytest.raises(telemetry.TelemetryFailure):
        with telemetry.TelemetryRun(
            progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
            run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        ) as run:
            run.coordinator.emit_initial()
            ticket.rename(ticket.with_suffix(".detached"))
            ticket.write_bytes(replacement)
            ticket.chmod(0o600)
    assert ticket.read_bytes() == replacement


def test_registry_duplicate_live_run_id_is_rejected(tmp_path: Path) -> None:
    before = len(os.listdir("/dev/fd"))
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "same.json", runs_dir=runs,
        run_id="same", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as first:
        first.coordinator.emit_initial()
        duplicate = telemetry.TelemetryRun(
            progress_file=runs / "progress" / "same.json", runs_dir=runs,
            run_id="same", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        )
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            duplicate.__enter__()
        assert raised.value.code == "registry_conflict"
    assert len(os.listdir("/dev/fd")) == before


def test_registry_enforces_sixteen_live_run_bound_and_order(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with ExitStack() as stack:
        for index in range(16):
            run_id = f"run-{index:02d}"
            run = stack.enter_context(telemetry.TelemetryRun(
                progress_file=runs / "progress" / f"{run_id}.json", runs_dir=runs,
                run_id=run_id, advertised=True, source_commit="9327ba2", host="samplehost", total=0,
            ))
            run.coordinator.emit_initial()
        result = telemetry.read_active_runs(runs)
        assert [row["run"]["run_id"] for row in result["active_runs"]] == [f"run-{index:02d}" for index in range(16)]
        overflow = telemetry.TelemetryRun(
            progress_file=runs / "progress" / "run-16.json", runs_dir=runs,
            run_id="run-16", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        )
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            overflow.__enter__()
        assert raised.value.code == "registry_full"


def test_registry_entry_overflow_precedes_unknown_name_cleanup(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as live:
        live.coordinator.emit_initial()
        active = runs / "progress" / "active"
        for index in range(63):
            (active / f"unknown-{index:02d}").write_text("keep", encoding="utf-8")
        contender = telemetry.TelemetryRun(
            progress_file=runs / "progress" / "run-2.json", runs_dir=runs,
            run_id="run-2", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        )
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            contender.__enter__()
        assert raised.value.code == "registry_full"
        assert len(list(active.glob("unknown-*"))) == 63


def test_next_writer_removes_exact_unlocked_registry_temp_only(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "live.json", runs_dir=runs,
        run_id="live", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as live:
        live.coordinator.emit_initial()
        active = runs / "progress" / "active"
        orphan = active / f".orphan.{os.getpid()}.{'a' * 32}.ticket.tmp"
        orphan.write_bytes(b"orphan\n"); orphan.chmod(0o600)
        unrelated = runs / "progress" / "unrelated"
        unrelated.write_text("keep", encoding="utf-8")
        with telemetry.TelemetryRun(
            progress_file=runs / "progress" / "next.json", runs_dir=runs,
            run_id="next", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        ) as next_run:
            next_run.coordinator.emit_initial()
            assert not orphan.exists()
            assert unrelated.read_text(encoding="utf-8") == "keep"


def test_unknown_registry_name_fails_closed_without_deletion(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "live.json", runs_dir=runs,
        run_id="live", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as live:
        live.coordinator.emit_initial()
        unknown = runs / "progress" / "active" / "unknown"
        unknown.write_text("keep", encoding="utf-8")
        contender = telemetry.TelemetryRun(
            progress_file=runs / "progress" / "next.json", runs_dir=runs,
            run_id="next", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        )
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            contender.__enter__()
        assert raised.value.code == "registry_invalid"
        assert unknown.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("schema_version", 2),
        ("run_id", "other"),
        ("suite", "other"),
        ("host", "other"),
        ("started_at", "2025-07-16T00:00:01.000Z"),
        ("sha", "abcdef0"),
        ("progress_file", "progress/other.json"),
    ],
)
def test_active_runs_rejects_each_ticket_identity_mismatch(
    tmp_path: Path, field: str, replacement: object
) -> None:
    runs = tmp_path / "runs"
    with telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    ) as run:
        run.coordinator.emit_initial()
        ticket_path = runs / "progress" / "active" / "run-1.json"
        original = ticket_path.read_bytes()
        ticket = json.loads(original)
        ticket[field] = replacement
        ticket_path.write_bytes(telemetry.canonical_bytes(ticket))
        ticket_path.chmod(0o600)
        with pytest.raises(telemetry.ReaderFailure) as raised:
            telemetry.read_active_runs(runs)
        assert raised.value.exit_code == 5
        ticket_path.write_bytes(original)
        ticket_path.chmod(0o600)


def test_read_progress_exit_classification(tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"
    with pytest.raises(telemetry.ReaderFailure) as absent:
        telemetry.read_progress(progress_file=missing)
    assert absent.value.exit_code == 4
    bad = tmp_path / "bad.json"
    bad.write_text("{}\n", encoding="utf-8")
    bad.chmod(0o600)
    with pytest.raises(telemetry.ReaderFailure) as invalid:
        telemetry.read_progress(progress_file=bad)
    assert invalid.value.exit_code == 5


@pytest.mark.parametrize("unsafe", ["symlink", "hardlink", "mode"])
def test_public_reader_rejects_unsafe_snapshot_metadata(tmp_path: Path, unsafe: str) -> None:
    target = tmp_path / "run.json"
    source = tmp_path / "source.json"
    source.write_bytes(telemetry.canonical_bytes(_snapshot()))
    source.chmod(0o600)
    if unsafe == "symlink":
        target.symlink_to(source)
    elif unsafe == "hardlink":
        os.link(source, target)
    else:
        target.write_bytes(source.read_bytes())
        target.chmod(0o644)
    with pytest.raises(telemetry.ReaderFailure) as raised:
        telemetry.read_progress(progress_file=target)
    assert raised.value.exit_code == 5


def _probe_reader_post_observation_metadata_refresh(
    plan: contract_matrix.ProbePlan,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target_kind = plan.cell.barrier_type.removeprefix("snapshot_")
    metadata_field = plan.cell.metadata_field
    destination = tmp_path / "run.json"
    with telemetry.AtomicProgressWriter(destination) as writer:
        writer.publish(_snapshot(sequence=1))
    original_stat = telemetry.os.stat
    original_fstat = telemetry.os.fstat
    identity = original_stat(destination)
    armed = False

    def applies(info: os.stat_result) -> bool:
        return armed and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino)

    def wrapped_stat(path: object, *args: object, **kwargs: object) -> os.stat_result:
        info = original_stat(path, *args, **kwargs)
        if target_kind == "path" and applies(info):
            return _mutated_stat(info, metadata_field)
        return info

    def wrapped_fstat(fd: int) -> os.stat_result:
        info = original_fstat(fd)
        if target_kind == "descriptor" and applies(info):
            return _mutated_stat(info, metadata_field)
        return info

    def barrier(point: str, _path: telemetry.SecurePath, _fd: int | None) -> None:
        nonlocal armed
        if point == "after_observation":
            armed = True

    monkeypatch.setattr(telemetry.os, "stat", wrapped_stat)
    monkeypatch.setattr(telemetry.os, "fstat", wrapped_fstat)
    monkeypatch.setattr(telemetry, "_READER_BARRIER", barrier)
    with pytest.raises(telemetry.ReaderFailure) as raised:
        telemetry.read_progress(progress_file=destination)
    assert raised.value.exit_code == 5 and armed


def test_public_reader_never_returns_partial_during_replacement(tmp_path: Path) -> None:
    destination = tmp_path / "run.json"
    stop = threading.Event()
    failures: list[BaseException] = []
    seen: list[int] = []
    with telemetry.AtomicProgressWriter(destination) as writer:
        writer.publish(_snapshot(sequence=1))

        def reader() -> None:
            while not stop.is_set():
                try:
                    seen.append(int(telemetry.read_progress(progress_file=destination)["sequence"]))
                except BaseException as exc:  # noqa: BLE001
                    failures.append(exc)

        thread = threading.Thread(target=reader)
        thread.start()
        for sequence in range(2, 30):
            writer.publish(_snapshot(sequence=sequence))
        stop.set(); thread.join()
    assert failures == []
    assert seen and min(seen) >= 1 and max(seen) <= 29


@pytest.mark.parametrize(
    "point",
    ["before_open", "after_open", "before_final_observation", "after_pre_observation_verify", "after_observation"],
)
@pytest.mark.parametrize("relative", [False, True])
def test_reader_intermediate_chain_swap_fails_closed_without_replacement_tree_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, point: str, relative: bool
) -> None:
    chain = tmp_path / "chain"
    parent = chain / "parent"
    parent.mkdir(parents=True)
    absolute_destination = parent / "run.json"
    absolute_destination.write_bytes(telemetry.canonical_bytes(_snapshot(sequence=2)))
    absolute_destination.chmod(0o600)
    destination = Path("chain/parent/run.json") if relative else absolute_destination
    replacement_bytes = telemetry.canonical_bytes(_snapshot(sequence=9))
    fired = False

    def barrier(current: str, _path: telemetry.SecurePath, _fd: int | None) -> None:
        nonlocal fired
        if fired or current != point:
            return
        fired = True
        chain.rename(tmp_path / "retained")
        replacement = tmp_path / "chain" / "parent"
        replacement.mkdir(parents=True)
        target = replacement / "run.json"
        target.write_bytes(replacement_bytes)
        target.chmod(0o600)

    monkeypatch.setattr(telemetry, "_READER_BARRIER", barrier)
    previous_cwd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
    try:
        if relative:
            os.chdir(tmp_path)
        with pytest.raises(telemetry.ReaderFailure) as raised:
            telemetry.read_progress(progress_file=destination)
        assert raised.value.exit_code == 5
        assert (tmp_path / "chain" / "parent" / "run.json").read_bytes() == replacement_bytes
    finally:
        os.fchdir(previous_cwd)
        os.close(previous_cwd)


@pytest.mark.parametrize(
    ("point", "expected"),
    [
        ("before_open", 3),
        ("after_open", 2),
        ("before_final_observation", 2),
        ("after_pre_observation_verify", 2),
        ("between_final_fstat_lstat", 2),
        ("after_observation", 2),
        ("after_final_validation", 2),
    ],
)
def test_reader_inode_lifecycle_boundary_matrix(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    point: str,
    expected: int,
) -> None:
    destination = tmp_path / "run.json"
    destination.write_bytes(telemetry.canonical_bytes(_snapshot(sequence=2)))
    destination.chmod(0o600)
    successor = tmp_path / "successor"
    successor.write_bytes(telemetry.canonical_bytes(_snapshot(sequence=3)))
    successor.chmod(0o600)
    fired = False

    def barrier(current: str, _path: telemetry.SecurePath, _fd: int | None) -> None:
        nonlocal fired
        if not fired and current == point:
            fired = True
            os.replace(successor, destination)

    monkeypatch.setattr(telemetry, "_READER_BARRIER", barrier)
    assert telemetry.read_progress(progress_file=destination)["sequence"] == expected


def test_writer_intermediate_swap_before_rename_fails_without_publishing(
    tmp_path: Path,
) -> None:
    chain = tmp_path / "chain"
    parent = chain / "parent"
    parent.mkdir(parents=True)
    destination = parent / "run.json"
    fired = False

    def injector(point: str) -> None:
        nonlocal fired
        if not fired and point == "before_snapshot_rename":
            fired = True
            chain.rename(tmp_path / "retained")
            (tmp_path / "chain" / "parent").mkdir(parents=True)

    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=1))
        assert raised.value.post_rename is False
    assert not (tmp_path / "chain" / "parent" / "run.json").exists()
    assert not (tmp_path / "retained" / "parent" / "run.json").exists()


def test_writer_intermediate_swap_after_rename_retains_published_inode_off_replacement_tree(
    tmp_path: Path,
) -> None:
    chain = tmp_path / "chain"
    parent = chain / "parent"
    parent.mkdir(parents=True)
    destination = parent / "run.json"

    def injector(point: str) -> None:
        if point == "after_snapshot_rename":
            chain.rename(tmp_path / "retained")
            (tmp_path / "chain" / "parent").mkdir(parents=True)

    with telemetry.AtomicProgressWriter(destination, fault_injector=injector) as writer:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=1))
        assert raised.value.post_rename is True
    assert not (tmp_path / "chain" / "parent" / "run.json").exists()
    assert telemetry.decode_canonical(
        (tmp_path / "retained" / "parent" / "run.json").read_bytes(), max_bytes=65536,
    )["sequence"] == 1


def test_secret_sentinels_never_enter_fixed_failure_text(tmp_path: Path) -> None:
    secret = "TOKEN-secret-/private/secret"

    def injector(point: str) -> None:
        if point == "before_snapshot_rename":
            raise OSError(secret)

    with telemetry.AtomicProgressWriter(tmp_path / "run.json", fault_injector=injector) as writer:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            writer.publish(_snapshot(sequence=1))
    assert secret not in str(raised.value)


def test_active_runs_never_mixes_retained_ticket_with_reopened_snapshot_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = tmp_path / "runs"
    retained = tmp_path / "retained-runs"
    original_probe = telemetry._probe_ticket
    swapped = False

    def swap_after_probe(
        active: telemetry.SecurePath, name: str
    ) -> telemetry._TicketProbe:
        nonlocal swapped
        probe = original_probe(active, name)
        if not swapped:
            swapped = True
            snapshot = telemetry.read_progress(progress_file=runs / "progress" / "run-1.json")
            snapshot["sequence"] = 99
            runs.rename(retained)
            replacement = runs / "progress"
            replacement.mkdir(parents=True)
            target = replacement / "run-1.json"
            target.write_bytes(telemetry.canonical_bytes(snapshot))
            target.chmod(0o600)
        return probe

    owner = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    owner.__enter__()
    owner.coordinator.emit_initial()
    try:
        monkeypatch.setattr(telemetry, "_probe_ticket", swap_after_probe)
        with pytest.raises(telemetry.ReaderFailure) as raised:
            telemetry.read_active_runs(runs)
        assert raised.value.exit_code == 5
        assert telemetry.read_progress(progress_file=retained / "progress" / "run-1.json")["sequence"] == 1
        assert telemetry.read_progress(progress_file=runs / "progress" / "run-1.json")["sequence"] == 99
    finally:
        if retained.exists():
            runs.rename(tmp_path / "replacement-runs")
            retained.rename(runs)
        owner.close()


def _probe_ticket_publication_failure_rollback_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    runs = tmp_path / "runs"
    progress = runs / "progress" / "run-1.json"
    run = telemetry.TelemetryRun(
        progress_file=progress,
        runs_dir=runs,
        run_id="run-1",
        advertised=True,
        source_commit="9327ba2",
        host="samplehost",
        total=0,
    )
    run.__enter__()
    assert run.registry is not None
    active_fd = run.registry.active.parent_fd
    active = runs / "progress" / "active"
    original_write = telemetry.os.write
    original_fsync = telemetry.os.fsync
    original_rename = telemetry.os.rename
    failed = False

    def is_ticket_fd(fd: int) -> bool:
        try:
            return b'"owner_pid"' in os.pread(fd, 4096, 0)
        except OSError:
            return False

    def wrapped_write(fd: int, data: object) -> int:
        nonlocal failed
        if operation == "write" and not failed and b'"owner_pid"' in bytes(data):
            failed = True
            raise OSError("secret-ticket-write")
        return original_write(fd, data)

    def wrapped_fsync(fd: int) -> None:
        nonlocal failed
        ticket_fsync = operation == "file_fsync" and is_ticket_fd(fd)
        directory_fsync = operation == "dir_fsync" and fd == active_fd and (active / "run-1.json").exists()
        if not failed and (ticket_fsync or directory_fsync):
            failed = True
            raise OSError("secret-ticket-fsync")
        original_fsync(fd)

    def wrapped_rename(src: object, dst: object, *args: object, **kwargs: object) -> None:
        nonlocal failed
        if operation == "rename" and not failed and str(src).endswith(".ticket.tmp"):
            failed = True
            raise OSError("secret-ticket-rename")
        original_rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(telemetry.os, "write", wrapped_write)
    monkeypatch.setattr(telemetry.os, "fsync", wrapped_fsync)
    monkeypatch.setattr(telemetry.os, "rename", wrapped_rename)
    try:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            run.coordinator.emit_initial()
        assert raised.value.code == "registry_write_failed" and failed
        assert telemetry.read_progress(progress_file=progress)["sequence"] == 1
        assert not (active / "run-1.json").exists()
        assert not list(active.glob("*.ticket.tmp"))
    finally:
        run.close()


def _probe_ticket_publication_failure_rollback(
    plan: contract_matrix.ProbePlan,
    tmp_path: Path,
) -> None:
    for operation in plan.probe_points:
        with pytest.MonkeyPatch.context() as monkeypatch:
            _probe_ticket_publication_failure_rollback_once(
                tmp_path / operation,
                monkeypatch,
                operation,
            )


@pytest.mark.parametrize("replaced", ["ticket", "destination_lock"])
def test_active_runs_rechecks_owned_ticket_and_lock_after_snapshot_observation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replaced: str
) -> None:
    runs = tmp_path / "runs"
    owner = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    owner.__enter__()
    owner.coordinator.emit_initial()
    ticket = runs / "progress" / "active" / "run-1.json"
    destination_lock = runs / "progress" / "run-1.json.lock"
    target = ticket if replaced == "ticket" else destination_lock
    detached = target.with_name(f"{target.name}.detached")
    replacement_bytes = target.read_bytes()
    fired = False

    def barrier(point: str, _path: telemetry.SecurePath, _fd: int | None) -> None:
        nonlocal fired
        if not fired and point == "before_final_observation":
            fired = True
            target.rename(detached)
            target.write_bytes(replacement_bytes)
            target.chmod(0o600)

    monkeypatch.setattr(telemetry, "_READER_BARRIER", barrier)
    try:
        with pytest.raises(telemetry.ReaderFailure) as raised:
            telemetry.read_active_runs(runs)
        assert raised.value.exit_code == 5
        assert target.read_bytes() == replacement_bytes
    finally:
        if detached.exists():
            target.rename(target.with_name(f"{target.name}.replacement"))
            detached.rename(target)
        owner.close()


def test_dead_ticket_reap_rechecks_destination_immediately_before_unlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = tmp_path / "runs"
    owner = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "dead.json", runs_dir=runs,
        run_id="dead", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    owner.__enter__()
    owner.coordinator.emit_initial()
    ticket = runs / "progress" / "active" / "dead.json"
    lock = runs / "progress" / "dead.json.lock"
    os.close(owner.ticket_fd)
    owner.ticket_fd = -1
    assert owner.writer is not None
    os.close(owner.writer.lock_fd)
    owner.writer.lock_fd = -1
    original_verify = telemetry._verify_fd_path
    ticket_verifications = 0

    def replace_destination_before_reap(
        path: telemetry.SecurePath, name: str, fd: int, code: str, **kwargs: object
    ) -> os.stat_result:
        nonlocal ticket_verifications
        if name == "dead.json" and path.name == ".registry.lock":
            ticket_verifications += 1
            if ticket_verifications == 4:
                lock.rename(lock.with_suffix(".detached"))
                lock.write_bytes(b"")
                lock.chmod(0o600)
        return original_verify(path, name, fd, code, **kwargs)

    monkeypatch.setattr(telemetry, "_verify_fd_path", replace_destination_before_reap)
    contender = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "next.json", runs_dir=runs,
        run_id="next", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    try:
        with pytest.raises(telemetry.TelemetryFailure) as raised:
            contender.__enter__()
        assert raised.value.code == "registry_invalid"
        assert ticket.exists()
    finally:
        owner.close()


@pytest.mark.parametrize("point", ["before_registry_flock", "after_registry_flock"])
def test_registry_lock_replacement_at_acquisition_boundaries_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, point: str
) -> None:
    runs = tmp_path / "runs"
    registry = telemetry.ActiveRegistry(runs, create=True)
    lock = runs / "progress" / "active" / ".registry.lock"
    replacement = b"replacement"
    fired = False

    def barrier(current: str, _registry: telemetry.ActiveRegistry) -> None:
        nonlocal fired
        if not fired and current == point:
            fired = True
            lock.rename(lock.with_suffix(".detached"))
            lock.write_bytes(replacement)
            lock.chmod(0o600)

    monkeypatch.setattr(telemetry, "_REGISTRY_BARRIER", barrier, raising=False)
    with pytest.raises(telemetry.TelemetryFailure) as raised:
        registry.acquire(writer=False)
    assert raised.value.code == "registry_invalid"
    assert lock.read_bytes() == replacement
    registry.close()


def _probe_stable_registry_object_metadata_boundary_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    target_kind: str,
    point: str,
    mutation: str,
) -> None:
    runs = tmp_path / "runs"
    owner = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    owner.__enter__()
    owner.coordinator.emit_initial()
    paths = {
        "registry": runs / "progress" / "active" / ".registry.lock",
        "destination": runs / "progress" / "run-1.json.lock",
        "ticket": runs / "progress" / "active" / "run-1.json",
    }
    target = paths[target_kind]
    original = target.read_bytes()
    original_stat = telemetry.os.stat
    original_fstat = telemetry.os.fstat
    target_identity = original_stat(target)
    sibling = target.with_name(f"{target.name}.extra-link")
    detached = target.with_name(f"{target.name}.detached-metadata")
    fired = False
    owner_mutated = False

    def wrapped_stat(path: object, *args: object, **kwargs: object) -> os.stat_result:
        info = original_stat(path, *args, **kwargs)
        if owner_mutated and (info.st_dev, info.st_ino) == (target_identity.st_dev, target_identity.st_ino):
            return _mutated_stat(info, "owner")
        return info

    def wrapped_fstat(fd: int) -> os.stat_result:
        info = original_fstat(fd)
        if owner_mutated and (info.st_dev, info.st_ino) == (target_identity.st_dev, target_identity.st_ino):
            return _mutated_stat(info, "owner")
        return info

    monkeypatch.setattr(telemetry.os, "stat", wrapped_stat)
    monkeypatch.setattr(telemetry.os, "fstat", wrapped_fstat)

    def mutate() -> None:
        nonlocal fired, owner_mutated
        if fired:
            return
        fired = True
        if mutation == "mode":
            target.chmod(0o644)
        elif mutation == "owner":
            owner_mutated = True
        elif mutation == "size":
            bound = 4096 if target_kind == "ticket" else 65536
            with target.open("ab") as handle:
                handle.write(b"x" * (bound + 1 - target.stat().st_size))
        elif mutation == "link":
            os.link(target, sibling)
        else:
            target.rename(detached)
            target.mkdir()

    def registry_barrier(current: str, _registry: telemetry.ActiveRegistry) -> None:
        if current == point:
            mutate()

    def stable_barrier(
        current: str, _path: object, _name: str, _fd: int
    ) -> None:
        if current == point:
            mutate()

    def reader_barrier(current: str, _path: object, _fd: int | None) -> None:
        if point == "after_snapshot_observation" and current == "after_observation":
            mutate()

    monkeypatch.setattr(telemetry, "_REGISTRY_BARRIER", registry_barrier)
    monkeypatch.setattr(telemetry, "_STABLE_BARRIER", stable_barrier, raising=False)
    monkeypatch.setattr(telemetry, "_READER_BARRIER", reader_barrier)
    try:
        with pytest.raises(telemetry.ReaderFailure) as raised:
            telemetry.read_active_runs(runs)
        assert raised.value.exit_code == 5 and fired
    finally:
        if target.is_dir():
            target.rmdir()
            detached.rename(target)
        if sibling.exists():
            sibling.unlink()
        target.chmod(0o600)
        target.write_bytes(original)
        target.chmod(0o600)
        owner.close()


def _probe_stable_registry_object_metadata_boundary(
    plan: contract_matrix.ProbePlan,
    tmp_path: Path,
) -> None:
    target_kind = plan.cell.barrier_type.removeprefix("stable_")
    mutation = "path_type" if plan.cell.metadata_field == "type" else plan.cell.metadata_field
    for point in plan.probe_points:
        with pytest.MonkeyPatch.context() as monkeypatch:
            _probe_stable_registry_object_metadata_boundary_once(
                tmp_path / point,
                monkeypatch,
                target_kind,
                point,
                mutation,
            )


def test_snapshot_final_observation_revalidates_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "run.json"
    destination.write_bytes(telemetry.canonical_bytes(_snapshot(sequence=2)))
    destination.chmod(0o600)

    def barrier(point: str, _path: telemetry.SecurePath, fd: int | None) -> None:
        if point == "before_final_observation" and fd is not None:
            os.fchmod(fd, 0o644)

    monkeypatch.setattr(telemetry, "_READER_BARRIER", barrier)
    with pytest.raises(telemetry.ReaderFailure) as raised:
        telemetry.read_progress(progress_file=destination)
    assert raised.value.exit_code == 5


@pytest.mark.parametrize("operation", ["unlink", "fsync"])
def test_ticket_cleanup_errors_are_normalized_and_close_every_descriptor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    runs = tmp_path / "runs"
    run = telemetry.TelemetryRun(
        progress_file=runs / "progress" / "run-1.json", runs_dir=runs,
        run_id="run-1", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
    )
    run.__enter__()
    run.coordinator.emit_initial()
    assert run.registry is not None
    assert run.writer is not None
    registry = run.registry
    writer = run.writer
    active_fd = run.registry.active.parent_fd
    original_unlink = os.unlink
    original_fsync = os.fsync

    def failing_unlink(path: str, *args: object, **kwargs: object) -> None:
        if path == "run-1.json":
            raise OSError("secret-unlink")
        original_unlink(path, *args, **kwargs)

    def failing_fsync(fd: int) -> None:
        if fd == active_fd:
            raise OSError("secret-fsync")
        original_fsync(fd)

    monkeypatch.setattr(os, operation, failing_unlink if operation == "unlink" else failing_fsync)
    with pytest.raises(telemetry.TelemetryFailure) as raised:
        run.close(strict=True)
    assert raised.value.code == "registry_write_failed"
    assert "secret" not in str(raised.value)
    assert run.registry is None and run.writer is None
    assert registry.lock_fd == registry.ticket_fd == -1
    assert writer.lock_fd == writer.temp_fd == -1


def test_sigkill_after_ticket_temp_lock_leaves_one_reapable_orphan(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    helper = tmp_path / "ticket_crash.py"
    helper.write_text(
        "import time\n"
        "from pathlib import Path\n"
        "import progress_telemetry as telemetry\n"
        "runs=Path(__import__('sys').argv[1])\n"
        "def barrier(point,registry):\n"
        " if point=='after_ticket_temp_lock': print('READY',flush=True); time.sleep(60)\n"
        "telemetry._REGISTRY_BARRIER=barrier\n"
        "run=telemetry.TelemetryRun(progress_file=runs/'progress'/'killed.json',runs_dir=runs,run_id='killed',advertised=True,source_commit='9327ba2',host='samplehost',total=0)\n"
        "run.__enter__(); run.coordinator.emit_initial(); print('AFTER',flush=True); time.sleep(60)\n",
        encoding="utf-8",
    )
    proc = subprocess.Popen(
        [sys.executable, str(helper), str(runs)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
    )
    try:
        assert proc.stdout is not None and proc.stdout.readline().strip() == "READY"
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        active = runs / "progress" / "active"
        orphans = list(active.glob(".killed.*.ticket.tmp"))
        assert len(orphans) == 1
        orphan_inode = orphans[0].stat().st_ino
        with telemetry.TelemetryRun(
            progress_file=runs / "progress" / "next.json", runs_dir=runs,
            run_id="next", advertised=True, source_commit="9327ba2", host="samplehost", total=0,
        ) as next_run:
            next_run.coordinator.emit_initial()
            assert not orphans[0].exists()
            assert all(path.stat().st_ino != orphan_inode for path in active.iterdir())
        assert (runs / "progress" / "killed.json").exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        if proc.stdout is not None:
            proc.stdout.close()
        if proc.stderr is not None:
            proc.stderr.close()


def test_concurrent_active_readers_classify_one_dead_ticket_consistently(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    helper = (
        "import sys,time; from pathlib import Path; from progress_telemetry import TelemetryRun; "
        "r=TelemetryRun(progress_file=Path(sys.argv[1])/'progress'/'dead.json',runs_dir=Path(sys.argv[1]),"
        "run_id='dead',advertised=True,source_commit='9327ba2',host='samplehost',total=0); "
        "r.__enter__(); r.coordinator.emit_initial(); print('READY',flush=True); time.sleep(60)"
    )
    owner = subprocess.Popen(
        [sys.executable, "-c", helper, str(runs)],
        stdout=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
    )
    assert owner.stdout is not None and owner.stdout.readline().strip() == "READY"
    os.kill(owner.pid, signal.SIGKILL)
    owner.wait(timeout=5)
    command = [
        sys.executable, str(Path(__file__).resolve().parents[1] / "progress_telemetry.py"),
        "active-runs", "--runs-dir", str(runs),
    ]
    readers = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
    payloads = []
    for reader in readers:
        stdout, stderr = reader.communicate(timeout=5)
        assert reader.returncode == 0 and stderr == b""
        payloads.append(json.loads(stdout))
    assert all(row == {"schema_version": 1, "active_runs": [], "ignored_dead": 1} for row in payloads)

