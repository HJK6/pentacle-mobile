from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path

from .asserts import Verdict


def setup_fail(name: str, message: str, **extras) -> Verdict:
    return Verdict(name=name, verdict="SETUP_FAIL", error=message, extras=extras).finish()


def required_command(config: dict, key: str, instruction: str) -> str | None:
    command = str(config.get(key) or "").strip()
    if command:
        return command
    return None


def run_command_action(
    *,
    name: str,
    command: str,
    timeout_s: float,
    env: dict[str, str] | None = None,
) -> Verdict | None:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    try:
        proc = subprocess.run(
            shlex.split(command),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            env=merged_env,
        )
    except FileNotFoundError as exc:
        return setup_fail(name, f"scenario action command not found: {exc.filename}", command=command)
    except subprocess.TimeoutExpired:
        return setup_fail(name, f"scenario action command timed out after {timeout_s}s", command=command)

    if proc.returncode != 0:
        return setup_fail(
            name,
            f"scenario action command failed with exit {proc.returncode}",
            command=command,
            stdout=proc.stdout.strip(),
            stderr=proc.stderr.strip(),
        )
    return None


def fixture_path(repo_root: Path, name: str) -> Path:
    return repo_root / "test" / "e2e" / "fixtures" / name
