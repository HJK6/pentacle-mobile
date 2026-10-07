# Status surface validation

## Scope and sources

The Updates tab implements the status-card screen only. The implementation is
based on public main `8cf03b755c585bb61f205a8666ab2157e6c5a482` and the status-card
section of the approved design ZIP, SHA-256
`5ce4da052c83a7264cffe88a88bdadeef699a1fb83af6e60ce8da7b492c8db23` (17 files).
The approved header text is **Bart**; the public-boundary guard is unchanged.
The as-shipped contract is [Mobile UX / Updates](PENTACLE_MOBILE_SPEC.md#updates).

Changed runtime paths are only `app/(tabs)/updates.tsx`, the new
`src/components/status/` components/selectors, `src/services/laneEta.ts`, and
optional nullable ETA fields in `pentacle-chat-core/src/types/pentacle.ts`.
Tests and documentation accompany them. No daemon, configuration source,
notification store, push behavior, other screen, setting, deployment, or device
installation changes are included.

## Acceptance and collection

The fixtures are synthetic. No captured transcript, private endpoint, or real
user data is used.

- `tests/laneEta.test.ts`: 29 cases covering the complete formatter table,
  nearest-minute ties, minimum durations, exact due time, missing/invalid ETA
  fields, needs-you precedence, the 0/35/200 overrun parity vectors, optional
  nullable types, and preservation through existing snapshot/inventory reducers.
- `tests/app/(tabs)/updates.test.tsx`: 28 render cases covering status-only source
  selection, retained/live ordering and counts, newest highlighting, both
  header states, real Chats selector inclusion/exclusion, step precedence, all
  ETA shapes, amber blocked state, existing CardStatusMini expansion, repeated
  card/log/back/caret interaction, duplicate-safe navigation, focus/reconnect,
  local-only ETA ticking, notifications import removal, and Unified preservation.
  The interruption regressions cover a request settling while blurred, fresh
  history reuse, sparse prose-only pages, no-progress responses, cancelling on
  back/blur, bounded failure recovery, and end-reached demand during mount.
- `tests/services/chatOpenNavigation.test.ts`: existing navigation census grant list remains
  unchanged; Updates is added to the shared-helper and no-test-only-branch
  coverage. The screen passes its router directly to the shared navigation unit.
- `tests/unifiedScreen.test.tsx`: existing runtime question-drawer coverage passes
  unchanged.

Collection command:

```sh
npx jest --listTests --runInBand --json
```

The collected list contains 223 test files, including:

```text
tests/laneEta.test.ts
tests/app/(tabs)/updates.test.tsx
tests/services/chatOpenNavigation.test.ts
tests/unifiedScreen.test.tsx
```

## Reproduction environment

Install the locked npm dependencies. On Linux, use Ruby and BSD tar as in the
existing CI workflow, with bsdtar resolving as `tar` in PATH; the Hermes
archive fixtures require BSD member-path semantics. Validation here used Node 24.19.0, Ruby 3.3.8 with JSON 2.7.2, and
bsdtar 3.7.4, extracted from official Debian packages into disposable workspace
storage. No test or source was changed to compensate for missing tools.

The additional JavaScript-export check used the explicitly approved ignored
`pentacle.config.local.ts`, copied unchanged from the public example and removed
afterward. `app.config.ts` and the public-boundary/history hooks are unchanged.
The temporary Expo home/cache was outside the source tree.

## Gate output

M1 frozen source passed:

```text
$ npm run test:unit
> pentacle-mobile@2.0.0 test:unit
> jest --runInBand
PASS tests/laneEta.test.ts
Test Suites: 223 passed, 223 total
Tests:       1 skipped, 2081 passed, 2082 total

$ npm run typecheck
> pentacle-mobile@2.0.0 typecheck
> tsc --noEmit
(exit 0; no TypeScript diagnostics)
```

The M2 source head passed the complete gates (final documentation-head receipts
are included with the patch delivery):

```text
$ npm run test:unit
> pentacle-mobile@2.0.0 test:unit
> jest --runInBand
PASS tests/laneEta.test.ts
PASS tests/app/(tabs)/updates.test.tsx
PASS tests/services/chatOpenNavigation.test.ts
PASS tests/unifiedScreen.test.tsx
Test Suites: 223 passed, 223 total
Tests:       1 skipped, 2104 passed, 2105 total

$ npm run typecheck
> pentacle-mobile@2.0.0 typecheck
> tsc --noEmit
(exit 0; no TypeScript diagnostics)
```

The command names above are exactly the package scripts, not a focused subset.
`npm run validate` also passed the iOS JavaScript export, and the unchanged
`scripts/check-public-boundary.sh origin/main` passed. Test-first missing-module
failures and independently reproduced interruption/navigation failures were
repaired before the ready heads.

## Delivery and remaining gates

The delivery is an ordered `git format-patch` series against the base above.
The recipient applies it with `git am`, verifies each reported tree SHA and the
final tree SHA, and pushes through the real pre-push hook before opening the
one draft PR. Re-applied commit SHAs may differ; compare tree SHAs. No commit
was published through the connector, and no remote branch or PR was created.
Standalone content checks are supporting evidence, not a substitute for the
mandatory publication hook.

Independent focused review and local aggregate tests cover this source patch.
GitHub CI, independent fleet QA on the applied head, the certified isolated
simulator harness, merge, signed/device builds, and optional subjective visual
review remain with the fleet. No native harness or screenshots were produced.
