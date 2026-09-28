"""Crash-safe progress snapshots and active-run discovery for ``all-flows``."""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import math
import os
import re
import socket
import stat
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
APP_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
RFC3339_MS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SNAPSHOT_TEMP_RE = re.compile(r"^[1-9]\d*\.[1-9]\d*\.[0-9a-f]{32}\.snapshot\.tmp$")
TICKET_TEMP_RE = re.compile(r"^\.([A-Za-z0-9][A-Za-z0-9._-]{0,79})\.([1-9]\d*)\.([0-9a-f]{32})\.ticket\.tmp$")
TICKET_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]{0,79})\.json$")

SNAPSHOT_FIELDS = {
    "schema_version", "run_id", "suite", "phase", "status", "started_at",
    "updated_at", "heartbeat_at", "elapsed_ms", "sequence", "completed",
    "total", "percent_complete", "current_scenario",
    "current_scenario_started_at", "pass", "fail", "setup_fail", "skipped",
    "waived", "source_commit", "app_sha256", "host", "simulator_ownership",
    "exit_code", "interruption_reason", "telemetry_error_code",
    "estimated_ms_remaining",
}
TICKET_FIELDS = {
    "schema_version", "run_id", "owner_pid", "repo", "sha", "host", "stage",
    "suite", "started_at", "progress_file",
}
VERDICT_FIELDS = ("pass", "fail", "setup_fail", "skipped", "waived")
PHASE_RANK = {"initializing": 0, "preflight": 1, "running": 2, "teardown": 3, "terminal": 4}
TELEMETRY_CODES = {
    "none", "lock_contended", "unsafe_path", "write_failed", "registry_busy",
    "registry_conflict", "registry_full", "registry_invalid",
    "registry_write_failed",
}
_READER_BARRIER: Callable[[str, "SecurePath", int | None], None] = lambda _point, _path, _fd: None
_REGISTRY_BARRIER: Callable[[str, "ActiveRegistry"], None] = lambda _point, _registry: None
_STABLE_BARRIER: Callable[[str, object, str, int], None] = lambda _point, _path, _name, _fd: None


class TelemetryFailure(RuntimeError):
    def __init__(self, code: str, *, post_rename: bool = False) -> None:
        self.code = code
        self.post_rename = post_rename
        super().__init__(code)


class ReaderFailure(RuntimeError):
    def __init__(self, exit_code: int, message: str) -> None:
        self.exit_code = exit_code
        self.message = message
        super().__init__(message)


def _caused_by(error: BaseException, kind: type[BaseException]) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None:
        if id(current) in seen:
            return False
        seen.add(id(current))
        if isinstance(current, kind):
            return True
        current = current.__cause__ or current.__context__
    return False


def is_safe_id(value: object) -> bool:
    return isinstance(value, str) and SAFE_ID_RE.fullmatch(value) is not None


def _reject_constants(_value: str) -> None:
    raise ValueError("invalid numeric constant")


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def canonical_bytes(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8") + b"\n"
    except (TypeError, ValueError, UnicodeError) as exc:
        raise TelemetryFailure("write_failed") from exc
    return encoded


def decode_canonical(data: bytes, *, max_bytes: int) -> Any:
    if len(data) > max_bytes or not data.endswith(b"\n") or data.startswith(b"\xef\xbb\xbf"):
        raise TelemetryFailure("registry_invalid")
    try:
        text = data.decode("utf-8")
        value = json.loads(
            text, object_pairs_hook=_pairs_no_duplicates, parse_constant=_reject_constants,
        )
    except (UnicodeError, ValueError, TypeError) as exc:
        raise TelemetryFailure("registry_invalid") from exc
    if canonical_bytes(value) != data:
        raise TelemetryFailure("registry_invalid")
    return value


def percent_complete(completed: int, total: int, terminal_success: bool = False) -> int | float:
    if total == 0:
        return 100 if terminal_success else 0
    hundredths = (completed * 10000 * 2 + total) // (2 * total)
    if hundredths % 100 == 0:
        return hundredths // 100
    return hundredths / 100


def utc_ms(epoch: float) -> str:
    milliseconds = int(math.floor(epoch * 1000.0 + 0.5))
    seconds, millis = divmod(milliseconds, 1000)
    base = datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z"


def _parse_utc_ms(value: object) -> datetime:
    if not isinstance(value, str) or RFC3339_MS_RE.fullmatch(value) is None:
        raise TelemetryFailure("registry_invalid")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise TelemetryFailure("registry_invalid") from exc


def _plain_int(value: object, *, positive: bool = False) -> bool:
    return type(value) is int and value >= (1 if positive else 0)


def validate_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SNAPSHOT_FIELDS:
        raise TelemetryFailure("registry_invalid")
    if value["schema_version"] != 1 or not is_safe_id(value["run_id"]):
        raise TelemetryFailure("registry_invalid")
    if value["suite"] != "all-flows":
        raise TelemetryFailure("registry_invalid")
    if value["phase"] not in {"initializing", "preflight", "running", "teardown", "terminal"}:
        raise TelemetryFailure("registry_invalid")
    if value["status"] not in {"running", "passed", "failed", "interrupted", "telemetry_error"}:
        raise TelemetryFailure("registry_invalid")
    timestamps = [_parse_utc_ms(value[name]) for name in ("started_at", "updated_at", "heartbeat_at")]
    if timestamps[0] > timestamps[1] or timestamps[1] != timestamps[2]:
        raise TelemetryFailure("registry_invalid")
    for name in ("elapsed_ms", "sequence", "completed", "total", *VERDICT_FIELDS):
        if not _plain_int(value[name], positive=name == "sequence"):
            raise TelemetryFailure("registry_invalid")
    if value["completed"] > value["total"] or sum(value[name] for name in VERDICT_FIELDS) != value["completed"]:
        raise TelemetryFailure("registry_invalid")
    expected_percent = percent_complete(
        value["completed"], value["total"],
        value["phase"] == "terminal" and value["status"] == "passed",
    )
    if type(value["percent_complete"]) is not type(expected_percent):
        raise TelemetryFailure("registry_invalid")
    if value["percent_complete"] != expected_percent:
        raise TelemetryFailure("registry_invalid")
    current = value["current_scenario"]
    current_at = value["current_scenario_started_at"]
    if (current is None) != (current_at is None):
        raise TelemetryFailure("registry_invalid")
    if current is not None:
        if value["phase"] != "running" or not isinstance(current, str):
            raise TelemetryFailure("registry_invalid")
        try:
            current_size = len(current.encode("utf-8"))
        except UnicodeError as exc:
            raise TelemetryFailure("registry_invalid") from exc
        if not (1 <= current_size <= 256) or any(
            unicodedata.category(char).startswith("C") for char in current
        ):
            raise TelemetryFailure("registry_invalid")
        _parse_utc_ms(current_at)
    source_commit = value["source_commit"]
    if source_commit is not None and (not isinstance(source_commit, str) or SHA_RE.fullmatch(source_commit) is None):
        raise TelemetryFailure("registry_invalid")
    app_sha = value["app_sha256"]
    if app_sha is not None and (not isinstance(app_sha, str) or APP_SHA_RE.fullmatch(app_sha) is None):
        raise TelemetryFailure("registry_invalid")
    if not is_safe_id(value["host"]) or value["simulator_ownership"] not in {"runner_owned", "none"}:
        raise TelemetryFailure("registry_invalid")
    if value["interruption_reason"] not in {"none", "sigint", "sigterm"}:
        raise TelemetryFailure("registry_invalid")
    if value["telemetry_error_code"] not in TELEMETRY_CODES:
        raise TelemetryFailure("registry_invalid")
    eta = value["estimated_ms_remaining"]
    if eta is not None and not _plain_int(eta):
        raise TelemetryFailure("registry_invalid")
    if value["phase"] != "terminal":
        if value["status"] != "running" or value["exit_code"] is not None:
            raise TelemetryFailure("registry_invalid")
        if value["interruption_reason"] != "none" or value["telemetry_error_code"] != "none":
            raise TelemetryFailure("registry_invalid")
    else:
        if current is not None or value["completed"] != value["total"] or type(value["exit_code"]) is not int:
            raise TelemetryFailure("registry_invalid")
        terminal = (value["status"], value["exit_code"], value["interruption_reason"], value["telemetry_error_code"])
        valid = (
            terminal == ("passed", 0, "none", "none")
            or (terminal[0] == "failed" and terminal[1] not in {0, 74, 130, 143} and terminal[2:] == ("none", "none"))
            or terminal == ("interrupted", 130, "sigint", "none")
            or terminal == ("interrupted", 143, "sigterm", "none")
            or (terminal[0] == "telemetry_error" and terminal[1] == 74 and terminal[2] == "none" and terminal[3] != "none")
        )
        if not valid:
            raise TelemetryFailure("registry_invalid")
    return value


def validate_ticket(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != TICKET_FIELDS:
        raise TelemetryFailure("registry_invalid")
    if value["schema_version"] != 1 or not is_safe_id(value["run_id"]):
        raise TelemetryFailure("registry_invalid")
    if not _plain_int(value["owner_pid"], positive=True) or value["repo"] != "pentacle-mobile":
        raise TelemetryFailure("registry_invalid")
    if not isinstance(value["sha"], str) or SHA_RE.fullmatch(value["sha"]) is None:
        raise TelemetryFailure("registry_invalid")
    if not is_safe_id(value["host"]) or value["stage"] != "sim-e2e" or value["suite"] != "all-flows":
        raise TelemetryFailure("registry_invalid")
    _parse_utc_ms(value["started_at"])
    if value["progress_file"] != f"progress/{value['run_id']}.json":
        raise TelemetryFailure("registry_invalid")
    return value


def lexical_path_is_safe(raw: str) -> bool:
    if not raw or "\x00" in raw:
        return False
    components = raw.split(os.sep)
    if os.path.isabs(raw):
        components = components[1:]
    return bool(components) and all(component not in {"", ".", ".."} for component in components)


def _same_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _safe_directory_metadata(info: os.stat_result, *, mutable: bool) -> bool:
    owner_ok = info.st_uid == os.geteuid() if mutable else info.st_uid in {0, os.geteuid()}
    if not (stat.S_ISDIR(info.st_mode) and owner_ok):
        return False
    if not (info.st_mode & 0o022):
        return True
    # A group/other-writable ANCESTOR is acceptable only when it is sticky
    # (S_ISVTX) — e.g. /tmp and /private/tmp (mode 1777): the sticky bit forbids
    # other users renaming or deleting our files, so telemetry-artifact integrity
    # holds. The leaf (mutable) directory the harness creates and writes into must
    # still be strictly non-other-writable.
    return (not mutable) and bool(info.st_mode & stat.S_ISVTX)


class SecurePath:
    """A destination resolved once through retained no-follow directory fds."""

    def __init__(
        self,
        path: os.PathLike[str] | str,
        *,
        create_parents: bool = False,
        anchor_fd: int | None = None,
        anchor_display: os.PathLike[str] | str | None = None,
    ) -> None:
        raw = os.fspath(path)
        if not lexical_path_is_safe(raw):
            raise TelemetryFailure("unsafe_path")
        self.raw = raw
        self.absolute_display = (
            os.path.abspath(raw)
            if os.path.isabs(raw) or anchor_display is None
            else os.path.abspath(os.path.join(os.fspath(anchor_display), raw))
        )
        self.name = raw.rstrip(os.sep).split(os.sep)[-1]
        directory_raw = os.path.dirname(raw) or "."
        absolute = os.path.isabs(raw)
        components = [part for part in directory_raw.split(os.sep) if part]
        anchor_name = os.sep if absolute else "."
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        try:
            anchor = os.open(
                anchor_name,
                flags,
                **({"dir_fd": anchor_fd} if not absolute and anchor_fd is not None else {}),
            )
        except OSError as exc:
            raise TelemetryFailure("unsafe_path") from exc
        self._fds: list[int] = [anchor]
        self._names: list[str] = []
        self._identities: list[os.stat_result] = [os.fstat(anchor)]
        created_directories: list[tuple[int, str, os.stat_result]] = []
        try:
            if not _safe_directory_metadata(self._identities[0], mutable=False):
                raise TelemetryFailure("unsafe_path")
            self._reject_syncthing(anchor)
            current = anchor
            for index, component in enumerate(components):
                try:
                    child = os.open(component, flags, dir_fd=current)
                except FileNotFoundError:
                    if not create_parents:
                        raise
                    self._verify_prefix()
                    os.mkdir(component, 0o700, dir_fd=current)
                    created_info = os.stat(component, dir_fd=current, follow_symlinks=False)
                    if not _safe_directory_metadata(created_info, mutable=True):
                        raise TelemetryFailure("unsafe_path")
                    created_directories.append((current, component, created_info))
                    self._verify_prefix()
                    os.fsync(current)
                    child = os.open(component, flags, dir_fd=current)
                info = os.fstat(child)
                if not _safe_directory_metadata(info, mutable=index == len(components) - 1):
                    os.close(child)
                    raise TelemetryFailure("unsafe_path")
                self._fds.append(child)
                self._names.append(component)
                self._identities.append(info)
                self._reject_syncthing(child)
                current = child
            if not _safe_directory_metadata(self._identities[-1], mutable=True):
                raise TelemetryFailure("unsafe_path")
            self.verify()
        except BaseException:
            for parent_fd, name, created_info in reversed(created_directories):
                try:
                    current_info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    if _same_inode(current_info, created_info):
                        os.rmdir(name, dir_fd=parent_fd)
                        os.fsync(parent_fd)
                except OSError:
                    pass
            self.close()
            raise TelemetryFailure("unsafe_path")

    @staticmethod
    def _reject_syncthing(fd: int) -> None:
        try:
            os.stat(".stfolder", dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise TelemetryFailure("unsafe_path") from exc
        raise TelemetryFailure("unsafe_path")

    def _verify_prefix(self) -> None:
        for index, name in enumerate(self._names, start=1):
            current = os.stat(name, dir_fd=self._fds[index - 1], follow_symlinks=False)
            if not _same_inode(current, self._identities[index]):
                raise TelemetryFailure("unsafe_path")
            if not _safe_directory_metadata(current, mutable=False):
                raise TelemetryFailure("unsafe_path")

    @property
    def parent_fd(self) -> int:
        return self._fds[-1]

    def verify_through(self, limit: int) -> None:
        if not (0 <= limit < len(self._fds)):
            raise TelemetryFailure("unsafe_path")
        for index, name in enumerate(self._names[:limit], start=1):
            current = os.stat(name, dir_fd=self._fds[index - 1], follow_symlinks=False)
            if not _same_inode(current, self._identities[index]):
                raise TelemetryFailure("unsafe_path")
            if not _safe_directory_metadata(current, mutable=index == limit):
                raise TelemetryFailure("unsafe_path")
        current_parent = os.fstat(self._fds[limit])
        if not _same_inode(current_parent, self._identities[limit]):
            raise TelemetryFailure("unsafe_path")

    def verify(self) -> None:
        self.verify_through(len(self._fds) - 1)

    def parent_view(self, name: str, *, levels: int = 1) -> RetainedPath:
        index = len(self._fds) - 1 - levels
        return RetainedPath(self, index, name)

    def lstat(self, name: str | None = None) -> os.stat_result:
        return os.stat(name or self.name, dir_fd=self.parent_fd, follow_symlinks=False)

    def close(self) -> None:
        for fd in reversed(getattr(self, "_fds", [])):
            try:
                os.close(fd)
            except OSError:
                pass
        self._fds = []


class RetainedPath:
    """A file name rooted in a retained prefix of an existing secure walk."""

    def __init__(self, source: SecurePath, directory_index: int, name: str) -> None:
        if not lexical_path_is_safe(name) or os.sep in name:
            raise TelemetryFailure("unsafe_path")
        self.source = source
        self.directory_index = directory_index
        self.name = name
        directory_display = os.path.dirname(source.absolute_display)
        for _ in range(len(source._fds) - 1 - directory_index):
            directory_display = os.path.dirname(directory_display)
        self.absolute_display = os.path.join(directory_display, name)

    @property
    def parent_fd(self) -> int:
        return self.source._fds[self.directory_index]

    def verify(self) -> None:
        self.source.verify_through(self.directory_index)

    def lstat(self, name: str | None = None) -> os.stat_result:
        return os.stat(name or self.name, dir_fd=self.parent_fd, follow_symlinks=False)

    def with_name(self, name: str) -> RetainedPath:
        return RetainedPath(self.source, self.directory_index, name)

    def close(self) -> None:
        return


def _validate_regular(info: os.stat_result, *, max_size: int, allow_unlinked: bool = False) -> None:
    links = {0, 1} if allow_unlinked else {1}
    if (
        not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink not in links
        or info.st_size > max_size
    ):
        raise TelemetryFailure("registry_invalid")


def _stable_open(path: SecurePath, name: str, *, create: bool, code: str) -> int:
    flags = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    path.verify()
    created = False
    try:
        if create:
            try:
                fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=path.parent_fd)
                created = True
            except FileExistsError:
                fd = os.open(name, flags, dir_fd=path.parent_fd)
        else:
            fd = os.open(name, flags, dir_fd=path.parent_fd)
        if created:
            os.fchmod(fd, 0o600)
        info = os.fstat(fd)
        _validate_regular(info, max_size=65536)
        before = path.lstat(name)
        if not _same_inode(info, before):
            raise TelemetryFailure(code)
        path.verify()
        return fd
    except BaseException as exc:
        if created and "fd" in locals():
            try:
                current = path.lstat(name)
                if _same_inode(os.fstat(fd), current):
                    os.unlink(name, dir_fd=path.parent_fd)
                    os.fsync(path.parent_fd)
            except OSError:
                pass
        if "fd" in locals():
            os.close(fd)
        if isinstance(exc, TelemetryFailure):
            raise TelemetryFailure(code) from exc
        raise TelemetryFailure(code) from exc


def _acquire_flock(fd: int, timeout: float, code: str) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TelemetryFailure(code)
            time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))


def _verify_fd_path(
    path: SecurePath | RetainedPath,
    name: str,
    fd: int,
    code: str,
    *,
    max_size: int = 65536,
) -> os.stat_result:
    path.verify()
    descriptor = os.fstat(fd)
    target = path.lstat(name)
    try:
        _validate_regular(descriptor, max_size=max_size)
        _validate_regular(target, max_size=max_size)
    except TelemetryFailure as exc:
        raise TelemetryFailure(code) from exc
    if not _same_inode(descriptor, target):
        raise TelemetryFailure(code)
    path.verify()
    return descriptor


class AtomicProgressWriter:
    def __init__(
        self,
        destination: os.PathLike[str] | str,
        *,
        fault_injector: Callable[[str], None] | None = None,
        lock_timeout: float = 0.0,
        anchor_fd: int | None = None,
        anchor_display: os.PathLike[str] | str | None = None,
        retained_path: RetainedPath | None = None,
    ) -> None:
        self.secure = retained_path or SecurePath(
            destination,
            create_parents=True,
            anchor_fd=anchor_fd,
            anchor_display=anchor_display,
        )
        self.destination = Path(self.secure.absolute_display)
        self.fault_injector = fault_injector or (lambda _point: None)
        self.lock_name = f"{self.secure.name}.lock"
        self.lock_fd = -1
        self.temp_fd = -1
        self.temp_dir_path = self.destination.parent / (
            ".pentacle-walk-snapshot-tmp-"
            + hashlib.sha256(self.secure.absolute_display.encode("utf-8")).hexdigest()
        )
        self.temp_name = self.temp_dir_path.name
        self._write_failed = False
        self._closed = False
        try:
            self.lock_fd = _stable_open(self.secure, self.lock_name, create=True, code="unsafe_path")
            before = _verify_fd_path(self.secure, self.lock_name, self.lock_fd, "unsafe_path")
            _acquire_flock(self.lock_fd, lock_timeout, "lock_contended")
            after = _verify_fd_path(self.secure, self.lock_name, self.lock_fd, "unsafe_path")
            if not _same_inode(before, after):
                raise TelemetryFailure("unsafe_path")
            self._open_temp_directory()
            self._cleanup_orphans()
        except BaseException:
            self.close()
            raise

    def _open_temp_directory(self) -> None:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        self.secure.verify()
        created_info: os.stat_result | None = None
        try:
            self.temp_fd = os.open(self.temp_name, flags, dir_fd=self.secure.parent_fd)
        except FileNotFoundError:
            os.mkdir(self.temp_name, 0o700, dir_fd=self.secure.parent_fd)
            created_info = self.secure.lstat(self.temp_name)
            try:
                self.secure.verify()
            except TelemetryFailure:
                try:
                    current = self.secure.lstat(self.temp_name)
                    if _same_inode(current, created_info):
                        os.rmdir(self.temp_name, dir_fd=self.secure.parent_fd)
                        os.fsync(self.secure.parent_fd)
                except OSError:
                    pass
                raise
            os.fsync(self.secure.parent_fd)
            self.temp_fd = os.open(self.temp_name, flags, dir_fd=self.secure.parent_fd)
        info = os.fstat(self.temp_fd)
        target = self.secure.lstat(self.temp_name)
        if (
            not _same_inode(info, target) or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise TelemetryFailure("unsafe_path")
        self.secure.verify()

    def _verify_temp_dir(self) -> None:
        self.secure.verify()
        info = os.fstat(self.temp_fd)
        target = self.secure.lstat(self.temp_name)
        if (
            not _same_inode(info, target)
            or not stat.S_ISDIR(info.st_mode)
            or not stat.S_ISDIR(target.st_mode)
            or info.st_uid != os.geteuid()
            or target.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
            or stat.S_IMODE(target.st_mode) != 0o700
        ):
            raise TelemetryFailure("write_failed")
        self.secure.verify()

    def _cleanup_orphans(self) -> None:
        entries = sorted(os.listdir(self.temp_fd), key=os.fsencode)
        if len(entries) > 32 or any(SNAPSHOT_TEMP_RE.fullmatch(name) is None for name in entries):
            raise TelemetryFailure("write_failed")
        for name in entries:
            fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0), dir_fd=self.temp_fd)
            try:
                info = os.fstat(fd)
                _validate_regular(info, max_size=65536)
                current = os.stat(name, dir_fd=self.temp_fd, follow_symlinks=False)
                if not _same_inode(info, current):
                    raise TelemetryFailure("write_failed")
                self._verify_temp_dir()
                os.unlink(name, dir_fd=self.temp_fd)
                self._verify_temp_dir()
                os.fsync(self.temp_fd)
            finally:
                os.close(fd)

    def _temp_matches(self, name: str, fd: int) -> bool:
        try:
            return _same_inode(os.fstat(fd), os.stat(name, dir_fd=self.temp_fd, follow_symlinks=False))
        except OSError:
            return False

    def publish(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        if self._closed or self._write_failed:
            raise TelemetryFailure("write_failed", post_rename=self._write_failed)
        validate_snapshot(snapshot)
        payload = canonical_bytes(snapshot)
        if len(payload) > 65536:
            raise TelemetryFailure("write_failed")
        sequence = snapshot["sequence"]
        temp_name = f"{os.getpid()}.{sequence}.{os.urandom(16).hex()}.snapshot.tmp"
        temp_file = -1
        renamed = False
        try:
            self.secure.verify(); self._verify_temp_dir()
            self.fault_injector("before_snapshot_temp_open")
            self.secure.verify(); self._verify_temp_dir()
            temp_file = os.open(
                temp_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=self.temp_fd,
            )
            os.fchmod(temp_file, 0o600)
            self.fault_injector("after_snapshot_temp_open")
            self.secure.verify(); self._verify_temp_dir()
            _validate_regular(os.fstat(temp_file), max_size=65536)
            view = memoryview(payload)
            while view:
                written = os.write(temp_file, view)
                if written <= 0:
                    raise OSError(errno.EIO, "write")
                view = view[written:]
            os.fsync(temp_file)
            self.fault_injector("after_snapshot_temp_fsync")
            self.secure.verify(); self._verify_temp_dir()
            current = os.stat(temp_name, dir_fd=self.temp_fd, follow_symlinks=False)
            if not _same_inode(os.fstat(temp_file), current):
                raise TelemetryFailure("write_failed")
            try:
                previous = self.secure.lstat()
            except FileNotFoundError:
                previous = None
            if previous is not None:
                _validate_regular(previous, max_size=65536)
            self.fault_injector("before_snapshot_rename")
            self.secure.verify(); self._verify_temp_dir()
            os.rename(
                temp_name, self.secure.name,
                src_dir_fd=self.temp_fd, dst_dir_fd=self.secure.parent_fd,
            )
            renamed = True
            self.fault_injector("after_snapshot_rename")
            self.secure.verify(); self._verify_temp_dir()
            self.fault_injector("before_temp_dir_fsync")
            self.secure.verify(); self._verify_temp_dir()
            os.fsync(self.temp_fd)
            self.fault_injector("after_temp_dir_fsync")
            self.secure.verify(); self._verify_temp_dir()
            self.fault_injector("before_destination_dir_fsync")
            self.secure.verify(); self._verify_temp_dir()
            os.fsync(self.secure.parent_fd)
            self.fault_injector("after_destination_dir_fsync")
            self.secure.verify(); self._verify_temp_dir()
            self.fault_injector("before_snapshot_final_observation")
            self.secure.verify(); self._verify_temp_dir()
            visible = self.secure.lstat()
            _validate_regular(visible, max_size=65536)
            if not _same_inode(os.fstat(temp_file), visible):
                raise TelemetryFailure("write_failed", post_rename=True)
            self.fault_injector("after_snapshot_final_observation")
            self.secure.verify(); self._verify_temp_dir()
            visible = self.secure.lstat()
            _validate_regular(visible, max_size=65536)
            if not _same_inode(os.fstat(temp_file), visible):
                raise TelemetryFailure("write_failed", post_rename=True)
            self.secure.verify()
            return snapshot
        except BaseException as exc:
            if renamed:
                self._write_failed = True
                for fd in (self.temp_fd, self.secure.parent_fd):
                    try:
                        os.fsync(fd)
                    except OSError:
                        pass
                raise TelemetryFailure("write_failed", post_rename=True) from exc
            if temp_file >= 0 and self._temp_matches(temp_name, temp_file):
                try:
                    os.unlink(temp_name, dir_fd=self.temp_fd)
                    os.fsync(self.temp_fd)
                except OSError:
                    pass
            if isinstance(exc, TelemetryFailure):
                raise TelemetryFailure("write_failed") from exc
            raise TelemetryFailure("write_failed") from exc
        finally:
            if temp_file >= 0:
                os.close(temp_file)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for fd_name in ("temp_fd", "lock_fd"):
            fd = getattr(self, fd_name, -1)
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, fd_name, -1)
        if hasattr(self, "secure"):
            self.secure.close()

    def __enter__(self) -> AtomicProgressWriter:
        return self

    def __exit__(self, _kind: object, _value: object, _traceback: object) -> None:
        self.close()


class ProgressCoordinator:
    def __init__(
        self,
        writer: AtomicProgressWriter,
        *,
        run_id: str,
        total: int,
        source_commit: str | None,
        app_sha256: str | None,
        host: str,
        simulator_ownership: str,
        wall_clock: Callable[[], float] = time.time,
        monotonic_clock: Callable[[], float] = time.monotonic,
        after_initial: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        if not is_safe_id(run_id) or not _plain_int(total):
            raise TelemetryFailure("unsafe_path")
        self.writer = writer
        self._wall_clock = wall_clock
        self._monotonic_clock = monotonic_clock
        self._lock = threading.RLock()
        self._started_mono = monotonic_clock()
        self._last_wall = wall_clock()
        self._after_initial = after_initial
        self._initial_published = False
        self._terminal = False
        self._failure: TelemetryFailure | None = None
        started_at = utc_ms(self._last_wall)
        self._state: dict[str, Any] = {
            "schema_version": 1,
            "run_id": run_id,
            "suite": "all-flows",
            "phase": "initializing",
            "status": "running",
            "started_at": started_at,
            "updated_at": started_at,
            "heartbeat_at": started_at,
            "elapsed_ms": 0,
            "sequence": 0,
            "completed": 0,
            "total": total,
            "percent_complete": percent_complete(0, total),
            "current_scenario": None,
            "current_scenario_started_at": None,
            "pass": 0,
            "fail": 0,
            "setup_fail": 0,
            "skipped": 0,
            "waived": 0,
            "source_commit": source_commit,
            "app_sha256": app_sha256,
            "host": host,
            "simulator_ownership": simulator_ownership,
            "exit_code": None,
            "interruption_reason": "none",
            "telemetry_error_code": "none",
            "estimated_ms_remaining": None,
        }

    @property
    def failure(self) -> TelemetryFailure | None:
        with self._lock:
            return self._failure

    @property
    def terminal_committed(self) -> bool:
        with self._lock:
            return self._terminal

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def _publish(self, changes: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._terminal or self._failure is not None:
            raise self._failure or TelemetryFailure("write_failed")
        candidate = dict(self._state)
        if changes:
            candidate.update(changes)
        if PHASE_RANK[candidate["phase"]] < PHASE_RANK[self._state["phase"]]:
            raise TelemetryFailure("write_failed")
        if candidate["completed"] < self._state["completed"] or any(
            candidate[name] < self._state[name] for name in VERDICT_FIELDS
        ):
            raise TelemetryFailure("write_failed")
        now = max(self._last_wall, self._wall_clock())
        self._last_wall = now
        stamp = utc_ms(now)
        candidate["updated_at"] = stamp
        candidate["heartbeat_at"] = stamp
        candidate["elapsed_ms"] = max(
            0, int((self._monotonic_clock() - self._started_mono) * 1000.0 + 0.5),
        )
        candidate["sequence"] = self._state["sequence"] + 1
        candidate["percent_complete"] = percent_complete(
            candidate["completed"], candidate["total"],
            candidate["phase"] == "terminal" and candidate["status"] == "passed",
        )
        try:
            self.writer.publish(candidate)
        except TelemetryFailure as exc:
            self._failure = exc
            if exc.post_rename:
                self._state = candidate
            raise
        self._state = candidate
        return dict(candidate)

    def emit_initial(self) -> dict[str, Any]:
        with self._lock:
            if self._initial_published:
                raise TelemetryFailure("write_failed")
            result = self._publish()
            self._initial_published = True
            if self._after_initial is not None:
                try:
                    self._after_initial(result)
                except TelemetryFailure as exc:
                    self._failure = exc
                    raise
            return result

    def set_phase(self, phase: str) -> dict[str, Any]:
        if phase not in {"preflight", "running", "teardown"}:
            raise TelemetryFailure("write_failed")
        with self._lock:
            return self._publish({"phase": phase})

    def set_provenance(
        self,
        *,
        app_sha256: str | None = None,
        simulator_ownership: str | None = None,
    ) -> dict[str, Any]:
        changes: dict[str, Any] = {}
        if app_sha256 is not None:
            changes["app_sha256"] = app_sha256
        if simulator_ownership is not None:
            changes["simulator_ownership"] = simulator_ownership
        with self._lock:
            return self._publish(changes)

    def scenario_started(self, scenario: str) -> dict[str, Any]:
        if not isinstance(scenario, str) or not (1 <= len(scenario.encode("utf-8")) <= 256):
            raise TelemetryFailure("write_failed")
        with self._lock:
            now = max(self._last_wall, self._wall_clock())
            return self._publish({
                "phase": "running",
                "current_scenario": scenario,
                "current_scenario_started_at": utc_ms(now),
            })

    def scenario_completed(self, verdict: str) -> dict[str, Any]:
        mapping = {
            "PASS": "pass", "FAIL": "fail", "SETUP_FAIL": "setup_fail",
            "SKIPPED": "skipped", "WAIVED": "waived",
        }
        if verdict not in mapping:
            raise TelemetryFailure("write_failed")
        with self._lock:
            if self._state["completed"] >= self._state["total"]:
                raise TelemetryFailure("write_failed")
            field = mapping[verdict]
            return self._publish({
                "phase": "running",
                "current_scenario": None,
                "current_scenario_started_at": None,
                "completed": self._state["completed"] + 1,
                field: self._state[field] + 1,
            })

    def heartbeat(self) -> dict[str, Any]:
        with self._lock:
            return self._publish()

    def materialize_skipped(self) -> dict[str, Any] | None:
        last: dict[str, Any] | None = None
        with self._lock:
            while self._state["completed"] < self._state["total"]:
                last = self.scenario_completed("SKIPPED")
        return last

    def terminal(
        self,
        status: str,
        exit_code: int,
        *,
        interruption_reason: str = "none",
        telemetry_error_code: str = "none",
    ) -> dict[str, Any]:
        with self._lock:
            if self._failure is not None:
                raise self._failure
            remaining = self._state["total"] - self._state["completed"]
            result = self._publish({
                "phase": "terminal",
                "status": status,
                "current_scenario": None,
                "current_scenario_started_at": None,
                "completed": self._state["total"],
                "skipped": self._state["skipped"] + remaining,
                "exit_code": exit_code,
                "interruption_reason": interruption_reason,
                "telemetry_error_code": telemetry_error_code,
            })
            self._terminal = True
            return result

    def terminal_telemetry_error(self, code: str) -> dict[str, Any] | None:
        with self._lock:
            failure = self._failure
            if failure is None:
                failure = TelemetryFailure(code)
            if failure.post_rename:
                return None
            self._failure = None
            remaining = self._state["total"] - self._state["completed"]
            try:
                result = self._publish({
                    "phase": "terminal",
                    "status": "telemetry_error",
                    "current_scenario": None,
                    "current_scenario_started_at": None,
                    "completed": self._state["total"],
                    "skipped": self._state["skipped"] + remaining,
                    "exit_code": 74,
                    "interruption_reason": "none",
                    "telemetry_error_code": code,
                })
            except TelemetryFailure:
                return None
            self._terminal = True
            return result


class HeartbeatPublisher:
    def __init__(
        self,
        coordinator: ProgressCoordinator,
        *,
        interval: float = 15.0,
        abort_event: threading.Event | None = None,
    ) -> None:
        self.coordinator = coordinator
        self.interval = interval
        self.stop_event = threading.Event()
        self.failure_event = threading.Event()
        self.abort_event = abort_event
        self.thread = threading.Thread(target=self._run, name="pentacle-progress-heartbeat", daemon=True)

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                self.coordinator.heartbeat()
            except TelemetryFailure:
                self.failure_event.set()
                if self.abort_event is not None:
                    self.abort_event.set()
                self.stop_event.set()
                return

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join()


def _read_fd(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit + 1
    while remaining > 0:
        chunk = os.read(fd, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > limit:
        raise TelemetryFailure("registry_invalid")
    return data


def _read_opened_value(
    path: SecurePath,
    name: str,
    *,
    max_bytes: int,
    validator: Callable[[Any], dict[str, Any]],
) -> tuple[dict[str, Any], bytes]:
    path.verify()
    _READER_BARRIER("before_open", path, None)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0), dir_fd=path.parent_fd)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise TelemetryFailure("registry_invalid") from exc
    try:
        _READER_BARRIER("after_open", path, fd)
        opened = os.fstat(fd)
        _validate_regular(opened, max_size=max_bytes, allow_unlinked=True)
        data = _read_fd(fd, max_bytes)
        value = validator(decode_canonical(data, max_bytes=max_bytes))
        _READER_BARRIER("before_final_observation", path, fd)
        path.verify()
        _READER_BARRIER("after_pre_observation_verify", path, fd)
        descriptor = os.fstat(fd)
        _validate_regular(descriptor, max_size=max_bytes, allow_unlinked=True)
        _READER_BARRIER("between_final_fstat_lstat", path, fd)
        try:
            observed = path.lstat(name)
        except FileNotFoundError:
            observed = None
        if observed is not None:
            _validate_regular(observed, max_size=max_bytes)
        _READER_BARRIER("after_observation", path, fd)
        path.verify()
        descriptor = os.fstat(fd)
        _validate_regular(descriptor, max_size=max_bytes, allow_unlinked=True)
        try:
            observed = path.lstat(name)
        except FileNotFoundError:
            observed = None
        if observed is not None:
            _validate_regular(observed, max_size=max_bytes)
        _READER_BARRIER("after_final_validation", path, fd)
        if descriptor.st_nlink == 1 and observed is not None and _same_inode(descriptor, observed):
            return value, data
        if descriptor.st_nlink == 0 and (observed is None or not _same_inode(descriptor, observed)):
            return value, data
        if descriptor.st_nlink == 1 and (observed is None or not _same_inode(descriptor, observed)):
            descriptor = os.fstat(fd)
            _validate_regular(descriptor, max_size=max_bytes, allow_unlinked=True)
            try:
                confirmed = path.lstat(name)
            except FileNotFoundError:
                confirmed = None
            if confirmed is not None:
                _validate_regular(confirmed, max_size=max_bytes)
            path.verify()
            if descriptor.st_nlink == 0 and (confirmed is None or not _same_inode(descriptor, confirmed)):
                return value, data
        raise TelemetryFailure("registry_invalid")
    finally:
        os.close(fd)


def read_progress(
    *,
    progress_file: os.PathLike[str] | str | None = None,
    runs_dir: os.PathLike[str] | str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    if (progress_file is None) == (runs_dir is None) or (runs_dir is not None and not is_safe_id(run_id)):
        raise ReaderFailure(2, "progress_usage")
    target = os.fspath(progress_file) if progress_file is not None else os.path.join(os.fspath(runs_dir), "progress", f"{run_id}.json")
    if not lexical_path_is_safe(target):
        raise ReaderFailure(2, "progress_usage")
    try:
        secure = SecurePath(target, create_parents=False)
    except TelemetryFailure as exc:
        if _caused_by(exc, FileNotFoundError):
            raise ReaderFailure(4, "progress_absent") from exc
        raise ReaderFailure(5, "progress_invalid") from exc
    try:
        try:
            value, _data = _read_opened_value(secure, secure.name, max_bytes=65536, validator=validate_snapshot)
        except FileNotFoundError as exc:
            raise ReaderFailure(4, "progress_absent") from exc
        except TelemetryFailure as exc:
            raise ReaderFailure(5, "progress_invalid") from exc
        if run_id is not None and value["run_id"] != run_id:
            raise ReaderFailure(5, "progress_invalid")
        return value
    finally:
        secure.close()


def _open_ticket(active: SecurePath, name: str) -> tuple[int, dict[str, Any]]:
    active.verify()
    try:
        fd = os.open(name, os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0), dir_fd=active.parent_fd)
    except OSError as exc:
        raise TelemetryFailure("registry_invalid") from exc
    try:
        info = os.fstat(fd)
        _validate_regular(info, max_size=4096)
        current = active.lstat(name)
        if not _same_inode(info, current):
            raise TelemetryFailure("registry_invalid")
        data = _read_fd(fd, 4096)
        ticket = validate_ticket(decode_canonical(data, max_bytes=4096))
        _verify_fd_path(active, name, fd, "registry_invalid", max_size=4096)
        return fd, ticket
    except BaseException:
        os.close(fd)
        raise


def _try_probe(fd: int) -> bool:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


@dataclass
class _TicketProbe:
    name: str
    ticket: dict[str, Any]
    ticket_fd: int
    destination_path: RetainedPath
    destination_fd: int
    ticket_acquired: bool
    destination_acquired: bool

    def close(self) -> None:
        for fd in (self.ticket_fd, self.destination_fd):
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        self.destination_path.close()


def _probe_ticket(active: SecurePath, name: str) -> _TicketProbe:
    ticket_fd, ticket = _open_ticket(active, name)
    destination_path: RetainedPath | None = None
    destination_fd = -1
    try:
        destination_path = active.parent_view(f"{ticket['run_id']}.json.lock")
        destination_fd = _stable_open(
            destination_path, destination_path.name, create=False, code="registry_invalid",
        )
        destination_before = _verify_fd_path(
            destination_path, destination_path.name, destination_fd, "registry_invalid",
        )
        _STABLE_BARRIER(
            "before_destination_probe", destination_path, destination_path.name, destination_fd,
        )
        destination_acquired = _try_probe(destination_fd)
        _STABLE_BARRIER(
            "after_destination_probe", destination_path, destination_path.name, destination_fd,
        )
        destination_after = _verify_fd_path(
            destination_path, destination_path.name, destination_fd, "registry_invalid",
        )
        if not _same_inode(destination_before, destination_after):
            raise TelemetryFailure("registry_invalid")
        ticket_before = _verify_fd_path(
            active, name, ticket_fd, "registry_invalid", max_size=4096,
        )
        _STABLE_BARRIER("before_ticket_probe", active, name, ticket_fd)
        ticket_acquired = _try_probe(ticket_fd)
        _STABLE_BARRIER("after_ticket_probe", active, name, ticket_fd)
        ticket_after = _verify_fd_path(
            active, name, ticket_fd, "registry_invalid", max_size=4096,
        )
        if not _same_inode(ticket_before, ticket_after):
            raise TelemetryFailure("registry_invalid")
        return _TicketProbe(
            name, ticket, ticket_fd, destination_path, destination_fd,
            ticket_acquired, destination_acquired,
        )
    except BaseException:
        try:
            os.close(ticket_fd)
        except OSError:
            pass
        if destination_fd >= 0:
            os.close(destination_fd)
        if destination_path is not None:
            destination_path.close()
        raise


_ACTIVE_PATH_CACHE_LOCK = threading.RLock()
_ACTIVE_PATH_CACHE: dict[str, tuple[SecurePath, int]] = {}


def _acquire_active_path(path: str, *, create: bool) -> tuple[SecurePath, str | None]:
    if not os.path.isabs(path):
        return SecurePath(path, create_parents=create), None
    key = os.path.abspath(path)
    with _ACTIVE_PATH_CACHE_LOCK:
        cached = _ACTIVE_PATH_CACHE.get(key)
        if cached is not None:
            secure, references = cached
            secure.verify()
            _ACTIVE_PATH_CACHE[key] = (secure, references + 1)
            return secure, key
        secure = SecurePath(path, create_parents=create)
        _ACTIVE_PATH_CACHE[key] = (secure, 1)
        return secure, key


def _release_active_path(secure: SecurePath, key: str | None) -> None:
    if key is None:
        secure.close()
        return
    with _ACTIVE_PATH_CACHE_LOCK:
        cached, references = _ACTIVE_PATH_CACHE[key]
        if cached is not secure:
            raise TelemetryFailure("registry_invalid")
        if references == 1:
            del _ACTIVE_PATH_CACHE[key]
            secure.close()
        else:
            _ACTIVE_PATH_CACHE[key] = (secure, references - 1)


class ActiveRegistry:
    def __init__(
        self,
        runs_dir: os.PathLike[str] | str,
        *,
        create: bool,
        anchor_fd: int | None = None,
        anchor_display: os.PathLike[str] | str | None = None,
    ) -> None:
        self.runs_dir = os.fspath(runs_dir)
        active_path = os.path.join(self.runs_dir, "progress", "active", ".registry.lock")
        self._active_cache_key: str | None = None
        if anchor_fd is None and anchor_display is None:
            self.active, self._active_cache_key = _acquire_active_path(active_path, create=create)
        else:
            self.active = SecurePath(
                active_path,
                create_parents=create,
                anchor_fd=anchor_fd,
                anchor_display=anchor_display,
            )
        self.lock_fd = -1
        self.ticket_fd = -1
        self.ticket_name: str | None = None
        self.prepared_run_id: str | None = None
        try:
            self.lock_fd = _stable_open(
                self.active, ".registry.lock", create=create, code="registry_invalid",
            )
        except BaseException:
            self.close()
            raise

    def acquire(self, *, writer: bool) -> None:
        before = _verify_fd_path(self.active, ".registry.lock", self.lock_fd, "registry_invalid")
        _REGISTRY_BARRIER("before_registry_flock", self)
        _acquire_flock(self.lock_fd, 5.0 if writer else 1.0, "registry_busy" if writer else "reader_busy")
        _REGISTRY_BARRIER("after_registry_flock", self)
        after = _verify_fd_path(self.active, ".registry.lock", self.lock_fd, "registry_invalid")
        if not _same_inode(before, after):
            raise TelemetryFailure("registry_invalid")

    def release(self) -> None:
        if self.lock_fd >= 0:
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass

    def _entries(self) -> list[str]:
        self.active.verify()
        entries = sorted(os.listdir(self.active.parent_fd), key=os.fsencode)
        if len(entries) > 64:
            raise TelemetryFailure("registry_full")
        return entries

    def _cleanup_ticket_temp(self, name: str) -> None:
        match = TICKET_TEMP_RE.fullmatch(name)
        if match is None:
            raise TelemetryFailure("registry_invalid")
        fd = os.open(name, os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0), dir_fd=self.active.parent_fd)
        try:
            info = os.fstat(fd)
            _validate_regular(info, max_size=4096)
            if not _try_probe(fd):
                raise TelemetryFailure("registry_invalid")
            self.active.verify()
            current = self.active.lstat(name)
            if not _same_inode(info, current):
                raise TelemetryFailure("registry_invalid")
            os.unlink(name, dir_fd=self.active.parent_fd)
            self.active.verify()
            os.fsync(self.active.parent_fd)
        finally:
            os.close(fd)

    def scan(
        self,
        *,
        reap_dead: bool,
        observe: Callable[[_TicketProbe], None] | None = None,
    ) -> tuple[list[dict[str, Any]], int]:
        tickets: list[dict[str, Any]] = []
        ignored_dead = 0
        entries = self._entries()
        for name in entries:
            if name == ".registry.lock":
                continue
            if TICKET_TEMP_RE.fullmatch(name):
                if not reap_dead:
                    raise TelemetryFailure("registry_invalid")
                self._cleanup_ticket_temp(name)
                continue
            match = TICKET_RE.fullmatch(name)
            if match is None or not is_safe_id(match.group(1)):
                raise TelemetryFailure("registry_invalid")
            probe = _probe_ticket(self.active, name)
            try:
                if probe.ticket["run_id"] != match.group(1):
                    raise TelemetryFailure("registry_invalid")
                if probe.destination_acquired != probe.ticket_acquired:
                    raise TelemetryFailure("registry_invalid")
                if probe.destination_acquired:
                    ignored_dead += 1
                    if reap_dead:
                        _verify_fd_path(
                            self.active, name, probe.ticket_fd, "registry_invalid", max_size=4096,
                        )
                        _verify_fd_path(
                            probe.destination_path,
                            probe.destination_path.name,
                            probe.destination_fd,
                            "registry_invalid",
                        )
                        self.active.verify()
                        os.unlink(name, dir_fd=self.active.parent_fd)
                        self.active.verify()
                        os.fsync(self.active.parent_fd)
                else:
                    if observe is not None:
                        observe(probe)
                    tickets.append(probe.ticket)
            finally:
                probe.close()
        if len(tickets) > 16:
            raise TelemetryFailure("registry_full")
        return tickets, ignored_dead

    def publish(self, ticket: dict[str, Any]) -> None:
        validate_ticket(ticket)
        self.acquire(writer=True)
        try:
            tickets, _ignored = self.scan(reap_dead=True)
            self._validate_new_owner(ticket["run_id"], tickets)
            self._publish_under_lock(ticket)
        finally:
            self.release()

    def progress_path(self, name: str) -> RetainedPath:
        return self.active.parent_view(name)

    @staticmethod
    def _validate_new_owner(run_id: str, tickets: list[dict[str, Any]]) -> None:
        if any(ticket["run_id"] == run_id for ticket in tickets):
            raise TelemetryFailure("registry_conflict")
        if len(tickets) >= 16:
            raise TelemetryFailure("registry_full")

    def prepare(self, run_id: str) -> None:
        self.acquire(writer=True)
        try:
            tickets, _ignored = self.scan(reap_dead=True)
            self._validate_new_owner(run_id, tickets)
            self.prepared_run_id = run_id
        except BaseException:
            self.release()
            raise

    def publish_prepared(self, ticket: dict[str, Any]) -> None:
        if self.prepared_run_id != ticket.get("run_id"):
            raise TelemetryFailure("registry_invalid")
        try:
            self._publish_under_lock(ticket)
        finally:
            self.prepared_run_id = None
            self.release()

    def _publish_under_lock(self, ticket: dict[str, Any]) -> None:
        validate_ticket(ticket)
        payload = canonical_bytes(ticket)
        if len(payload) > 4096:
            raise TelemetryFailure("registry_write_failed")
        temp_fd = -1
        temp_name = f".{ticket['run_id']}.{os.getpid()}.{os.urandom(16).hex()}.ticket.tmp"
        renamed = False
        final_name = f"{ticket['run_id']}.json"
        try:
            self.active.verify()
            temp_fd = os.open(
                temp_name,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=self.active.parent_fd,
            )
            os.fchmod(temp_fd, 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(temp_fd, view)
                if written <= 0:
                    raise OSError(errno.EIO, "write")
                view = view[written:]
            os.fsync(temp_fd)
            fcntl.flock(temp_fd, fcntl.LOCK_EX)
            _REGISTRY_BARRIER("after_ticket_temp_lock", self)
            current = self.active.lstat(temp_name)
            if not _same_inode(os.fstat(temp_fd), current):
                raise TelemetryFailure("registry_write_failed")
            self.active.verify()
            os.rename(temp_name, final_name, src_dir_fd=self.active.parent_fd, dst_dir_fd=self.active.parent_fd)
            renamed = True
            self.active.verify()
            os.fsync(self.active.parent_fd)
            _verify_fd_path(
                self.active, final_name, temp_fd, "registry_write_failed", max_size=4096,
            )
            self.ticket_fd = temp_fd
            self.ticket_name = final_name
            temp_fd = -1
        except TelemetryFailure:
            raise
        except OSError as exc:
            raise TelemetryFailure("registry_write_failed") from exc
        finally:
            if temp_fd >= 0:
                candidate = final_name if renamed else temp_name
                try:
                    current = self.active.lstat(candidate)
                    if _same_inode(os.fstat(temp_fd), current):
                        os.unlink(candidate, dir_fd=self.active.parent_fd)
                        os.fsync(self.active.parent_fd)
                except OSError:
                    pass
                os.close(temp_fd)

    def remove_owned_ticket(self) -> None:
        if self.ticket_fd < 0 or self.ticket_name is None:
            return
        try:
            self.acquire(writer=True)
            try:
                _verify_fd_path(
                    self.active,
                    self.ticket_name,
                    self.ticket_fd,
                    "registry_invalid",
                    max_size=4096,
                )
                self.active.verify()
                os.unlink(self.ticket_name, dir_fd=self.active.parent_fd)
                self.active.verify()
                os.fsync(self.active.parent_fd)
            finally:
                self.release()
        except TelemetryFailure:
            raise
        except OSError as exc:
            raise TelemetryFailure("registry_write_failed") from exc
        finally:
            try:
                os.close(self.ticket_fd)
            except OSError:
                pass
            self.ticket_fd = -1

    def close(self) -> None:
        if self.prepared_run_id is not None:
            self.prepared_run_id = None
            self.release()
        if self.ticket_fd >= 0:
            try:
                os.close(self.ticket_fd)
            except OSError:
                pass
            self.ticket_fd = -1
        if self.lock_fd >= 0:
            try:
                os.close(self.lock_fd)
            except OSError:
                pass
            self.lock_fd = -1
        if hasattr(self, "active"):
            _release_active_path(self.active, self._active_cache_key)
            del self.active


def _ticket_matches_snapshot(ticket: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    return (
        ticket["schema_version"] == snapshot["schema_version"]
        and ticket["run_id"] == snapshot["run_id"]
        and ticket["suite"] == snapshot["suite"]
        and ticket["host"] == snapshot["host"]
        and ticket["started_at"] == snapshot["started_at"]
        and ticket["sha"] == snapshot["source_commit"]
        and ticket["progress_file"] == f"progress/{snapshot['run_id']}.json"
    )


def read_active_runs(runs_dir: os.PathLike[str] | str) -> dict[str, Any]:
    raw = os.fspath(runs_dir)
    if not lexical_path_is_safe(raw):
        raise ReaderFailure(2, "active_runs_usage")
    try:
        registry = ActiveRegistry(raw, create=False)
    except BaseException as exc:
        if not _caused_by(exc, FileNotFoundError):
            raise ReaderFailure(5, "active_runs_invalid") from exc
        try:
            root = SecurePath(os.path.join(raw, ".active-runs-root-check"), create_parents=False)
        except TelemetryFailure as root_exc:
            if _caused_by(root_exc, FileNotFoundError):
                raise ReaderFailure(4, "active_runs_absent") from root_exc
            raise ReaderFailure(5, "active_runs_invalid") from root_exc
        root.close()
        try:
            active = SecurePath(
                os.path.join(raw, "progress", "active", ".active-runs-dir-check"),
                create_parents=False,
            )
        except TelemetryFailure as active_exc:
            if _caused_by(active_exc, FileNotFoundError):
                return {"schema_version": 1, "active_runs": [], "ignored_dead": 0}
            raise ReaderFailure(5, "active_runs_invalid") from active_exc
        active.close()
        raise ReaderFailure(5, "active_runs_invalid") from exc
    try:
        try:
            registry.acquire(writer=False)
        except TelemetryFailure as exc:
            if exc.code == "reader_busy":
                raise ReaderFailure(6, "active_runs_busy") from exc
            raise ReaderFailure(5, "active_runs_invalid") from exc
        try:
            active_runs: list[dict[str, Any]] = []

            def observe(probe: _TicketProbe) -> None:
                try:
                    snapshot, _data = _read_opened_value(
                        probe.destination_path.with_name(f"{probe.ticket['run_id']}.json"),
                        f"{probe.ticket['run_id']}.json",
                        max_bytes=65536,
                        validator=validate_snapshot,
                    )
                    _verify_fd_path(
                        registry.active,
                        probe.name,
                        probe.ticket_fd,
                        "registry_invalid",
                        max_size=4096,
                    )
                    _verify_fd_path(
                        probe.destination_path,
                        probe.destination_path.name,
                        probe.destination_fd,
                        "registry_invalid",
                    )
                except (FileNotFoundError, TelemetryFailure) as exc:
                    raise TelemetryFailure("registry_invalid") from exc
                if not _ticket_matches_snapshot(probe.ticket, snapshot):
                    raise TelemetryFailure("registry_invalid")
                active_runs.append({"run": probe.ticket, "progress": snapshot})

            _tickets, ignored_dead = registry.scan(reap_dead=False, observe=observe)
            active_runs.sort(key=lambda row: (row["run"]["started_at"], row["run"]["run_id"]))
            result = {"schema_version": 1, "active_runs": active_runs, "ignored_dead": ignored_dead}
            if len(canonical_bytes(result)) > 2 * 1024 * 1024:
                raise TelemetryFailure("registry_invalid")
            return result
        except TelemetryFailure as exc:
            raise ReaderFailure(5, "active_runs_invalid") from exc
        finally:
            registry.release()
    finally:
        registry.close()


class TelemetryRun:
    def __init__(
        self,
        *,
        progress_file: os.PathLike[str] | str,
        runs_dir: os.PathLike[str] | str,
        run_id: str,
        advertised: bool,
        source_commit: str,
        host: str,
        total: int,
        app_sha256: str | None = None,
        simulator_ownership: str = "none",
        wall_clock: Callable[[], float] = time.time,
        monotonic_clock: Callable[[], float] = time.monotonic,
        fault_injector: Callable[[str], None] | None = None,
        initial_cwd_fd: int | None = None,
        initial_cwd_display: os.PathLike[str] | str | None = None,
    ) -> None:
        self.progress_file = Path(progress_file)
        self.runs_dir = Path(runs_dir)
        self.run_id = run_id
        self.advertised = advertised
        self.source_commit = source_commit
        self.host = host
        self.total = total
        self.app_sha256 = app_sha256
        self.simulator_ownership = simulator_ownership
        self.wall_clock = wall_clock
        self.monotonic_clock = monotonic_clock
        self.fault_injector = fault_injector
        self.initial_cwd_fd = initial_cwd_fd
        self.initial_cwd_display = initial_cwd_display
        if self.advertised:
            expected = Path(self.runs_dir) / "progress" / f"{run_id}.json"
            if self.progress_file != expected:
                raise TelemetryFailure("unsafe_path")
        self.writer: AtomicProgressWriter | None = None
        self.registry: ActiveRegistry | None = None
        self.coordinator: ProgressCoordinator

    @property
    def ticket_fd(self) -> int:
        return -1 if self.registry is None else self.registry.ticket_fd

    @ticket_fd.setter
    def ticket_fd(self, value: int) -> None:
        if self.registry is not None:
            self.registry.ticket_fd = value

    def __enter__(self) -> TelemetryRun:
        try:
            if self.advertised:
                self.registry = ActiveRegistry(
                    self.runs_dir,
                    create=True,
                    anchor_fd=self.initial_cwd_fd,
                    anchor_display=self.initial_cwd_display,
                )
                self.registry.prepare(self.run_id)
            retained = (
                self.registry.progress_path(f"{self.run_id}.json")
                if self.registry is not None else None
            )
            self.writer = AtomicProgressWriter(
                self.progress_file,
                fault_injector=self.fault_injector,
                anchor_fd=self.initial_cwd_fd,
                anchor_display=self.initial_cwd_display,
                retained_path=retained,
            )
        except BaseException:
            if self.registry is not None:
                self.registry.close()
                self.registry = None
            raise

        def after_initial(snapshot: dict[str, Any]) -> None:
            if self.registry is None:
                return
            ticket = {
                "schema_version": 1,
                "run_id": self.run_id,
                "owner_pid": os.getpid(),
                "repo": "pentacle-mobile",
                "sha": self.source_commit,
                "host": self.host,
                "stage": "sim-e2e",
                "suite": "all-flows",
                "started_at": snapshot["started_at"],
                "progress_file": f"progress/{self.run_id}.json",
            }
            self.registry.publish_prepared(ticket)

        self.coordinator = ProgressCoordinator(
            self.writer,
            run_id=self.run_id,
            total=self.total,
            source_commit=self.source_commit,
            app_sha256=self.app_sha256,
            host=self.host,
            simulator_ownership=self.simulator_ownership,
            wall_clock=self.wall_clock,
            monotonic_clock=self.monotonic_clock,
            after_initial=after_initial,
        )
        return self

    def close(self, *, strict: bool = False) -> None:
        cleanup_failure: TelemetryFailure | None = None
        registry = self.registry
        writer = self.writer
        self.registry = None
        self.writer = None
        try:
            if registry is not None:
                try:
                    registry.remove_owned_ticket()
                except TelemetryFailure as exc:
                    cleanup_failure = exc
                except OSError as exc:
                    cleanup_failure = TelemetryFailure("registry_write_failed")
                    cleanup_failure.__cause__ = exc
        finally:
            try:
                if registry is not None:
                    registry.close()
            finally:
                if writer is not None:
                    writer.close()
        if strict and cleanup_failure is not None:
            raise cleanup_failure

    def __exit__(self, _kind: object, _value: object, _traceback: object) -> None:
        self.close(strict=True)


def reader_cli_main(command: str, argv: list[str]) -> int:
    if command == "progress":
        parsed = _parse_reader_pairs(argv, {"--progress-file", "--runs-dir", "--run-id"})
        if parsed is None:
            os.write(2, b"progress_usage\n")
            return 2
        progress_file = parsed.get("--progress-file")
        runs_dir = parsed.get("--runs-dir")
        run_id = parsed.get("--run-id")
        valid_shape = (
            (set(parsed) == {"--progress-file"} and lexical_path_is_safe(progress_file or ""))
            or (
                set(parsed) == {"--runs-dir", "--run-id"}
                and lexical_path_is_safe(runs_dir or "") and is_safe_id(run_id)
            )
        )
        if not valid_shape:
            os.write(2, b"progress_usage\n")
            return 2
        try:
            value = read_progress(
                progress_file=progress_file,
                runs_dir=runs_dir,
                run_id=run_id,
            )
        except ReaderFailure as exc:
            os.write(2, (exc.message + "\n").encode("ascii"))
            return exc.exit_code
        os.write(1, canonical_bytes(value))
        return 0
    if command == "active-runs":
        parsed = _parse_reader_pairs(argv, {"--runs-dir"})
        if parsed is None or set(parsed) != {"--runs-dir"} or not lexical_path_is_safe(parsed["--runs-dir"]):
            os.write(2, b"active_runs_usage\n")
            return 2
        try:
            value = read_active_runs(parsed["--runs-dir"])
        except ReaderFailure as exc:
            os.write(2, (exc.message + "\n").encode("ascii"))
            return exc.exit_code
        os.write(1, canonical_bytes(value))
        return 0
    return 2


def _parse_reader_pairs(argv: list[str], allowed: set[str]) -> dict[str, str] | None:
    if len(argv) % 2 != 0:
        return None
    parsed: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        flag, value = argv[index:index + 2]
        if flag not in allowed or flag in parsed or not value:
            return None
        parsed[flag] = value
    return parsed


if __name__ == "__main__":
    import sys
    raise SystemExit(reader_cli_main(sys.argv[1] if len(sys.argv) > 1 else "", sys.argv[2:]))
