# Mock Screenshot Harness

Renders the **real** pentacle-mobile screens under react-native-web with mocked
offline data (no backend, no device). Built for the Claude Design handoff, and
reusable as a render-smoke / visual-regression substrate.

It renders the actual Expo Router screen components — not an HTML replica.

## TL;DR

```bash
EXPO_PUBLIC_SCREENSHOT_HARNESS=1 npm run web           # RN-web dev server with the offline seed
npx jest tests/harnessScreenshotFixtures.test.ts       # render-smoke over the fixture registry
```

This repository has no npm scripts for the harness. The scoped lanes driver is
described below; raw capture output stays outside the repository. Open other
served routes in a browser or use a driver that calls
`window.__pentacleHarness.seed(...)`.

## How it works

1. **Offline seed seam** — `src/services/pentacleStream.ts` exposes three
   harness-only exports, all strictly gated by callers on
   `EXPO_PUBLIC_SCREENSHOT_HARNESS === '1'` so production bundles dead-code them:
   - `harnessSetOffline(true)` — `connect()` / `reconnectPentacleStream()`
     become no-ops, so seeded state is never wiped by the token-load reconnect
     and no WebSocket is ever opened.
   - `harnessSeedSnapshot(snapshot, opts)` — applies a fixture through the
     **production reducers** (`applySnapshotWithOptimisticReconciliation` +
     `applyNotificationList`) so seeded state is faithful to the wire path.
2. **Bootstrap** — `src/harness/screenshotHarness.ts` (`installScreenshotHarness`)
   is required at module scope from `app/_layout.tsx`, gated on
   `EXPO_PUBLIC_SCREENSHOT_HARNESS`. It flips offline mode on, seeds a default
   populated snapshot (so first paint isn't empty), and installs
   `window.__pentacleHarness` with `seed(screen, variant)` for the driver to
   re-seed per shot.
3. **Real app under the router** — screens render through the same providers
   `_layout` supplies; the driver navigates to real routes (`/chats`,
   `/pentacle/session/<id>`, …), so navigation hooks behave normally.
4. **Driver** — a scoped lanes driver is included. A driver (Playwright headless Chromium,
   390×844 @2x) walks a screen registry, calls
   `window.__pentacleHarness.seed(...)`, settles, and writes each PNG.

Auth: also set `EXPO_PUBLIC_HARNESS=1` and `EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK=1`
for runs without the biometric lock. `expo-secure-store` has no web impl but is
not hit on the seeded path.

## Current screens

The `screen:variant` list is the `FIXTURES` registry in `src/harness/screenshotFixtures.ts`.

### Readable lanes

`lanes:readable_full`, `lanes:readable_sparse`, and `lanes:readable_old` seed
the current home, lane, goal and spec screens through production reducers and
the normal show response path. The sparse fixture leaves optional fields out;
the old fixture omits the new projection keys. The full fixture supplies a
lane question, trouble signals and the other design states.

The scoped Playwright driver `scripts/lanes-flow-v2-render.cjs` captures the
eight full design states and sparse and old inputs at 390×844, and checks map
label rectangles at 390 and 375 pixels. Supply an admitted screenshot server
with `PENTACLE_RENDER_URL` and an external output directory with
`PENTACLE_RENDER_OUTPUT`. These web captures are supplemental: pagination,
Release navigation, native controls and configured-runtime behavior require
the separate native and live journeys. The driver hides the unrelated web
voice-recording overlay under the approved accommodation for its observed
storage-unavailable banner; native Release proof hides nothing.

## Adding a screen or variant

Two registries, intentionally split:

- **Fixtures** — `src/harness/screenshotFixtures.ts`: add a
  `'<screen>:<variant>'` entry to `FIXTURES`, built from `pentacle-chat-core`
  types so `tsc` catches wire-shape drift. Reuse the `SEEDED` / `LOADING` /
  `ERRORED` opt presets. For a session-style screen that reads a specific
  stream, seed events for that `stream_id` and point the route at it
  (see `SESSION_STREAM_ID`).
- **Route** — in your driver's screen registry, use the real `route` and the
  `variants` to shoot. URL-encode any `:` in a route param
  (`/pentacle/session/${encodeURIComponent(id)}`).

Keep the two in sync — `tests/harnessScreenshotFixtures.test.ts` asserts the
fixture registry resolves and seeds cleanly.

## Render-smoke tests

`tests/harnessScreenshotFixtures.test.ts` seeds every registry fixture through
the real reducers and asserts the screen-facing selectors then see the right
data (chat list, notifications/updates, codex usage + machine-stats tabs,
session transcript), plus the loading/error opts. Fast (~3s), no browser, no
component mount — it guards the data layer the PNGs sit on top of:

```bash
npx jest tests/harnessScreenshotFixtures.test.ts
```

## Web-platform fixes this harness required

- `app.config.ts` registers `sucrase/register/ts` before requiring
  `pentacle.config.local.ts` — Node 20 has no type-stripping and the nested
  require runs outside `@expo/config`'s sucrase transform, so the `.ts` config
  otherwise fails to load.
- `app/_layout.tsx` guards the foreground badge-clear effect on
  `Platform.OS === 'web'` — `Notifications.setBadgeCountAsync` /
  `dismissAllNotificationsAsync` throw synchronously on web and would redbox
  every screen.

## Scope

Web-rendered, not device-accurate (react-native-web may differ from iOS/Android
in places) — good enough for design handoff + regression signal. Pixel-diff
golden-image comparison is a non-goal; this produces the substrate for it.
