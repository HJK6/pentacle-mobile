#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"
base=${1:-origin/main}
git cat-file -e "$base^{commit}"
python3 scripts/test_check_public_residue.py
python3 scripts/check_public_residue.py
# Same no-new-fleet-name check as the public web workflow. Assemble terms so
# the guard does not flag its own policy definition.
pattern='bart''imaeus|ama''terasu|mer''lin|daff''odil|vam''sh|tho''th'
scratch=$(mktemp -d)
cleanup() {
  rm -f "$scratch/base" "$scratch/base.sorted" "$scratch/candidate" "$scratch/candidate.sorted" "$scratch/new"
  rmdir "$scratch"
}
trap cleanup EXIT
# git grep exits 1 for no matches; other failures must remain fatal.
scan() {
  git grep --no-color --no-line-number -I -i -E "$pattern" "$1" -- . ':!configs/public_fixture_allowlist.json' > "$2" || {
    result=$?
    [ "$result" -eq 1 ] || return "$result"
  }
  sed 's/^[^:]*://' "$2" | sort > "$2.sorted"
}
scan "$base" "$scratch/base"
scan HEAD "$scratch/candidate"
comm -13 "$scratch/base.sorted" "$scratch/candidate.sorted" > "$scratch/new"
if [ -s "$scratch/new" ]; then
  echo 'public boundary: refused new fleet-name content; sanitize or obtain a scoped ruling' >&2
  # Report paths only, never potential private values.
  cut -d: -f1 "$scratch/new" | sort -u >&2
  exit 1
fi
# Owned temporary artifacts only.
rm "$scratch/base" "$scratch/base.sorted" "$scratch/candidate" "$scratch/candidate.sorted" "$scratch/new"
