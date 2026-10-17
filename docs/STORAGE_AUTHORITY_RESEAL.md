# Explicit authority device recovery

Normal storage operations require the sealed device, inode, canonical path, owner and mode to match.
A device-number change after remount therefore refuses before `storage:update` starts a transaction.
It does not prove that the original backing storage is still present.

The recovery below explicitly re-establishes trust in verified **current** storage for one exact
installed authority generation and preimage. Legacy authority has no historical volume UUID, so this
operation cannot establish historical volume continuity. It changes only the four fixed root device
strings; it retains the generation, root paths/inodes/owners/modes and every unrelated journal record.
It never attaches/detaches an image, activates a scheduler, repairs run schemas or starts native work.

```sh
node scripts/storage-cli.cjs storage:inspect-authority-reseal
node scripts/storage-cli.cjs storage:reseal-authority /absolute/reviewed-proof.json
node scripts/storage-cli.cjs storage:inspect-authority-reseal
```

Inspection is read-only and reports current hardware/backing/State/image identities, exact authority
hash, root drift, transaction status and normal-admission result. It does not authorize a migration.
The separate exact-candidate execution approval must bind the reviewed proof SHA256 and independently
measured current host/volume/image identities. A caller-written proof is evidence, not authorization.

The proof is a plain owner-only `0600` file, at a canonical absolute path without symlinks or hardlinks.
Its exact keys are:

| Key | Value |
| --- | --- |
| `schema` | `1` |
| `id` | New migration UUID v4 |
| `generation` | Exact installed authority UUID |
| `authority_preimage` | Base64 of the retained exact original authority file bytes |
| `authority_sha256` | SHA256 of those original bytes |
| `host` | Exactly `hostname`, numeric `uid`, and measured `hardware_uuid` |
| `backing_volume_uuid` | Current APFS Data volume UUID |
| `state_volume_uuid` | Current mounted State APFS volume UUID |
| `image_identity` | Exact current canonical `State.sparsebundle` identity |
| `roots` | Exact current fixed root map, with the existing identity shapes |

`roots` contains only `scratch_images`, `evidence_images`, `worktrees`, and
`repositories: {"pentacle-mobile": ...}` from the fixed layout. Each identity has exactly `canonical`,
`device`, `inode`, `uid`, and `mode`; device/inode are decimal strings. A proof is at most 64 KiB.
Do not change the old preimage or manufacture different roots to match a substituted filesystem.
The command independently measures hardware, APFS UUIDs and the unique canonical image/mount
relationship on every admission and commit check. Missing, ambiguous or changed observations refuse.

Before migration, retain the exact authority and State-image preimages, plist, scheduler history and
loaded-state readbacks in the approved recovery packet. No gate, janitor, scheduler or worktree lock
may be present, and scheduler transactions must already be terminal. Run/report bytes are preserved
without relaxing or repairing their schemas. A later run-schema error remains a separate blocker.

The fixed `State/authority-reseal.json` is a retained write-ahead history. It stores the exact before
and after authority, proof bytes/hash, original writer epoch, owned temporary names and original
unrelated-file preservation manifest. One generation-specific existing mutation claim serializes the
operation. A prepared or malformed history, reserved temporary or unreleased migration claim blocks
normal writes, including cleanup and shape-only recovery, before they can delete evidence.

An uncertain outcome requires inspection and reconciliation through this same supported command with
the **same reviewed proof**, under the execution owner's disposition. It re-observes storage, proves
the original writer epoch dead, and accepts only exact before/after authority and the original
preservation manifest. It never takes a new baseline after interruption. A complete orphan preparation
can be reconciled; partial/malformed or foreign artifacts refuse and remain for reviewed recovery.
A terminal leftover claim/temp can be reconciled without resealing again. A clean committed replay
refuses without writes. Never erase the journal, hand-edit authority, issue a blind fresh retry or use
`storage:restore` to reverse this pre-transaction rejection.

After a migration, all updater, janitor and certified-gate code must be an explicitly reviewed version
that understands the retained journal. Older versions with a closed State-layout whitelist reject it.
The live packet must name the exact post-migration updater and executing gate SHA, their QA/CI and
compatibility evidence. Do not silently switch source roots or remove history to run older code.
Scheduler update and any health check remain separate, explicitly approved operations; recovery
success alone is not scheduler health or certification.

Fixture validation: `node --test scripts/storage-authority-reseal.test.cjs`. Tests invoke the real CLI
with owned homes, proof inputs and native-boundary stand-ins, including crash/replay and zero-write
cleanup controls. Fixture success does not claim a live migration or native certification.
