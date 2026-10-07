# Repository workflow

Public main is the source of truth for development and release builds. Branch
from freshly fetched public main and land here after local gates, independent
review and required exact-SHA CI. Private branches are only for named private-data
needs; keep credentials, endpoints, signing inputs and per-host settings in local
configuration whenever possible.

Before pushing, install the hook with an absolute path:

```sh
git config core.hooksPath "$(git rev-parse --show-toplevel)/scripts/hooks"
```

The hook requires a clean checked-out candidate matching the pushed tip. It runs
`scripts/check-public-boundary.sh`, then the private-terms check, then the
reviewed foreign-history guard. The private-terms check
(`scripts/check_private_terms.py`) scans the exact outgoing commit's tree and
paths for any term in the host-local dictionary
(`$PENTACLE_PRIVATE_TERMS_FILE`, default `~/.config/pentacle/private-terms.json`;
a nonempty, unique JSON string array outside the checkout). It applies only the
public web checker's private-term matching, not its portable rules. A missing,
unreadable or malformed dictionary, a scan error or any hit refuses the push. The
receipt, written to `<git-dir>/private-terms-receipts/<sha>.json`, binds the
commit, tree, checker digest and dictionary digest/status/count and never
contains dictionary values or matched text. The dictionary never enters the
repository or CI; CI runs the check's tests with synthetic dictionaries only.
Never bypass it. The boundary reuses public Pentacle's residue checker; the source
hash is recorded in `scripts/public_guard_source.json`. Its fixed mobile profile
supports existing synthetic identifiers while still checking original text for
CGNAT addresses. Default web behavior is unchanged. Real fleet-name hits must not
increase against fresh public main. Review the exact tree/diff separately for
private data: this detector is not a general secret scanner.

Run `npm run test:unit`, `npm run typecheck` and `npm run validate` before the first
push. Use a temporary synthetic local config for export, exercise configured host
mapping/default-off features, then remove it. CI job `checks` repeats those gates
and the public content boundary; main requires that job on the exact candidate
and an up-to-date public base. Push an explicit branch refspec, obtain the
coordinator's landing slot, fast-forward main normally, and read back the remote
SHA. Do not force-push, delete main or move existing tags.

A private-data exception's safe product changes are reconciled immediately to a
public candidate with a reviewed path/source mapping, preserving public-only
behavior. No private Git history, gitlink or local config enters the candidate.
The shared chat core remains a reviewed vendored tree; an unchanged core pin does
not justify copying the private submodule again. Reconciliation is not sync backlog.

Source publication does not build, sign or install an app. Native releases retain
the certified origin-advertised candidate/gate order and device/runtime acceptance
in the testing documentation. Builds use accepted public code plus private local
configuration. Existing installed carries require their release owner's explicit
preservation plan before replacement.
