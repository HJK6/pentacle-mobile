# Versioning — Pentacle Mobile

Two numbers, two very different jobs. Keeping them separate is what stops us
landing back on "1.0.0 forever."

## 1. Build number — automatic, never think about it

`ios.buildNumber` in `app.config.ts` is **derived at build time** from the git
commit count (`git rev-list --count HEAD`) by `computeBuildNumber()`. Nobody sets
it by hand and it is not stored anywhere.

Expo prebuild bakes that value into the generated native project. A local Expo
config plugin also injects an Xcode build phase that stamps `CFBundleVersion`
from the current git count into the built app's `Info.plist` on every iOS build,
including bare `xcodebuild` builds of an already-generated `ios/` directory.
Because the phase is added by prebuild, it survives native project regeneration.

- **Monotonic** on a linear history: every commit bumps it by ≥1.
- **Reproducible**: the same commit always yields the same build number.
- **Collision-free** in practice — no shared counter file for parallel builds to
  race on.

iOS only requires the build number to *increase* per App Store / TestFlight
upload within a marketing version; the absolute value is irrelevant. (When this
scheme went in, the number jumped from a hand-set `3` to the commit count —
expected and fine.)

### Rules that keep it safe

- **Cut releases from `main`.** Building from a short branch could produce a
  lower number than an already-shipped build.
- **Don't rewrite history that has already shipped** (no squashing / rebasing of
  released commits) — that can lower the count.
- **Full clones only.** The build refuses to run from a shallow clone — run
  `git fetch --unshallow` first. A shallow clone reports a bogus low count.

## 2. Marketing version — automatic, `MAJOR.MINOR.PATCH`

`version` in `app.config.ts` is the version a person sees in the app. It is
derived from the same git commit count as `ios.buildNumber`, starting from
`2.0.0` at build `390`, so every source build gets a distinct visible version.
The default lane is MINOR:

| Mode                         | Build 391 result | Use when…                                                                       |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| default / `minor`            | `2.1.0`          | new user-visible builds; this is the normal agent path                          |
| `PENTACLE_VERSION_BUMP=patch` | `2.0.1`          | bug fixes / internal changes only; no new user-facing features, nothing breaks  |
| `PENTACLE_VERSION_BUMP=major` | `3.0.0`          | breaking changes, a redesign, or a deliberate "this is a big one" milestone      |

Example:

```bash
npm run ios:device
PENTACLE_VERSION_BUMP=patch npm run ios:device
PENTACLE_VERSION_BUMP=major npm run ios:device
```

### Guidance for agents

Default to **minor**. Choose **patch** when the build is purely corrective or
internal. Choose **major** only for breaking changes or an explicitly-declared
milestone.

## Releasing, end to end

```bash
npm run ios:device         # build (auto app version + auto build number) + install to the phone
```

`runtimeVersion.policy` is `appVersion`, so the OTA runtime version tracks the
marketing version automatically.
