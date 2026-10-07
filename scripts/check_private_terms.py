#!/usr/bin/env python3
"""Private-terms-only boundary check of one exact commit.

Scans every text blob (and every path) in the commit's tree for any term from a
host-local private dictionary: a nonempty, unique JSON string array kept outside
the checkout. Matching is the public web checker's private-term rule
(scripts/check_public_residue.py in HJK6/pentacle: casefolded substring per
line; undecodable blobs are skipped), run alone so no web portable rule applies
here. Prints one JSON receipt bound to the commit, tree, this checker's digest
and the dictionary's digest/status/count. Dictionary values and matched text
are never printed; a path that itself contains a term is shown only as a hash.

Exit 0: checked, zero hits. Exit 1: hits. Exit 2: refused (missing,
unreadable or malformed dictionary, dictionary inside the checkout, unknown
commit, or any scan error).
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

SCHEMA = "pentacle-mobile.private-terms-receipt.v1"


def _git(root: Path, *args: str, data: bytes | None = None) -> bytes:
    return subprocess.run(["git", *args], cwd=root, input=data, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def load_terms(root: Path, path: Path) -> tuple[list[str], dict]:
    if path.resolve().is_relative_to(root):
        raise ValueError("dictionary_inside_checkout")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ValueError("dictionary_unreadable") from exc
    try:
        values = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("dictionary_malformed") from exc
    if (not isinstance(values, list) or not values or len(values) > 1000
            or any(not isinstance(value, str) or not value.strip() or len(value) > 1024 for value in values)):
        raise ValueError("dictionary_malformed")
    terms = [value.casefold() for value in values]
    if len(set(terms)) != len(terms):
        raise ValueError("dictionary_malformed")
    return terms, {"status": "checked", "count": len(terms), "sha256": hashlib.sha256(raw).hexdigest()}


def _blobs(root: Path, commit: str) -> list[tuple[str, str]]:
    listing = _git(root, "ls-tree", "-r", "-z", "--full-tree", commit).decode("utf-8")
    blobs = []
    for entry in filter(None, listing.split("\0")):
        meta, name = entry.split("\t", 1)
        _mode, kind, oid = meta.split(" ")
        if kind == "blob":
            blobs.append((name, oid))
    return blobs


def _contents(root: Path, oids: list[str]) -> list[bytes]:
    out = _git(root, "cat-file", "--batch", data="".join(f"{oid}\n" for oid in oids).encode())
    contents, offset = [], 0
    for oid in oids:
        header_end = out.index(b"\n", offset)
        header = out[offset:header_end].split(b" ")
        if len(header) != 3 or header[0].decode() != oid or header[1] != b"blob":
            raise ValueError("scan_error")
        size = int(header[2])
        start = header_end + 1
        contents.append(out[start:start + size])
        offset = start + size + 1
    return contents


def scan(root: Path, commit: str, terms: list[str]) -> list[dict]:
    blobs = _blobs(root, commit)
    violations = []
    for (name, _oid), content in zip(blobs, _contents(root, [oid for _name, oid in blobs])):
        path_hit = any(term in name.casefold() for term in terms)
        lines = []
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = ""
        for number, line in enumerate(text.splitlines(), 1):
            folded = line.casefold()
            if any(term in folded for term in terms):
                lines.append(number)
        if path_hit or lines:
            display = f"<private-path:{hashlib.sha256(name.encode()).hexdigest()}>" if path_hit else name
            violations.append({"path": display, "path_hit": path_hit, "lines": lines})
    return violations


def check(root: Path, commit: str, terms_file: Path) -> dict:
    root = root.resolve()
    receipt = {"schema": SCHEMA, "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "commit": None, "tree": None, "private_terms": {"status": "not_run", "count": 0},
               "hit_count": 0, "violations": [], "passed": False}
    try:
        full = _git(root, "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}").decode().strip()
        receipt["commit"] = full
        receipt["tree"] = _git(root, "rev-parse", f"{full}^{{tree}}").decode().strip()
    except (subprocess.CalledProcessError, OSError):
        receipt["error"] = "unknown_commit"
        return receipt
    try:
        terms, receipt["private_terms"] = load_terms(root, terms_file)
    except ValueError as exc:
        receipt["private_terms"] = {"status": "refused", "count": 0}
        receipt["error"] = str(exc)
        return receipt
    try:
        violations = scan(root, full, terms)
    except (subprocess.CalledProcessError, OSError, ValueError):
        receipt["error"] = "scan_error"
        return receipt
    receipt["violations"] = violations
    receipt["hit_count"] = sum(len(item["lines"]) + int(item["path_hit"]) for item in violations)
    receipt["passed"] = not violations
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--commit", required=True)
    parser.add_argument("--private-terms-file", type=Path, required=True,
                        help="private JSON string array outside the checkout; values are never printed")
    args = parser.parse_args()
    receipt = check(args.root, args.commit, args.private_terms_file)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if "error" in receipt:
        return 2
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
