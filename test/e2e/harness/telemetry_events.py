"""Offline telemetry parsing over caller-supplied lines."""
from __future__ import annotations
import json
import re
import time
from dataclasses import dataclass

TELEMETRY_PREFIX = "[TELEMETRY]"


@dataclass
class TelemetryEvent:
    subsystem: str
    message: str
    bug_ref: str
    data: dict
    received_at: float
    raw: str

    def to_dict(self) -> dict:
        return {
            "subsystem": self.subsystem,
            "message": self.message,
            "bug_ref": self.bug_ref,
            "data": self.data,
            "received_at": self.received_at,
            "raw": self.raw,
        }


def _typescript_string_constants(text: str) -> dict[str, str]:
    constants = dict(re.findall(r"const\s+([A-Z0-9_]+)\s*=\s*'([^']*)';", text))
    join_re = re.compile(
        r"const\s+([A-Z0-9_]+)\s*=\s*\[(.*?)\]\.join\(\s*'([^']*)'\s*,?\s*\)",
        re.S,
    )
    for name, items_text, separator in join_re.findall(text):
        constants[name] = separator.join(re.findall(r"'([^']*)'", items_text))
    return constants


def _resolve_typescript_template(template: str, constants: dict[str, str]) -> str | None:
    unresolved = False

    def replace(match: re.Match) -> str:
        nonlocal unresolved
        name = match.group(1)
        if name not in constants:
            unresolved = True
            return match.group(0)
        return constants[name]

    resolved = re.sub(r"\$\{([A-Z0-9_]+)\}", replace, template)
    if unresolved or "${" in resolved:
        return None
    return resolved


def parse_telemetry_line(line: str) -> TelemetryEvent | None:
    if TELEMETRY_PREFIX not in line:
        return None
    payload_text = line.split(TELEMETRY_PREFIX, 1)[1].strip()
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    message = str(payload.get("message") or "")
    if not message:
        return None
    data = payload.get("data")
    return TelemetryEvent(
        subsystem=str(payload.get("subsystem") or message.split(":", 1)[0]),
        message=message,
        bug_ref=str(payload.get("bug_ref") or ""),
        data=data if isinstance(data, dict) else {},
        received_at=time.monotonic(),
        raw=line.rstrip("\n"),
    )
