"""Offline timer-label analysis over explicitly supplied files."""
from __future__ import annotations
import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DOCK_LABEL_EVENT = "harness:dock_label_render"


@dataclass(frozen=True)
class TimerPoint:
    ts: float
    stream_id: str
    elapsed_seconds: int
    elapsed_ms: int | None
    label: str = ""


@dataclass(frozen=True)
class RenderPoint:
    ts: float
    stream_id: str
    elapsed_seconds: int | None
    label: str
    component_key: str = ""


@dataclass(frozen=True)
class TimelineRow:
    daemon: TimerPoint
    render: RenderPoint | None
    status: str
    latency_ms: int | None = None


@dataclass(frozen=True)
class RenderAnomaly:
    render: RenderPoint
    status: str
    expected_elapsed_seconds: int | None


@dataclass
class DiffReport:
    scenario: str
    stream_id: str | None
    daemon_points: list[TimerPoint]
    render_points: list[RenderPoint]
    timeline: list[TimelineRow]
    render_anomalies: list[RenderAnomaly]
    max_latency_ms: int | None
    max_allowed_latency_ms: int
    scenario_exit_code: int | None = None
    scenario_stdout: str = ""
    scenario_stderr: str = ""
    daemon_log_path: Path | None = None
    mobile_run_json_path: Path | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        if self.scenario_exit_code not in (None, 0):
            return False
        if not self.daemon_points or not self.render_points:
            return False
        if self.render_anomalies:
            return False
        return all(row.status == "rendered" for row in self.timeline)


def parse_daemon_log(path: Path, stream_id: str | None = None) -> list[TimerPoint]:
    points: list[TimerPoint] = []
    last_elapsed_by_stream: dict[str, int] = {}
    if not path.exists():
        return points
    with path.open("r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: invalid daemon observer JSON: {exc}") from exc
            kind = str(row.get("kind") or "")
            payload = row.get("raw_payload") if isinstance(row.get("raw_payload"), dict) else {}
            if kind != "working.state" and payload.get("type") != "working.state":
                continue
            candidate_stream = _string(row.get("stream_id")) or _string(payload.get("stream_id"))
            if not candidate_stream or (stream_id and candidate_stream != stream_id):
                continue
            elapsed_ms = _int(payload.get("elapsed_ms"))
            if elapsed_ms is None:
                elapsed_ms = _int(row.get("elapsed_ms"))
            if elapsed_ms is None:
                continue
            elapsed_seconds = max(0, elapsed_ms // 1000)
            if last_elapsed_by_stream.get(candidate_stream) == elapsed_seconds:
                continue
            last_elapsed_by_stream[candidate_stream] = elapsed_seconds
            points.append(
                TimerPoint(
                    ts=_float(row.get("timestamp_observer_monotonic")) or 0.0,
                    stream_id=candidate_stream,
                    elapsed_seconds=elapsed_seconds,
                    elapsed_ms=elapsed_ms,
                    label=_string(payload.get("working_label")) or "",
                )
            )
    return sorted(points, key=lambda point: point.ts)


def parse_mobile_run_json(path: Path, stream_id: str | None = None) -> list[RenderPoint]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    events = payload.get("all_events")
    if not isinstance(events, list):
        return []
    points: list[RenderPoint] = []
    for event in events:
        if not isinstance(event, dict) or event.get("message") != DOCK_LABEL_EVENT:
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        candidate_stream = _string(data.get("stream_id"))
        if not candidate_stream or (stream_id and candidate_stream != stream_id):
            continue
        points.append(
            RenderPoint(
                ts=_float(event.get("received_at")) or _float(data.get("timestamp_observer_monotonic")) or 0.0,
                stream_id=candidate_stream,
                elapsed_seconds=_int(data.get("elapsed_seconds")),
                label=_string(data.get("label")) or "",
                component_key=_string(data.get("component_key")) or "",
            )
        )
    return sorted(points, key=lambda point: point.ts)


def infer_stream_id(daemon_points: list[TimerPoint], render_points: list[RenderPoint]) -> str | None:
    render_streams = [point.stream_id for point in render_points]
    daemon_streams = [point.stream_id for point in daemon_points]
    for candidate in render_streams:
        if candidate in daemon_streams:
            return candidate
    if render_streams:
        return render_streams[0]
    if daemon_streams:
        return daemon_streams[0]
    return None


def build_diff(
    *,
    scenario: str,
    daemon_points: list[TimerPoint],
    render_points: list[RenderPoint],
    max_allowed_latency_ms: int,
    scenario_exit_code: int | None = None,
    scenario_stdout: str = "",
    scenario_stderr: str = "",
    daemon_log_path: Path | None = None,
    mobile_run_json_path: Path | None = None,
    notes: list[str] | None = None,
) -> DiffReport:
    stream_id = infer_stream_id(daemon_points, render_points)
    if stream_id:
        daemon_points = [point for point in daemon_points if point.stream_id == stream_id]
        render_points = [point for point in render_points if point.stream_id == stream_id]

    unused_renders = list(render_points)
    timeline: list[TimelineRow] = []
    latencies: list[int] = []
    for daemon in daemon_points:
        match = None
        for render in unused_renders:
            if render.ts < daemon.ts:
                continue
            if render.elapsed_seconds == daemon.elapsed_seconds:
                match = render
                break
        if match is None:
            timeline.append(TimelineRow(daemon=daemon, render=None, status="missing_render"))
            continue
        unused_renders.remove(match)
        latency_ms = max(0, round((match.ts - daemon.ts) * 1000))
        latencies.append(latency_ms)
        status = "rendered" if latency_ms <= max_allowed_latency_ms else "late_render"
        timeline.append(TimelineRow(daemon=daemon, render=match, status=status, latency_ms=latency_ms))

    render_anomalies = find_render_anomalies(daemon_points, render_points)
    return DiffReport(
        scenario=scenario,
        stream_id=stream_id,
        daemon_points=daemon_points,
        render_points=render_points,
        timeline=timeline,
        render_anomalies=render_anomalies,
        max_latency_ms=max(latencies) if latencies else None,
        max_allowed_latency_ms=max_allowed_latency_ms,
        scenario_exit_code=scenario_exit_code,
        scenario_stdout=scenario_stdout,
        scenario_stderr=scenario_stderr,
        daemon_log_path=daemon_log_path,
        mobile_run_json_path=mobile_run_json_path,
        notes=notes or [],
    )


def find_render_anomalies(
    daemon_points: list[TimerPoint],
    render_points: list[RenderPoint],
) -> list[RenderAnomaly]:
    anomalies: list[RenderAnomaly] = []
    daemon_sorted = sorted(daemon_points, key=lambda point: point.ts)
    for render in sorted(render_points, key=lambda point: point.ts):
        previous = None
        for daemon in daemon_sorted:
            if daemon.ts <= render.ts:
                previous = daemon
            else:
                break
        if previous is None:
            anomalies.append(
                RenderAnomaly(
                    render=render,
                    status="unbacked_render",
                    expected_elapsed_seconds=None,
                )
            )
        elif render.elapsed_seconds != previous.elapsed_seconds:
            anomalies.append(
                RenderAnomaly(
                    render=render,
                    status="stale_render",
                    expected_elapsed_seconds=previous.elapsed_seconds,
                )
            )
    return anomalies


def render_markdown(report: DiffReport) -> str:
    verdict = "PASS" if report.passed else "FAIL"
    lines = [
        f"# Timer Label Diff: {verdict}",
        "",
        f"- scenario: `{report.scenario}`",
        f"- stream_id: `{report.stream_id or 'unknown'}`",
        f"- max_latency_ms: `{report.max_latency_ms if report.max_latency_ms is not None else 'n/a'}`",
        f"- max_allowed_latency_ms: `{report.max_allowed_latency_ms}`",
    ]
    if report.scenario_exit_code is not None:
        lines.append(f"- scenario_exit_code: `{report.scenario_exit_code}`")
    if report.daemon_log_path:
        lines.append(f"- daemon_log: `{report.daemon_log_path}`")
    if report.mobile_run_json_path:
        lines.append(f"- mobile_run_json: `{report.mobile_run_json_path}`")
    for note in report.notes:
        lines.append(f"- note: {note}")

    lines.extend(
        [
            "",
            "## Timeline",
            "",
            "| daemon_t+ms | stream | daemon_elapsed_s | view_elapsed_s | view_label | latency_ms | status |",
            "|---:|---|---:|---:|---|---:|---|",
        ]
    )
    origin = min([point.ts for point in report.daemon_points + report.render_points], default=0.0)
    if report.timeline:
        for row in report.timeline:
            daemon_offset = round((row.daemon.ts - origin) * 1000)
            render_elapsed = "" if row.render is None or row.render.elapsed_seconds is None else str(row.render.elapsed_seconds)
            label = "" if row.render is None else _md(row.render.label)
            latency = "" if row.latency_ms is None else str(row.latency_ms)
            lines.append(
                "| "
                f"{daemon_offset} | `{row.daemon.stream_id}` | {row.daemon.elapsed_seconds} | "
                f"{render_elapsed} | {label} | {latency} | `{row.status}` |"
            )
    else:
        lines.append("|  |  |  |  |  |  | `no_daemon_timer_points` |")

    if report.render_anomalies:
        lines.extend(
            [
                "",
                "## Render Anomalies",
                "",
                "| render_t+ms | stream | expected_daemon_elapsed_s | view_elapsed_s | view_label | status |",
                "|---:|---|---:|---:|---|---|",
            ]
        )
        for anomaly in report.render_anomalies:
            render_offset = round((anomaly.render.ts - origin) * 1000)
            expected = "" if anomaly.expected_elapsed_seconds is None else str(anomaly.expected_elapsed_seconds)
            actual = "" if anomaly.render.elapsed_seconds is None else str(anomaly.render.elapsed_seconds)
            lines.append(
                "| "
                f"{render_offset} | `{anomaly.render.stream_id}` | {expected} | {actual} | "
                f"{_md(anomaly.render.label)} | `{anomaly.status}` |"
            )

    if report.scenario_stdout.strip() or report.scenario_stderr.strip():
        lines.extend(["", "## Scenario Output", ""])
        if report.scenario_stdout.strip():
            lines.extend(["```text", report.scenario_stdout.strip(), "```"])
        if report.scenario_stderr.strip():
            lines.extend(["```text", report.scenario_stderr.strip(), "```"])

    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "- `missing_render`: the daemon timer changed, but no matching dock label render was observed.",
            "- `late_render`: the matching dock label render arrived after the latency budget.",
            "- `stale_render`: the view rendered an elapsed value different from the latest daemon timer.",
            "- `unbacked_render`: the view rendered before any daemon timer existed for the stream.",
            "",
        ]
    )
    return "\n".join(lines)


def render_from_paths(
    *,
    args: argparse.Namespace,
    daemon_log: Path,
    mobile_json: Path,
    scenario_exit_code: int | None,
    scenario_stdout: str = "",
    scenario_stderr: str = "",
) -> int:
    daemon_points = parse_daemon_log(daemon_log, stream_id=args.stream_id)
    render_points = parse_mobile_run_json(mobile_json, stream_id=args.stream_id)
    notes = []
    if not daemon_points:
        notes.append("No daemon working.state timer changes were observed.")
    if not render_points:
        notes.append("No harness:dock_label_render events were observed.")
    report = build_diff(
        scenario=args.scenario,
        daemon_points=daemon_points,
        render_points=render_points,
        max_allowed_latency_ms=args.max_latency_ms,
        scenario_exit_code=scenario_exit_code,
        scenario_stdout=scenario_stdout,
        scenario_stderr=scenario_stderr,
        daemon_log_path=daemon_log,
        mobile_run_json_path=mobile_json,
        notes=notes,
    )
    markdown = render_markdown(report)
    if args.output_md:
        args.output_md.parent.mkdir(parents=True, exist_ok=True)
        args.output_md.write_text(markdown, encoding="utf-8")
    print(markdown)
    if scenario_exit_code not in (None, 0):
        return scenario_exit_code if scenario_exit_code in (1, 4) else 1
    return 0 if report.passed else 1


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return None
    return None


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _string(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")

