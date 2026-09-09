"""Small per-run JSON state store used by synthetic mobile examples.

The store keeps seeded stream identifiers and owned-session metadata in a caller
provided directory. Writes use a same-directory temporary file followed by an
atomic rename, so tests can exercise persistence without a remote dependency.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


STATE_FILE = "seeded.json"
OWNED_FILE = "owned_sessions.json"


def state_path(run_id: str, state_dir: Optional[str] = None) -> Path:
    base = Path(state_dir) if state_dir else Path(f"/tmp/example-mobile-state-{run_id}")
    return base / STATE_FILE


def owned_sessions_path(run_id: str, state_dir: Optional[str] = None) -> Path:
    base = Path(state_dir) if state_dir else Path(f"/tmp/example-mobile-state-{run_id}")
    return base / OWNED_FILE


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.rename(tmp_name, path)
    except Exception:
        # On failure, clean up the tmp file if it still exists.
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def save_seeded_stream(
    run_id: str,
    host: str,
    provider: str,
    stream_id: str,
    state_dir: Optional[str] = None,
) -> Path:
    """Save a seeded stream_id keyed by (host, provider).

    Existing entries for other hosts/providers are preserved (merge, not
    overwrite). Returns the final path written.
    """
    path = state_path(run_id, state_dir)
    payload = _load(path)
    host_map = payload.setdefault(host, {})
    host_map[provider] = {
        "stream_id": stream_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write(path, payload)
    return path


def load_seeded_stream(
    run_id: str,
    host: str,
    provider: str,
    state_dir: Optional[str] = None,
) -> Optional[str]:
    """Return the seeded stream_id for (host, provider) or None.

    Returns None for any of:
      - missing state directory
      - missing state file
      - host or provider key absent
      - malformed payload
    """
    path = state_path(run_id, state_dir)
    payload = _load(path)
    host_map = payload.get(host) or {}
    entry = host_map.get(provider)
    if not isinstance(entry, dict):
        return None
    sid = entry.get("stream_id")
    return str(sid) if sid else None


def save_owned_session(
    run_id: str,
    stream_id: str,
    host: str,
    session_name: str,
    source: str,
    state_dir: Optional[str] = None,
) -> Path:
    """Record a test-created chat session for later cleanup.

    Record metadata for a session created by the current synthetic run. The
    operation is keyed by stream_id and is idempotent.
    """
    path = owned_sessions_path(run_id, state_dir)
    payload = _load(path)
    sessions = payload.setdefault("sessions", {})
    changed = False
    if stream_id not in sessions:
        sessions[stream_id] = {
            "run_id": run_id,
            "stream_id": stream_id,
            "host": host,
            "session_name": session_name,
            "source": source,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        changed = True
    elif isinstance(sessions[stream_id], dict) and not sessions[stream_id].get("run_id"):
        sessions[stream_id]["run_id"] = run_id
        changed = True
    if changed:
        _atomic_write(path, payload)
    return path


def save_spawned_sessions_from_events(
    run_id: str,
    events: list[object],
    scenario_id: str,
    state_dir: Optional[str] = None,
) -> list[str]:
    """Record every chat identified by a synthetic spawn event."""
    if not run_id:
        return []
    recorded: list[str] = []
    for event in events:
        if getattr(event, "message", None) != "harness:spawn_chat_then_send_sent":
            continue
        data = getattr(event, "data", None)
        stream_id = str(data.get("stream_id") or "") if isinstance(data, dict) else ""
        if ":" not in stream_id:
            continue
        host, session_name = stream_id.split(":", 1)
        if not host or not session_name:
            continue
        save_owned_session(
            run_id,
            stream_id,
            host,
            session_name,
            f"runner:{scenario_id}",
            state_dir=state_dir,
        )
        if stream_id not in recorded:
            recorded.append(stream_id)
    return recorded


def load_owned_sessions(
    run_id: str,
    state_dir: Optional[str] = None,
) -> list[dict]:
    """Return all recorded sessions for the run."""
    path = owned_sessions_path(run_id, state_dir)
    payload = _load(path)
    sessions = payload.get("sessions") or {}
    if not isinstance(sessions, dict):
        return []
    return [entry for entry in sessions.values() if isinstance(entry, dict)]


def clear_owned_sessions(
    run_id: str,
    state_dir: Optional[str] = None,
    stream_ids: Optional[list[str]] = None,
) -> Path:
    """Remove recorded sessions after the example has finished.

    Pass `stream_ids` to clear specific sessions; omit to clear all.
    """
    path = owned_sessions_path(run_id, state_dir)
    payload = _load(path)
    sessions = payload.get("sessions") or {}
    if not isinstance(sessions, dict):
        sessions = {}
    if stream_ids is None:
        sessions = {}
    else:
        for sid in stream_ids:
            sessions.pop(sid, None)
    payload["sessions"] = sessions
    _atomic_write(path, payload)
    return path

