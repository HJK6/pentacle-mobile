from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Iterator


NA = "not_applicable"

WRITER_SEAMS = (
    "before_snapshot_temp_open",
    "after_snapshot_temp_open",
    "after_snapshot_temp_fsync",
    "before_snapshot_rename",
    "after_snapshot_rename",
    "before_temp_dir_fsync",
    "after_temp_dir_fsync",
    "before_destination_dir_fsync",
    "after_destination_dir_fsync",
    "before_snapshot_final_observation",
    "after_snapshot_final_observation",
    NA,
)

BARRIER_TYPES = (
    "snapshot_temp_directory",
    "destination_parent_absolute",
    "destination_parent_relative",
    "stable_registry",
    "stable_destination",
    "stable_ticket",
    "snapshot_descriptor",
    "snapshot_path",
    "coordinator",
    "registry_publication",
)

TERMINAL_STATES = (
    "running",
    "success",
    "failure",
    "setup_failure",
    "timeout",
    "heartbeat_error",
    "telemetry_error_pre_pass",
    "telemetry_error_pre_failure",
    "telemetry_error_pre_setup_failure",
    "telemetry_error_pre_skipped",
    "telemetry_error_pre_waived",
    "telemetry_error_post_pass",
    "telemetry_error_post_failure",
    "telemetry_error_post_setup_failure",
    "telemetry_error_post_skipped",
    "telemetry_error_post_waived",
    "sigint",
    "sigterm",
)

PARITY_DIMENSIONS = (
    "fail_closed",
    "visible_sequence",
    "result_json",
    "terminal_once",
    "heartbeat_join",
    "schedule_stop",
    "ticket_cleanup",
    "canonical_round_trip",
    "rollback",
)

METADATA_FIELDS = ("type", "owner", "mode", "size", "link", "chain", "canonical")

TICKET_CANONICAL_PROBES = (
    "round_trip",
    "duplicate",
    "unknown",
    "missing",
    "wrong_type",
    "whitespace",
    "order",
    "encoding",
    "unsafe_path",
)
TICKET_PUBLICATION_PROBES = ("write", "file_fsync", "rename", "dir_fsync")


@dataclass(frozen=True)
class ContractCell:
    writer_seam: str
    barrier_type: str
    terminal_state: str
    parity: str
    metadata_field: str


@dataclass(frozen=True)
class Resolution:
    test_name: str | None = None
    exclusion: str | None = None

    def __post_init__(self) -> None:
        if (self.test_name is None) == (self.exclusion is None):
            raise ValueError("matrix cell must have exactly one test or exclusion")
        if self.exclusion is not None and not self.exclusion.strip():
            raise ValueError("excluded matrix cells require a code-level reason")


_CELL_FIELDS = (
    "writer_seam",
    "barrier_type",
    "terminal_state",
    "parity",
    "metadata_field",
)


@dataclass(frozen=True)
class MappedCase:
    cell: ContractCell
    resolution: Resolution

    def __post_init__(self) -> None:
        if self.resolution.test_name is None:
            raise ValueError("mapped case must name its runtime probe")

    @property
    def pytest_id(self) -> str:
        return "|".join(
            f"{field}={getattr(self.cell, field)}" for field in _CELL_FIELDS
        )

    @property
    def probe_plan(self) -> ProbePlan:
        return _probe_plan(self)


@dataclass(frozen=True)
class ProbePlan:
    cell: ContractCell
    name: str
    probe_points: tuple[str, ...]


_WRITER_BARRIERS = {
    "snapshot_temp_directory",
    "destination_parent_absolute",
    "destination_parent_relative",
}
_STABLE_BARRIERS = {"stable_registry", "stable_destination", "stable_ticket"}
_SNAPSHOT_BARRIERS = {"snapshot_descriptor", "snapshot_path"}
_STABLE_PROBE_POINTS = {
    "stable_registry": ("before_registry_flock", "after_registry_flock"),
    "stable_destination": (
        "before_destination_probe",
        "after_destination_probe",
        "after_snapshot_observation",
    ),
    "stable_ticket": (
        "before_ticket_probe",
        "after_ticket_probe",
        "after_snapshot_observation",
    ),
}
_TERMINAL_PARITY = {
    "visible_sequence",
    "result_json",
    "terminal_once",
    "heartbeat_join",
    "ticket_cleanup",
}


def iter_cells() -> Iterator[ContractCell]:
    for values in product(
        WRITER_SEAMS,
        BARRIER_TYPES,
        TERMINAL_STATES,
        PARITY_DIMENSIONS,
        METADATA_FIELDS,
    ):
        yield ContractCell(*values)


def resolve(cell: ContractCell) -> Resolution:
    """Resolve every cross-product cell to executable coverage or a reason."""
    barrier = cell.barrier_type
    seam = cell.writer_seam
    state = cell.terminal_state
    parity = cell.parity
    field = cell.metadata_field

    if barrier in _WRITER_BARRIERS:
        if seam == NA:
            return Resolution(exclusion="writer barrier requires a concrete writer seam")
        if state != "running":
            return Resolution(exclusion="writer metadata races are state-independent running emissions")
        if parity not in {"fail_closed", "visible_sequence"}:
            return Resolution(exclusion="writer metadata races assert failure and visibility only")
        allowed = (
            {"type", "owner", "mode"}
            if barrier == "snapshot_temp_directory"
            else {"type", "owner", "mode", "chain"}
        )
        if field not in allowed:
            return Resolution(exclusion="field is not metadata carried by this directory barrier")
        if parity == "visible_sequence" and field != "chain":
            return Resolution(exclusion="visibility disposition is invariant across directory metadata fields")
        if barrier == "snapshot_temp_directory":
            return Resolution(test_name="test_snapshot_temp_directory_metadata_race_matrix")
        return Resolution(test_name="test_writer_parent_boundary_generated_matrix")

    if barrier in _STABLE_BARRIERS:
        if seam != NA:
            return Resolution(exclusion="stable registry objects use probe barriers, not writer seams")
        if state != "running" or parity != "fail_closed":
            return Resolution(exclusion="stable object metadata is a running fail-closed invariant")
        if field not in {"type", "owner", "mode", "size", "link"}:
            return Resolution(exclusion="field does not belong to a stable regular-file object")
        return Resolution(test_name="test_stable_registry_object_metadata_boundary_matrix")

    if barrier in _SNAPSHOT_BARRIERS:
        if seam != NA:
            return Resolution(exclusion="reader observation barriers are independent of writer seams")
        if state != "running" or parity != "fail_closed":
            return Resolution(exclusion="reader metadata refresh is a running fail-closed invariant")
        if field not in {"type", "owner", "mode", "size", "link"}:
            return Resolution(exclusion="field does not belong to an opened snapshot inode")
        return Resolution(test_name="test_reader_post_observation_metadata_refresh_matrix")

    if barrier == "coordinator":
        if seam != NA:
            return Resolution(exclusion="coordinator state transitions do not execute a named writer seam")
        if field != "canonical":
            return Resolution(exclusion="coordinator rows compare canonical state, not inode metadata")
        if state == "running":
            return Resolution(exclusion="terminal/error/signal parity requires a terminal state")
        if parity in _TERMINAL_PARITY:
            return Resolution(test_name="test_generated_public_terminal_matrix")
        if parity == "schedule_stop" and (
            state == "heartbeat_error"
            or state.startswith("telemetry_error_")
            or state in {"sigint", "sigterm"}
        ):
            return Resolution(test_name="test_generated_public_terminal_matrix")
        return Resolution(exclusion="parity dimension is not defined for this coordinator terminal state")

    if barrier == "registry_publication":
        if seam != NA:
            return Resolution(exclusion="ticket publication has dedicated write/fsync/rename barriers")
        if state != "running" or field != "canonical":
            return Resolution(exclusion="ticket publication operates on canonical running-state tickets")
        if parity == "canonical_round_trip":
            return Resolution(test_name="test_ticket_canonical_schema_generated_matrix")
        if parity == "rollback":
            return Resolution(test_name="test_ticket_publication_failure_rollback_generated_matrix")
        return Resolution(exclusion="ticket publication asserts only canonical form and rollback")

    raise AssertionError(f"unclassified barrier type: {barrier}")


def mapped_cells(test_name: str) -> tuple[ContractCell, ...]:
    return tuple(cell for cell in iter_cells() if resolve(cell).test_name == test_name)


def mapped_cases() -> tuple[MappedCase, ...]:
    cases: list[MappedCase] = []
    for cell in iter_cells():
        resolution = resolve(cell)
        if resolution.test_name is not None:
            cases.append(MappedCase(cell=cell, resolution=resolution))
    return tuple(cases)


def _probe_plan(case: MappedCase) -> ProbePlan:
    name = case.resolution.test_name
    if name is None:
        raise AssertionError("excluded cells cannot own runtime probes")
    cell = case.cell
    if cell.barrier_type in _WRITER_BARRIERS:
        points = (cell.writer_seam,)
    elif cell.barrier_type in _STABLE_BARRIERS:
        points = _STABLE_PROBE_POINTS[cell.barrier_type]
    elif cell.barrier_type in _SNAPSHOT_BARRIERS:
        points = ("after_observation",)
    elif cell.barrier_type == "coordinator":
        points = (cell.terminal_state,)
    elif cell.parity == "canonical_round_trip":
        points = TICKET_CANONICAL_PROBES
    elif cell.parity == "rollback":
        points = TICKET_PUBLICATION_PROBES
    else:
        raise AssertionError("mapped cell has no engine-owned runtime probe plan")
    return ProbePlan(cell=cell, name=name, probe_points=points)


def cell_from_pytest_id(value: str) -> ContractCell:
    parts = value.split("|")
    if len(parts) != len(_CELL_FIELDS):
        raise ValueError("contract witness id must carry every cell field")
    values: list[str] = []
    for expected_field, part in zip(_CELL_FIELDS, parts, strict=True):
        field, separator, field_value = part.partition("=")
        if not separator or field != expected_field or not field_value:
            raise ValueError("contract witness id has an invalid field")
        values.append(field_value)
    return ContractCell(*values)


def assert_bijection(cases: tuple[MappedCase, ...]) -> None:
    expected = {
        cell: resolution
        for cell in iter_cells()
        if (resolution := resolve(cell)).test_name is not None
    }
    cells = [case.cell for case in cases]
    ids = [case.pytest_id for case in cases]
    if len(cells) != len(set(cells)) or len(ids) != len(set(ids)):
        raise AssertionError("mapped contract cases must have unique cells and pytest ids")
    if set(cells) != set(expected):
        raise AssertionError("collected contract cases must equal the mapped cell set")
    for case in cases:
        if case.resolution != expected[case.cell]:
            raise AssertionError("mapped contract case carries the wrong resolution")
        if cell_from_pytest_id(case.pytest_id) != case.cell:
            raise AssertionError("pytest id does not round-trip to its full ContractCell")


def summary() -> dict[str, int]:
    mapped = 0
    excluded = 0
    for cell in iter_cells():
        resolution = resolve(cell)
        mapped += resolution.test_name is not None
        excluded += resolution.exclusion is not None
    return {"total": mapped + excluded, "mapped": mapped, "excluded": excluded}
