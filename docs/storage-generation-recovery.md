# Storage generation recovery

This maintenance utility preserves a detached generation in an archive. Source
acceptance does not recover a host or admit a native build. Real inspection can
mount an image read-only: every real invocation, including `inspect` and `plan`,
requires a separate FD allocation. Do not run it merely to discover a generation.

Use the fixed, clean public scheduler clone and its reviewed Node interpreter.
Mutable roots remain owned by the account. The shared read-only executable may
belong to its provisioner; its canonical inode, UID, mode and byte hash are bound
separately, with writable/substituted binaries refused. There are no caller-selected
roots or environment overrides:

```sh
node scripts/storage-retire-generation.cjs inspect
node scripts/storage-retire-generation.cjs plan OBSERVED_GENERATION
node scripts/storage-retire-generation.cjs apply OBSERVED_GENERATION REVIEWED_PLAN_SHA256
```

`inspect` reads the actual installed authority and returns its generation, byte
hash, root identities and failure census. Detached inspection proves the exact
image/device/mount, both diskutil `Writable=false` and `WritableVolume=false`, and
its own successful detach. Missing, foreign or ambiguous authority is a retained
failure. No generation is inferred from an image name or an empty mount directory.

For attached storage, inspection reuses the existing reseal observation and adds
an owner/record census. `plan` and `apply` refuse `RETIREMENT_ATTACHED`. Device-only
root drift uses the existing proof-bound authority reseal procedure under its
own allocation; this utility never detaches an attached production generation.
Healthy attached storage needs no recovery. See [authority reseal](STORAGE_AUTHORITY_RESEAL.md).

For eligible detached storage, independently review the complete plan and its
SHA256. The digest binds the actual source commit, interpreter bytes, host, UID,
generation, authority/plist preimages, root identities, complete logical State
manifest, detached support manifest and scheduler ownership. Apply recomputes the
same plan before its first mutation. A changed input requires a retained stop;
it does not silently produce a replacement plan.

Retirement requires empty fixed State/Scratch/Evidence mounts, canonical owned
paths, same-volume archive placement and at least 60 GiB free. It validates current
records, generations, inactive owners, locks, terminal scheduler transactions and
the exact committed plist digest. Live, reused or uncertain owners, active tickets,
claims/leases/temporaries, unknown shapes, aliases, hardlinks, reseal history and
ambiguous scheduler argv refuse intact. A legacy private-root CLI plist is
recognized only for retirement ownership; it receives no new execution authority.

The journal is outside support at
`~/Library/PentacleMobileStorageRetired/GENERATION/retirement.json`. Its original
writer PID/epoch, outside-support lock, plan and digest are retained before
bootout or renames. The phases are `journaled`, `booted_out`, `plist_renamed`,
`support_renamed`, and `retired`. The original plist and entire support directory
are renamed into that archive, with both parents synced. No image, historical
record or unrelated byte is deleted. The archive is never restored as active
rollback.

After an interruption, retain both locations and the exact journal. Resume only
with the same generation/digest, original dead writer, unchanged bytes and exact
phase. Both/neither locations, unknown journal content, a changed original lock,
a live/reused owner or a stale resume lease retain a named failure for owner
review. Do not clear a lock, refresh a baseline, retry with a new digest, force
detach, restore archived authority or overwrite a partial install.

A successful retirement leaves no active support or scheduler plist. Ordinary
`storage:install` is a later, separately allocated operation; it must create a
distinct generation and a genuine committed scheduled-wrapper/janitor smoke.
Failed installation retains the archive and partial new generation. Host
recertification and any native admission remain separate gates.

## Manual disposable integration

The manual driver is not a test entry and must not be invoked by automated test
discovery. It requires a later explicit FD allocation for a separately provisioned
standard account named `pmstoragerehearsal`, actual home
`/Users/pmstoragerehearsal`, real UID other than 0 or 501, and an already live
`gui/UID` domain. This source change neither provisions that account nor grants
permission to execute the driver.

The provisioner supplies two separate plain public-source clones at
`~/repos/pentacle-mobile-public` and `~/repos/pentacle-mobile`, both at the
allocated merged commit, plus empty owned `~/agent-workspace/worktrees` and
`~/agent-workspace/pentacle-memory`. The public clone uses the normal exact-lock
Node22 dependency install. Initial support/image/plist/label must be absent.
The provisioner records actual account/domain/paths, source, interpreter, capacity,
exclusive ownership, expected duration and cleanup in the FD allocation.

Run only inside that account's real login session, from its canonical public
clone, with the allocated UID and exact merged public-main SHA:

```sh
node scripts/storage-retire-generation-rehearsal.cjs ALLOCATED_UID MERGED_PUBLIC_MAIN_SHA
```

The driver rejects a substituted HOME, userInfo mismatch, root/production UID,
preloads, environment root overrides, dirty/noncanonical/unpublished source,
source/main mismatch, missing GUI domain or existing initial resources. No native,
account or source-lifecycle workaround is provided.

It runs the unchanged ordinary installer twice, separated by a synthetic-fixture
retirement. Each install must have an observed launchd wrapper PID/epoch/argv and
real janitor child PID/epoch/parent/argv, genuine bound report, plist digest and
successful wrapper logs. A missed observation is `HARNESS_ERROR`, with no retry
or synthetic substitute. It retains authority/logical-State/plist preimages,
adds a neutral evidence sentinel, and detaches only the exact image created by
this disposable run. The driver then invokes actual inspect/plan/digest-bound
apply, verifies the archive, and checks the new generation differs. This owned
fixture detach does not create an attached-to-detached production recovery route.

Results and original failures are fsynced beneath the account's fresh
`~/agent-workspace/agent-outputs/storage-transition-rehearsal/`. Existing evidence
refuses overwrite. Cleanup uses ordinary uninstall and only proved owned detach;
unknown or partial resources are retained with `CLEANUP_FAIL`. Successful cleanup
must show zero owned mounts, labels and live producer processes while preserving
support/archive bytes. The FD provisioner disposes of the account and retained
resources only after separate evidence acceptance.

The hermetic source tests emulate only the native boundary, owned home/userInfo,
capacity and epochs. Their real installer/wrapper/janitor reports are source
proof. They do not certify APFS, launchd, actual host recovery or native behavior.
The required real disposable rehearsal, production-host apply/install and native
release gates remain unpassed until separately executed and accepted.
