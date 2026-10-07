# Testing

From a fresh checkout, run npm ci, copy pentacle.config.example.ts to
pentacle.config.local.ts, then run npm run test:unit and npm run typecheck.
The shared chat core is vendored, so tests need no private repository or daemon.

For iteration, run npx jest --runInBand --runTestsByPath tests/<file>.test.ts.
Keep fixtures synthetic and preserve protocol fields, error messages, author
prefixes and config keys: those values affect behavior even in synthetic data.
The test host configuration uses hosta, hostb, and hostc.

tests/contracts/bart_preview_thread_parity.test.ts guards that the Chats-list
preview for the assistant composite equals the thread's last rendered row, and
that a turn-final projection row (an assistant status row, not a published
prose reply) renders as an assistant bubble. It runs under
test:unit with synthetic fixtures; it does not replace a native replay.

Run npm run test:prod-build-guardrails to check the public production-build
environment allowlist, endpoint preflight, bundle fingerprint and baked-endpoint
checks, and sanitized evidence. This test uses synthetic inputs and does not
build or sign an app. The separate host-sigil test runs under test:unit.

npm run validate adds an iOS JavaScript export to TypeScript checking.
Jest covers modeled behavior; it does not certify native builds, device signing,
or live spawn/send journeys. Those require the configured daemon and native
runtime described in [Native builds](PENTACLE_MOBILE_BUILD.md).

The web harness can connect the real client to an isolated test daemon using the
EXPO_PUBLIC_HARNESS, EXPO_PUBLIC_HARNESS_TOKEN and EXPO_PUBLIC_PENTACLE_WS_URL
environment variables. Its credential must be synthetic and temporary; never
commit it. Native rejection-tracking options are loaded only on native platforms.
Verify a unique assistant response in the rendered chat, and verify actions stay
disabled when the daemon cannot be reached. This browser check does not replace
a signed native build or an iPhone runtime check.

The Summon picker uses configured and discovered host identities. Host labels
need not match the example palette; offline hosts remain visible but disabled.

Public main is the normal development and build source. See [repository workflow](repo_workflow.md) for the mandatory pre-push content/history guard and required CI. Private-data exceptions use immediate reviewed public projection; keep local config out of Git.

The portable synthetic harness gate and retained private inputs are documented in [Public source boundary](public_boundary.md). CI runs only the four named Python mock/helper test files; JavaScript export validation uses the disposable ignored example config.

## Certified native gate and storage

Use the clean, origin-advertised candidate with the installed storage authority:

```sh
env -u npm_config_cache PATH="$PWD/node_modules/.bin:$PATH" node scripts/storage-cli.cjs gate:native-root HEAD
env -u npm_config_cache PATH="$PWD/node_modules/.bin:$PATH" node scripts/storage-cli.cjs gate:full RUN_ID LOCK_TOKEN
```

The first command returns the opaque run ID and lock token for the second. The
host singleton and shared `sim-queue` serialize native work. Candidate and gate
code provenance, native process identity, all fixed simulator cases, finalized
video and owned cleanup must pass. See [public harness contracts](PUBLIC_CERTIFIED_HARNESS.md).

Storage uses the installed fixed layout and rejects caller-selected paths. The
installed authority binds host, UID and generation; journal schema and reference
checks bind each run, container, worktree ticket and scheduler transaction to
that authority. Capacity requires 60 GiB free at start and 40 GiB while running.
The limits are 1 MiB for copied configuration, 64 MiB for state, 12 GiB for scratch
and 2 GiB for evidence. Build cache admission also preserves its measured free
space reserve. Evidence classification and digest checks precede publication.
Dead-owner scratch uses a 24-hour wait; published passing evidence is retained
for 7 days and failed evidence for 30 days. Recovery requires the journal's
exact owned identity and does not confer authority over unrelated resources.

Lifecycle commands use the same CLI: `storage:install`, `storage:update`,
`storage:restore`, `storage:uninstall`, `storage:register-worktree MAIN_REPO_ID
SPEC_ID LANE_ID` and `storage:retire-worktree TICKET_ID`. The installed LaunchAgent
runs `storage:janitor dry-run` every six hours through `scripts/storage-janitor-scheduled.cjs`;
`storage:janitor apply` is an explicit action. Its nonzero last-exit status in
`launchctl list` means failure. The wrapper keeps the last two runs of stdout and
stderr in `State/logs` (1 MiB per file, 4 MiB total, inside the state budget); a
truncated file carries a marker and stderr ends with an exit marker. `storage:install`
and `storage:update` run only from the dedicated `~/repos/pentacle-mobile-public` checkout
(a fixed path, never caller-selected; `~/repos/pentacle-mobile` is the sealed lane
repository and is not a scheduler root). It must be a plain, non-symlinked clone of the
public `HJK6/pentacle-mobile` origin, clean, and contained in a fetched `origin/main`;
other roots are refused before any change. Prepare it with `git clone`, `npm ci --ignore-scripts`
and `git fetch` before updating. Admission is checked at install/update only; scheduled runs
execute whatever that checkout contains, so keep it clean and on public `main`. The update
is transactional and rolls back to the prior plist.
Admission catches ordinary accidents: a wrong or private root, a plainly dirty tree, an
unmerged commit, a redirected worktree or a remapped origin refspec. It does not detect every
dirty state and does not authenticate the source against an actor running as the same user.
Accepted residuals: edited files hidden by index flags (`assume-unchanged`, `skip-worktree`,
`core.ignoreStat`), untracked files hidden by `.git/info/exclude` or `core.excludesFile`, a
second remote whose fetch refspec rewrites `refs/remotes/origin/main`, and direct edits of
`refs/remotes/origin/main` (only an online `ls-remote` would catch these).
An authorized `launchctl kickstart` can exercise the installed job; inspect its
bound report afterward. The regular `disabled` file in the installed state is
the kill-switch for apply mode. Do not replace lifecycle commands with manual
deletion. Failed-run recovery uses `storage:recover-run RUN_ID` and retains the
same identity and ownership checks.
