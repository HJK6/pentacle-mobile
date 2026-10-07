#!/usr/bin/env python3
"""Tests for the private-terms pre-push check (run under Public checks).

Standalone (no pytest dependency); uses synthetic dictionaries only. The hook
cases drive the real scripts/hooks/pre-push in a throwaway repository whose
history guard is replaced by a stub that records it ran, so the destination,
boundary and private-terms steps run for real without network access.
Run: `python3 scripts/test_check_private_terms.py`.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("check_private_terms", REPO / "scripts/check_private_terms.py")
cpt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cpt)

TERM = "zebra" + "quokka"  # synthetic; assembled so this file never carries it
PUBLIC_URL = "git@github.com:HJK6/pentacle-mobile.git"
COPIED = [".gitignore", "scripts/check-public-boundary.sh", "scripts/check_public_residue.py", "scripts/test_check_public_residue.py",
          "scripts/check_private_terms.py", "scripts/hooks/pre-push", "configs/public_fixture_allowlist.json"]
HISTORY_STUB = '#!/bin/sh\ncat >/dev/null\necho ran > "$(git rev-parse --absolute-git-dir)/history-ran"\n'


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def make_repo(tmp: Path, files: dict[str, str]) -> tuple[Path, str]:
    remote, work = tmp / "remote.git", tmp / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    git(work, "config", "user.email", "test@example.invalid")
    git(work, "config", "user.name", "Test")
    for rel in COPIED:
        (work / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, work / rel)
    (work / "scripts/hooks/history-pre-push").write_text(HISTORY_STUB)
    (work / "scripts/hooks/history-pre-push").chmod(0o755)
    (work / "README.md").write_text("synthetic\n")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "base")
    git(work, "remote", "add", "origin", str(remote))
    git(work, "push", "-q", "--no-verify", "origin", "main")
    for rel, text in files.items():
        (work / rel).parent.mkdir(parents=True, exist_ok=True)
        (work / rel).write_text(text)
    git(work, "add", "-A")
    git(work, "commit", "-q", "--allow-empty", "-m", "candidate")
    return work, git(work, "rev-parse", "HEAD")


def write_terms(tmp: Path, value) -> Path:
    path = tmp / "terms.json"
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def run_hook(work: Path, head: str, terms: Path | None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "PENTACLE_PRIVATE_TERMS_FILE"}
    env["HOME"] = str(work.parent / "home")  # never the real host dictionary
    if terms is not None:
        env["PENTACLE_PRIVATE_TERMS_FILE"] = str(terms)
    record = f"refs/heads/feat {head} refs/heads/feat {'0' * 40}\n"
    return subprocess.run(["sh", "scripts/hooks/pre-push", "origin", PUBLIC_URL], cwd=work, env=env,
                          input=record, capture_output=True, text=True)


def history_ran(work: Path) -> bool:
    return (Path(git(work, "rev-parse", "--absolute-git-dir")) / "history-ran").exists()


def receipt(work: Path, head: str) -> dict:
    return json.loads((Path(git(work, "rev-parse", "--absolute-git-dir")) / "private-terms-receipts" / f"{head}.json").read_text())


def test_checker_reports_hits_without_values():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": f"ok\nconst x = '{TERM.upper()}';\n", f"docs/{TERM}.md": "fine\n"})
        result = cpt.check(work, head, write_terms(tmp, [TERM, "other" + "value"]))
        assert result["passed"] is False and result["hit_count"] == 2, result
        assert result["commit"] == head and result["private_terms"]["status"] == "checked"
        assert result["private_terms"]["count"] == 2 and len(result["private_terms"]["sha256"]) == 64
        dumped = json.dumps(result).casefold()
        assert TERM not in dumped and "other" + "value" not in dumped
        assert {"path": "src/a.ts", "path_hit": False, "lines": [2]} in result["violations"]


def test_checker_scans_the_commit_not_the_working_tree():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": "clean\n"})
        (work / "src/a.ts").write_text(f"{TERM}\n")  # uncommitted
        assert cpt.check(work, head, write_terms(tmp, [TERM]))["passed"] is True


def test_checker_refuses_bad_dictionaries():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {})
        cases = {
            "dictionary_unreadable": tmp / "missing.json",
            "dictionary_malformed": write_terms(tmp, "not json"),
        }
        for error, path in cases.items():
            result = cpt.check(work, head, path)
            assert result["error"] == error and result["passed"] is False, (error, result)
        for bad in ([], [""], [TERM, TERM.upper()], [1]):
            assert cpt.check(work, head, write_terms(tmp, bad))["error"] == "dictionary_malformed", bad
        inside = work / "terms.json"
        inside.write_text(json.dumps([TERM]))
        assert cpt.check(work, head, inside)["error"] == "dictionary_inside_checkout"
        assert cpt.check(work, "0" * 40, write_terms(tmp, [TERM]))["error"] == "unknown_commit"


def test_hook_passes_a_clean_exact_head_and_still_runs_the_history_guard():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": "clean\n"})
        done = run_hook(work, head, write_terms(tmp, [TERM]))
        assert done.returncode == 0, done.stderr
        assert "private terms checked, zero hits" in done.stderr
        assert history_ran(work)
        stamp = receipt(work, head)
        assert stamp["commit"] == head and stamp["passed"] is True and stamp["hit_count"] == 0
        assert stamp["private_terms"]["status"] == "checked" and stamp["private_terms"]["count"] == 1
        assert git(work, "status", "--porcelain") == ""


def test_hook_refuses_a_private_hit_without_printing_it():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": f"{TERM}\n"})
        done = run_hook(work, head, write_terms(tmp, [TERM]))
        assert done.returncode != 0 and "private-terms check did not pass, hits: 1" in done.stderr
        assert TERM not in (done.stdout + done.stderr).casefold()
        assert not history_ran(work)
        assert receipt(work, head)["hit_count"] == 1


def test_hook_refuses_absent_or_malformed_dictionary():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": "clean\n"})
        for terms, error in ((None, "dictionary_unreadable"), (tmp / "missing.json", "dictionary_unreadable"),
                             (write_terms(tmp, "{"), "dictionary_malformed")):
            done = run_hook(work, head, terms)
            assert done.returncode != 0 and f"did not pass, error: {error}" in done.stderr, (terms, done.stderr)
            assert not history_ran(work)


def test_hook_keeps_the_existing_boundary_check():
    fleet = "tho" + "th"  # assembled for the same reason as check-public-boundary.sh
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": f"{fleet}\n"})
        done = run_hook(work, head, write_terms(tmp, [TERM]))
        assert done.returncode != 0 and "refused new fleet-name content" in done.stderr, done.stderr
        assert not history_ran(work)


def test_hook_keeps_the_destination_and_exact_head_checks():
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        work, head = make_repo(tmp, {"src/a.ts": "clean\n"})
        terms = write_terms(tmp, [TERM])
        env = {**os.environ, "HOME": str(tmp / "home"), "PENTACLE_PRIVATE_TERMS_FILE": str(terms)}
        wrong = subprocess.run(["sh", "scripts/hooks/pre-push", "origin", "git@github.com:someone/else.git"], cwd=work,
                               env=env, input=f"refs/heads/feat {head} refs/heads/feat {'0' * 40}\n",
                               capture_output=True, text=True)
        assert wrong.returncode != 0 and "unexpected destination" in wrong.stderr
        base = git(work, "rev-parse", "HEAD~1")
        moved = subprocess.run(["sh", "scripts/hooks/pre-push", "origin", PUBLIC_URL], cwd=work, env=env,
                               input=f"refs/heads/feat {base} refs/heads/feat {'0' * 40}\n",
                               capture_output=True, text=True)
        assert moved.returncode != 0 and "must match checked-out candidate" in moved.stderr


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"ok - {len(tests)} private-terms tests")
