# Chat-core convergence lineage & disposition — 2026-07-29

Spec: `spec_pentacle__desktop_chat_core_convergence_2026_07_29`. Establishes one
canonical `FACTORY_SHA` both desktop and mobile pin to.

## Verified refs (fresh fetch 2026-07-29)

| Ref | Commit | Core gitlink |
|-----|--------|--------------|
| Desktop `origin/main` | `7cc5943` | `3c0b08a507363c6bf45eabe0c50b99a5e36e025f` |
| Mobile `origin/main`  | `4a26a46` | `ebad7ac959b5e1400aac7d3a86bdb6fd584ddc4a` |
| Canonical core `origin/main` | — | `52586f4a033a4795e128e77ae057aae4560a8a9e` |

## Ancestry (all in pentacle-chat-core)

- Common ancestor **A** = `4cfbc37653c34d8e348e2f2a3be4e90ec99c5072`
  (`git merge-base` of desktop, mobile, and canonical pins — all three agree).
- Canonical main **C** = `52586f4` = **A + 30 linear commits** (the retained base).
- Mobile pin **M** = `ebad7ac9` = **C + 4 linear commits** (merge-base(M,C)=C; M
  descends canonical main directly).
- Desktop pin **D** = `3c0b08a` = **A + 1 commit**, branched off A *parallel* to
  the 30 canonical commits (C..D=1, D..C=30 — D does not descend C).

## Disposition

- **30-commit canonical segment A..C** — RETAINED as the tested base (unchanged).
- **4 mobile-beyond-main commits** (`b712d69` test, `da80666` fix, `0c438ad` fix,
  `ebad7ac` test) — provenanced question-answer projection refinements. **RETAINED**:
  they are a clean linear segment on C and carry mobile's shipped answer-projection
  behavior. Landed as the FACTORY base's first four commits.
- **Desktop-only `3c0b08a`** "interpret provider-neutral structured events"
  (`src/services/pentacleEventInterpreter.ts`, `tests/peerAgentMessages.test.ts`) —
  **RETAINED / PORTED**, not superseded. Evidence: canonical M has *none* of its
  concepts — `codex-rollout`, `source==='structured'`, `scrollback_fallback`,
  `revealScrollbackFallback`, typed `'TELL'` kind, and the `interpretClaudeJsonlEvent`
  →`interpretStructuredEvent` rename are all absent (0 occurrences each). Canonical's
  own peer-agent handling uses a *different* path (`parsePeerAgentMessage` on `USER`),
  so both coexist. `git cherry -v C D` shows the patch is not present by patch-id.

### Reconciliation of the port (commit `823474c`)

The desktop patch cherry-picked onto M with two conflicts, both complementary
(kept both sides):
- `interpretPentacleEvent` head: canonical added `userText` (terminal-prompt
  stripping, used by downstream USER paths); desktop added `source`/`transport`
  reads + the `scrollback_fallback` hide-guard + the typed `TELL` handler. All kept;
  `TELL` and `USER` paths are disjoint by event kind.
- test EOF: canonical appended three curated-transcript tests; desktop appended its
  TELL/scrollback tests earlier (applied clean) and trimmed a trailing blank line.
  Kept canonical's block; desktop tests verified present.
- The `interpretClaudeJsonlEvent`→`interpretStructuredEvent` rename applied via 3-way
  merge preserving canonical's THINKING alias (`05bf551`) inside the renamed function.

## FACTORY_SHA

`823474cc471a1a31206957525ed59c8bb3636d37`

Branch: `fix/pentacle-chat-core__desktop_mobile_convergence_2026_07_29`.
Linear descendant of canonical main C (`main..FACTORY` = the 4 mobile commits + the
port), so it fast-forwards `origin/main` cleanly at integration — the gitlink both
consumers pin does not change when main advances to it.

Core gate at FACTORY: `npm run typecheck` clean; `npm test` = 182 pass / 0 fail /
0 skipped; `typecheck:test` clean.
