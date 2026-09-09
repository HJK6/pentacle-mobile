from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable

from .log_capture import LogStream, TelemetryEvent


@dataclass
class EventSpec:
    message: str
    where: dict | None = None
    timeout_s: float = 30.0


@dataclass
class StepResult:
    expected: EventSpec
    event: TelemetryEvent | None
    elapsed_s: float

    @property
    def passed(self) -> bool:
        return self.event is not None

    def to_dict(self) -> dict:
        return {
            "expected_message": self.expected.message,
            "where": self.expected.where,
            "timeout_s": self.expected.timeout_s,
            "passed": self.passed,
            "elapsed_s": self.elapsed_s,
            "event": self.event.to_dict() if self.event else None,
        }


@dataclass
class NegativeWatchResult:
    names: list[str]
    fired: list[TelemetryEvent] = field(default_factory=list)
    window_s: float = 0.0

    @property
    def passed(self) -> bool:
        return not self.fired

    def to_dict(self) -> dict:
        return {
            "names": self.names,
            "passed": self.passed,
            "window_s": self.window_s,
            "fired": [event.to_dict() for event in self.fired],
        }


@dataclass
class Verdict:
    name: str
    verdict: str
    steps: list[StepResult] = field(default_factory=list)
    negative_watches: list[NegativeWatchResult] = field(default_factory=list)
    error: str | None = None
    extras: dict = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    finished_at: float = 0.0

    def fold_negative_watch(self, result: NegativeWatchResult) -> None:
        self.negative_watches.append(result)
        if not result.passed:
            self.verdict = "FAIL"
            names = ", ".join(event.message for event in result.fired)
            self.error = f"deny-listed telemetry fired: {names}"

    def finish(self) -> "Verdict":
        self.finished_at = time.time()
        return self

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "verdict": self.verdict,
            "error": self.error,
            "extras": self.extras,
            "started_at": self.started_at,
            "finished_at": self.finished_at or time.time(),
            "duration_s": (self.finished_at or time.time()) - self.started_at,
            "steps": [step.to_dict() for step in self.steps],
            "negative_watches": [watch.to_dict() for watch in self.negative_watches],
        }


DEFAULT_DENY_LIST = [
    "error_boundary_caught",
    "user_facing_error_alert",
    "chat:ws_auth_error",
    "chat:render_error",
]


def _matches(event: TelemetryEvent, spec: EventSpec) -> bool:
    if event.message != spec.message:
        return False
    if not spec.where:
        return True
    for key, expected in spec.where.items():
        if event.data.get(key) != expected:
            return False
    return True


def await_event(
    stream: LogStream,
    spec: EventSpec,
    not_before: float | None = None,
    abort_spec: EventSpec | None = None,
) -> TelemetryEvent | None:
    deadline = time.monotonic() + spec.timeout_s
    cutoff = not_before or 0.0
    for event in stream.all_events():
        if abort_spec and event.received_at >= cutoff and _matches(event, abort_spec):
            return event
        if event.received_at >= cutoff and _matches(event, spec):
            return event
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.5, deadline - time.monotonic()))
        if event and abort_spec and event.received_at >= cutoff and _matches(event, abort_spec):
            return event
        if event and event.received_at >= cutoff and _matches(event, spec):
            return event
    return None


def assert_sequence(
    stream: LogStream,
    specs: list[EventSpec],
    name: str,
    abort_spec: EventSpec | None = None,
) -> Verdict:
    verdict = Verdict(name=name, verdict="PASS")
    cutoff: float | None = None
    for spec in specs:
        step_started = time.monotonic()
        event = await_event(stream, spec, not_before=cutoff, abort_spec=abort_spec)
        elapsed = time.monotonic() - step_started
        verdict.steps.append(StepResult(expected=spec, event=event, elapsed_s=elapsed))
        if event is not None and abort_spec and _matches(event, abort_spec):
            verdict.verdict = "FAIL"
            verdict.error = f"observed {abort_spec.message!r} before {spec.message!r}"
            verdict.extras["abort_event"] = event.to_dict()
            return verdict.finish()
        if event is None:
            verdict.verdict = "FAIL"
            verdict.error = f"missing event {spec.message!r} after {spec.timeout_s}s"
            return verdict.finish()
        cutoff = event.received_at
    return verdict.finish()


def assert_no_events(
    stream: LogStream,
    names: list[str] | None = None,
    window_s: float = 2.0,
    predicate: Callable[[TelemetryEvent], bool] | None = None,
) -> NegativeWatchResult:
    watched = names or DEFAULT_DENY_LIST
    deadline = time.monotonic() + window_s
    fired: list[TelemetryEvent] = []
    while time.monotonic() < deadline:
        event = stream.next_event(timeout_s=min(0.25, deadline - time.monotonic()))
        if not event:
            continue
        if event.message in watched or (predicate and predicate(event)):
            fired.append(event)
    return NegativeWatchResult(names=watched, fired=fired, window_s=window_s)
