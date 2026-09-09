"""Strict-order, group, negative-watch, and terminator assertions for public synthetic traces.

A trace is an ordered list of telemetry-event dictionaries. The module exposes
small step constructors and a result object for deterministic, device-free
checks. Strict steps preserve order, group steps allow local reordering,
negative steps reject forbidden events, and terminators require exactly one
of two alternatives.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

KIND_STRICT = "STRICT"
KIND_GROUP = "GROUP"
KIND_NEG = "NEG"
KIND_TERMINATOR = "TERMINATOR"

GTE_PREFIX = "GTE_"

Predicate = Callable[[dict], bool]


# ---------------------------------------------------------------------------
# Public step types
# ---------------------------------------------------------------------------


@dataclass
class TelemetryStep:
    """One step in a flow's expected sequence.

    Fields:
      kind: one of `STRICT`, `GROUP`, `NEG`, `TERMINATOR`.
      event: telemetry event name (ignored for TERMINATOR which carries
             `option_a` / `option_b` instead).
      count: int (exact) OR the string `GTE_<n>` for a lower-bound match.
             Ignored for NEG (always 0) and TERMINATOR (always 1).
      where: optional predicate on event data (`event['data']`).
      group_id: required when kind == GROUP, else None.
      label: optional human-readable label for trace output.
      option_a / option_b: TERMINATOR step pair; each is a (event_name,
             where) tuple. Exactly one of the two events must appear in the
             post-terminator window.
    """
    kind: str
    event: str = ""
    count: Any = 1  # int or 'GTE_<n>'
    where: Optional[Predicate] = None
    group_id: Optional[str] = None
    label: Optional[str] = None
    option_a: Optional[tuple[str, Optional[Predicate]]] = None
    option_b: Optional[tuple[str, Optional[Predicate]]] = None

    def describe(self) -> str:
        if self.label:
            return self.label
        if self.kind == KIND_TERMINATOR and self.option_a and self.option_b:
            return f"[TERMINATOR] {self.option_a[0]} XOR {self.option_b[0]}"
        return f"[{self.kind}{':' + self.group_id if self.group_id else ''}] {self.event} x{self.count}"


def strict(event: str, count: Any = 1, where: Optional[Predicate] = None, label: Optional[str] = None) -> TelemetryStep:
    return TelemetryStep(kind=KIND_STRICT, event=event, count=count, where=where, label=label)


def group(group_id: str, event: str, count: Any = 1, where: Optional[Predicate] = None, label: Optional[str] = None) -> TelemetryStep:
    return TelemetryStep(kind=KIND_GROUP, event=event, count=count, where=where, group_id=group_id, label=label)


def neg(event: str, where: Optional[Predicate] = None, label: Optional[str] = None) -> TelemetryStep:
    return TelemetryStep(kind=KIND_NEG, event=event, where=where, label=label)


def terminator(
    option_a: tuple[str, Optional[Predicate]],
    option_b: tuple[str, Optional[Predicate]],
    label: Optional[str] = None,
) -> TelemetryStep:
    return TelemetryStep(
        kind=KIND_TERMINATOR,
        option_a=option_a,
        option_b=option_b,
        label=label,
    )


def gte(n: int) -> str:
    """Lower-bound count token. Use as `count=gte(2)`."""
    return f"{GTE_PREFIX}{n}"


def _parse_count(count: Any) -> tuple[str, int]:
    """Return ('exact' | 'gte', n)."""
    if isinstance(count, str) and count.startswith(GTE_PREFIX):
        try:
            return ("gte", int(count[len(GTE_PREFIX):]))
        except ValueError as exc:
            raise ValueError(f"invalid GTE count token: {count!r}") from exc
    if isinstance(count, int):
        return ("exact", count)
    raise ValueError(f"invalid count: {count!r}")


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class AssertionResult:
    passed: bool = True
    strict_pass_count: int = 0
    strict_total: int = 0
    group_pass_count: int = 0
    group_total: int = 0
    neg_violations: list[str] = field(default_factory=list)
    out_of_order: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    terminator_outcome: Optional[str] = None  # 'A', 'B', or None
    summary: str = ""
    info: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "strict_pass_count": self.strict_pass_count,
            "strict_total": self.strict_total,
            "group_pass_count": self.group_pass_count,
            "group_total": self.group_total,
            "neg_violations": list(self.neg_violations),
            "out_of_order": list(self.out_of_order),
            "missing": list(self.missing),
            "terminator_outcome": self.terminator_outcome,
            "summary": self.summary,
            "info": dict(self.info),
        }


# ---------------------------------------------------------------------------
# Implementation helpers
# ---------------------------------------------------------------------------


def _event_matches(event: dict, name: str, where: Optional[Predicate]) -> bool:
    if event.get("name") != name:
        return False
    if where is None:
        return True
    data = event.get("data") or {}
    try:
        return bool(where(data))
    except Exception:
        return False


def _find_first_match(
    trace: list[dict],
    name: str,
    where: Optional[Predicate],
    start_idx: int,
    upper_idx: Optional[int] = None,
) -> Optional[int]:
    end = len(trace) if upper_idx is None else upper_idx
    for i in range(start_idx, end):
        if _event_matches(trace[i], name, where):
            return i
    return None


def _count_matches(
    trace: list[dict],
    name: str,
    where: Optional[Predicate],
    lo: int,
    hi: int,
) -> int:
    return sum(1 for i in range(lo, hi) if _event_matches(trace[i], name, where))


# ---------------------------------------------------------------------------
# Assertion orchestrator
# ---------------------------------------------------------------------------


class TelemetryAssertion:
    """Assert a list of `TelemetryStep` entries against a captured trace.

    The matching algorithm sweeps the trace left-to-right honouring STRICT
    order while accepting any in-window order for GROUP steps.

    For each STRICT (or GROUP-flush, or TERMINATOR) step we:
      1. Identify the search window [cursor, next_strict_anchor).
      2. For STRICT: find the first event matching (event, where); count is
         enforced against `_count_matches` over the window AFTER the anchor
         is located (exact counts must equal; GTE accepts >=).
      3. For GROUP: all members must each find at least one match in the
         window; counts are enforced per member.
      4. NEG: count over the full trace must be 0.
      5. TERMINATOR: exactly one of (option_a, option_b) must appear in the
         post-final-STRICT window; the other must not.

    On mismatch we record into `out_of_order` / `missing` / `neg_violations`
    and continue so the report is exhaustive rather than first-fail.
    """

    def __init__(self, steps: list[TelemetryStep]):
        self.steps = list(steps)

    # -- public API ---------------------------------------------------------

    def check(self, trace: list[dict]) -> AssertionResult:
        result = AssertionResult()

        # Negative watches are evaluated against the full trace independently.
        self._check_neg(trace, result)

        # Walk through STRICT / GROUP / TERMINATOR with a moving cursor.
        cursor = 0
        i = 0
        steps = self.steps
        while i < len(steps):
            step = steps[i]
            if step.kind == KIND_NEG:
                i += 1
                continue

            if step.kind == KIND_STRICT:
                result.strict_total += 1
                cursor = self._check_strict(trace, step, cursor, result, step_index=i)
                i += 1
                continue

            if step.kind == KIND_GROUP:
                # Collect contiguous group steps for this group_id, then flush
                # all together. Groups can have multiple distinct group_ids
                # back-to-back; we only collect those that share THIS step's
                # group_id contiguously.
                group_id = step.group_id
                group_members: list[TelemetryStep] = []
                while i < len(steps) and steps[i].kind == KIND_GROUP and steps[i].group_id == group_id:
                    group_members.append(steps[i])
                    i += 1
                result.group_total += len(group_members)
                cursor = self._check_group(trace, group_members, cursor, result)
                continue

            if step.kind == KIND_TERMINATOR:
                self._check_terminator(trace, step, cursor, result)
                i += 1
                continue

            # Unknown kind — skip but flag.
            result.missing.append(f"unknown step kind: {step.kind} ({step.describe()})")
            i += 1

        result.passed = (
            not result.missing
            and not result.out_of_order
            and not result.neg_violations
            and result.strict_pass_count == result.strict_total
            and result.group_pass_count == result.group_total
        )

        result.summary = self._summary(result)
        return result

    # -- implementation -----------------------------------------------------

    def _check_neg(self, trace: list[dict], result: AssertionResult) -> None:
        for step in self.steps:
            if step.kind != KIND_NEG:
                continue
            hits = _count_matches(trace, step.event, step.where, 0, len(trace))
            if hits > 0:
                result.neg_violations.append(
                    f"{step.describe()}: expected 0 occurrences, found {hits}"
                )

    def _check_strict(
        self,
        trace: list[dict],
        step: TelemetryStep,
        cursor: int,
        result: AssertionResult,
        step_index: Optional[int] = None,
    ) -> int:
        mode, expected = _parse_count(step.count)
        # First, find the first match at or after the cursor.
        first_idx = _find_first_match(trace, step.event, step.where, cursor)
        if first_idx is None:
            # Could it be in the prefix (before cursor)? If yes, that means
            # the trace had it out of strict order.
            earlier = _find_first_match(trace, step.event, step.where, 0, cursor)
            if earlier is not None:
                result.out_of_order.append(
                    f"{step.describe()}: matching event appeared at index {earlier} BEFORE strict cursor {cursor}"
                )
            else:
                result.missing.append(
                    f"{step.describe()}: no matching event found from cursor {cursor}"
                )
            return cursor

        # Count occurrences within the window [cursor, next_strict_anchor).
        # The next strict anchor is the first match of the NEXT strict step
        # in self.steps; if none exists, the window runs to end-of-trace.
        # This windowing matches `_check_group`'s semantics and prevents a
        # later cycle's matching events (e.g. a second optimistic_insert
        # cycle in F1) from inflating the count of an earlier step that
        # shares the same event+predicate.
        if step_index is None:
            upper = len(trace)
        else:
            upper = self._next_strict_match_index_for(step_index, trace, cursor)
        actual = _count_matches(trace, step.event, step.where, cursor, upper)

        if mode == "exact" and actual != expected:
            # Distinguish "no match at all" vs "wrong count".
            if actual == 0:
                result.missing.append(
                    f"{step.describe()}: expected exactly {expected}, found 0"
                )
            else:
                result.out_of_order.append(
                    f"{step.describe()}: expected exactly {expected}, found {actual} in strict window [{cursor},{upper})"
                )
        elif mode == "gte" and actual < expected:
            result.missing.append(
                f"{step.describe()}: expected >= {expected}, found {actual} in strict window [{cursor},{upper})"
            )
        else:
            result.strict_pass_count += 1

        # Advance cursor past this strict's first match. Subsequent steps may
        # search at or after first_idx+1; this is what enforces ordering
        # between STRICT anchors.
        return first_idx + 1

    def _next_strict_match_index_for(
        self,
        current_index: int,
        trace: list[dict],
        cursor: int,
    ) -> int:
        """Find the trace index of the first match of the NEXT strict step
        after `current_index` in `self.steps`. Returns `len(trace)` if no
        further strict step exists or none of them match in the trace.

        This is used as the upper bound for a strict step's count window,
        ensuring that matches belonging to later cycles (which a later
        strict step anchors) are not attributed to this step.
        """
        for j in range(current_index + 1, len(self.steps)):
            nxt = self.steps[j]
            if nxt.kind == KIND_STRICT:
                idx = _find_first_match(trace, nxt.event, nxt.where, cursor)
                return idx if idx is not None else len(trace)
            if nxt.kind == KIND_TERMINATOR:
                # The terminator window starts AFTER the last strict; treat
                # the rest of the trace as this strict's count window.
                return len(trace)
            # GROUP / NEG steps don't anchor — keep scanning.
        return len(trace)

    def _check_group(
        self,
        trace: list[dict],
        members: list[TelemetryStep],
        cursor: int,
        result: AssertionResult,
    ) -> int:
        # The group's window extends from cursor to the next STRICT step's
        # FIRST match. To find that, peek ahead in self.steps. If none, the
        # window is the rest of the trace.
        next_strict_idx = self._next_strict_match_index(trace, cursor, members)
        upper = next_strict_idx if next_strict_idx is not None else len(trace)

        new_cursor = cursor
        for member in members:
            mode, expected = _parse_count(member.count)
            actual = _count_matches(trace, member.event, member.where, cursor, upper)
            if mode == "exact" and actual != expected:
                if actual == 0:
                    result.missing.append(
                        f"{member.describe()}: expected exactly {expected} in group window, found 0"
                    )
                else:
                    result.out_of_order.append(
                        f"{member.describe()}: expected exactly {expected} in group window, found {actual}"
                    )
                continue
            if mode == "gte" and actual < expected:
                result.missing.append(
                    f"{member.describe()}: expected >= {expected} in group window, found {actual}"
                )
                continue
            result.group_pass_count += 1
            # Track furthest matched event index so the cursor can advance.
            first_member_idx = _find_first_match(trace, member.event, member.where, cursor, upper)
            if first_member_idx is not None and first_member_idx + 1 > new_cursor:
                new_cursor = first_member_idx + 1

        return new_cursor if new_cursor > cursor else cursor

    def _next_strict_match_index(
        self,
        trace: list[dict],
        cursor: int,
        group_members: list[TelemetryStep],
    ) -> Optional[int]:
        """Find where the next STRICT step's first matching event lands in
        the trace, scanning self.steps after the group we just collected."""
        # Find position of the first member in self.steps so we can look past
        # the whole group.
        try:
            anchor = self.steps.index(group_members[0])
        except ValueError:
            return None
        for j in range(anchor + len(group_members), len(self.steps)):
            nxt = self.steps[j]
            if nxt.kind == KIND_STRICT:
                idx = _find_first_match(trace, nxt.event, nxt.where, cursor)
                return idx
            if nxt.kind == KIND_TERMINATOR:
                # Stop the group window at the trace end; the terminator
                # window starts AFTER the last strict step.
                return None
        return None

    def _check_terminator(
        self,
        trace: list[dict],
        step: TelemetryStep,
        cursor: int,
        result: AssertionResult,
    ) -> None:
        if not (step.option_a and step.option_b):
            result.missing.append(f"{step.describe()}: terminator missing options")
            return
        a_name, a_where = step.option_a
        b_name, b_where = step.option_b
        a_count = _count_matches(trace, a_name, a_where, cursor, len(trace))
        b_count = _count_matches(trace, b_name, b_where, cursor, len(trace))

        if a_count == 1 and b_count == 0:
            result.terminator_outcome = "A"
        elif b_count == 1 and a_count == 0:
            result.terminator_outcome = "B"
        else:
            result.missing.append(
                f"{step.describe()}: expected exactly one of {a_name} XOR {b_name} "
                f"in terminator window (cursor={cursor}), got a={a_count} b={b_count}"
            )

    def _summary(self, result: AssertionResult) -> str:
        parts = [
            f"{result.strict_pass_count}/{result.strict_total} strict",
            f"{result.group_pass_count}/{result.group_total} groups",
        ]
        if result.terminator_outcome:
            parts.append(f"terminator={result.terminator_outcome}")
        if not result.passed:
            failures = []
            if result.missing:
                failures.append(f"missing={len(result.missing)}")
            if result.out_of_order:
                failures.append(f"out_of_order={len(result.out_of_order)}")
            if result.neg_violations:
                failures.append(f"neg={len(result.neg_violations)}")
            if failures:
                parts.append("FAIL(" + ",".join(failures) + ")")
        return " + ".join(parts)


# ---------------------------------------------------------------------------
# Human-readable failure report
# ---------------------------------------------------------------------------


def format_failure_report(result: AssertionResult) -> str:
    lines = [f"AssertionResult: {result.summary}"]
    if result.terminator_outcome:
        lines.append(f"  terminator outcome: {result.terminator_outcome}")
    if result.missing:
        lines.append("  missing:")
        for m in result.missing:
            lines.append(f"    - {m}")
    if result.out_of_order:
        lines.append("  out_of_order:")
        for m in result.out_of_order:
            lines.append(f"    - {m}")
    if result.neg_violations:
        lines.append("  neg_violations:")
        for m in result.neg_violations:
            lines.append(f"    - {m}")
    if result.info:
        lines.append("  info:")
        for k, v in result.info.items():
            lines.append(f"    {k}: {v}")
    return "\n".join(lines)
