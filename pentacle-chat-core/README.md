# pentacle-chat-core

The shared, **platform-neutral** chat-stream event core for Pentacle. It is the
single source of truth for how chat-stream frames are interpreted, folded into
state, and projected into a render-ready view model — consumed verbatim by both
**pentacle-mobile** (React Native / Metro) and **pentacle desktop**
(Electron / esbuild). One implementation drives both surfaces, so display rules,
the optimistic-send state machine, dedup, and selectors cannot drift between
platforms.

The package contains **zero** React Native, Expo, Electron, or DOM imports. It
is consumed as TypeScript source via a `file:` dependency that points at a git
submodule checkout (see [Consumption](#consumption)).

## What it owns

| Module (`src/`) | Responsibility |
|---|---|
| `services/pentacleEventInterpreter.ts` | Raw `PentacleEvent` → display-ready `PentacleInterpretedEvent` (text normalization, tone, case, and the `displayRule` taxonomy). `interpretPentacleEvent`, `coalesceInterpretedEvents`, and the text predicates. |
| `services/pentacleStreamReducer.ts` | The pure reducer / state machine. Folds events, snapshots, session inventory, working.state, and optimistic sends into `PentacleStreamState`. Owns daemon_seq dedup, snapshot reconciliation, turn/working phase, optimistic-send lifecycle, and reconnect re-arming. |
| `services/pentacleChatModel.ts` | Selectors that project reducer state into the neutral view model: `selectChatList`, `selectSessionDetail`, `selectChatOverview`, `selectMachineStatusList`, `selectMachineStatsTabs`. |
| `services/optimisticMatch.ts` | The optimistic-send ↔ server-USER-echo matcher (`optimisticMatchesServerUser`, `serverEventTime`, `OPTIMISTIC_RECONCILE_WINDOW_MS`). |
| `services/pentacleEventFlowDiagnostics.ts` | Per-stream inbound / persisted / dropped flow counters and drop classification (`recordInbound`, `classifyDrop`, `snapshotCounts`, …). |
| `services/pentacleEventUtils.ts` | `mergeProgressiveUpdate`, `dedupeRecentEvents`, `dedupeRecentEventsByStream`. |
| `services/pentacleHosts.ts` | `normalizePentacleHost`. |
| `services/hostConfig.ts` | The host-config injection seam (see below). |
| `utils/telemetry.ts` | The telemetry injection seam (see below) plus `logTelemetry`. |
| `utils/telemetryEvents.ts` | `TELEMETRY_EVENTS` constants and bug-ref map. |
| `types/pentacle.ts` | All shared types (`PentacleEvent`, `PentacleStreamState`, `OptimisticSendState`, `TurnState`, …). |

The public API is the `src/index.ts` barrel; every symbol above is re-exported
from there.

## Public contract: frames in → state → view model

The data flow is one direction:

```
raw daemon frame ──► apply*(state, …) ──► PentacleStreamState ──► select*(state, …) ──► neutral view model
   (snake_case)        (reducer)            (immutable)             (selectors)         (PentacleSessionDetail / PentacleChatListItem)
```

1. **Frames in.** A consumer switches on `frame.type` and calls the matching
   reducer entry point. The reducer takes the current `PentacleStreamState` and
   returns the next one (new object iff anything changed):
   - `snapshot` → `applySnapshotWithOptimisticReconciliation`
   - `chat.event` → `applyPentacleEvent` (server-origin USER echoes route
     through optimistic reconciliation — see the matcher)
   - `session.inventory` → `applyPentacleSessionInventory`
   - `working.state` → `applyPentacleWorkingState`
   - `host.status` → `applyPentacleHostStatus`
   - plus codex/machine/updates apply functions, and the optimistic-send
     lifecycle (`sendOptimisticMessage`, `markOptimistic*ByRequestId`,
     `reconcileOptimisticSendWithServerEvent`, `onReconnect`).

2. **State.** `PentacleStreamState` (in `types/pentacle.ts`) is the canonical
   immutable state: the event ring (capped at `PENTACLE_RECENT_EVENT_LIMIT`),
   drafts, sessions, hosts, machine stats, working states, the optimistic-send
   map (`optimisticSends` keyed by `optimistic_id`, with an
   `optimisticByRequestId` index), per-stream turn phase (`workingByStream`),
   and the per-stream `eventContentVersionByStream` counter that lets selectors
   force a fresh result on in-place progressive updates.

3. **Neutral view model out.** Selectors return platform-neutral plain objects —
   no JSX, no DOM, no RN components:
   - `selectChatList(state, filter)` → `PentacleChatListItem[]` (sidebar/list).
   - `selectSessionDetail(state, streamId, options?)` → `PentacleSessionDetail`
     (`transcriptItems: PentacleTranscriptItem[]`, status, labels, draft). Each
     transcript item carries its `displayRule` + `tone`; the consumer maps those
     to its own widgets (RN components on mobile, DOM strings on desktop).
   Selectors are memoized; identical inputs return the previous reference so the
   consumer can cheaply skip re-renders.

## Reducer and selector contracts

`applyPentacleSnapshotMessage` treats the presence of `snapshot.events` as an
explicit event-ring replacement. A snapshot that carries events still normalizes,
dedupes, and replaces the ring as before. A snapshot without an events bundle is
a summary snapshot: it preserves the prior events for streams that still appear
in `snapshot.sessions` and drops events for streams no longer present. This is
required for summary-mode reconnects, where desktop and mobile receive session
metadata on reconnect and fetch transcript history lazily; an event-less
snapshot must not wipe the buffered transcript for every surviving open stream.

`selectSessionDetail` has a pre-row-build cache fast path. For a given cache key
(stream id plus selector options such as visible count and draft inclusion), it
returns the cached `PentacleSessionDetail` reference before building transcript
rows when the stream's `eventContentVersionByStream[streamId]` and the selector
input signature are unchanged. The signature covers the row-affecting inputs
outside the event ring: session summary fields, resolved title/host/status
labels, draft text/event, and optimistic-send status for the stream. Changes to
any covered input bypass the early exit and rebuild the rows.

`selectSessionDetail` accepts `systemRows?: 'all' | 'timing-only'` (meaningful
only when `includeSystem` is true; default `'all'`). With `'timing-only'`,
non-timing system rows are filtered BEFORE dedupe and the `visibleCount`
window, so rows a consumer will discard cannot displace real transcript rows
(or the timing rows themselves) inside the window. Timing rows are the
`terminal:divider` and `activity:turn-summary` displayRules; `system:compacted`
rows are not timing rows and stay excluded. The option is part of the selector
cache key, so toggling it cannot return a stale cached detail. The canonical
consumer is desktop's show-turn-duration ON path, which reselects with
`includeSystem: true, systemRows: 'timing-only'`.

The typed telemetry registry (`utils/telemetryEvents.ts`, `TELEMETRY_EVENTS`)
also carries the mobile chat render-evidence event names
(`chat:question_rendered`, `chat:transcript_row_rendered`,
`chat:history_backfill_rendered`) so consumers emit and assert them through
typed constants instead of raw string literals.

`applyPentacleHostsStats` projects the daemon-owned `hosts.stats` frame as a
complete replacement of the fleet map; `normalizeHostStats` drops any host whose
sample cannot be real. The daemon is the sole sampler and timestamp authority, so
the decoder accepts the daemon's **actual** `sampled_at` precision: the ISO form
`YYYY-MM-DDTHH:MM:SS[.fraction]Z` with **any** fractional-second precision (the
live daemon is Python `datetime.isoformat()` + `Z`, which emits SIX digits —
microseconds), with `Date.parse` as the semantic gate. A rigid millis-only
`\.\d{3}` pattern silently dropped every host and blanked Settings → Machines;
this mirrors the `normalizePentacleLimits` lesson — the client projects the
daemon's output, it does not gate on an over-narrow schema. Pinned by
`tests/hostsStatsReducer.test.ts` (micro/milli/nano precision plus preserved
rejection of non-finite/negative numerics, used > total, non-positive totals,
host-key mismatch, and unparseable/bare-fraction timestamps).

## Injection seams

The core is platform-neutral, so anything platform-sourced is injected by the
host at startup. There are exactly two seams:

### 1. Host config — `setHostConfigProvider`

`services/hostConfig.ts`. The chat-model selectors need host display **order**
(`getHostOrder`) and a host's display **theme** (`getHostTheme`, of which they
read `.label`). The underlying data is platform-sourced (mobile reads it from
Expo config via `expo-constants`). The host installs a `HostConfigProvider`:

```ts
import { setHostConfigProvider } from 'pentacle-chat-core';
setHostConfigProvider({ getHostOrder, getHostTheme });
```

Until a provider is installed a non-throwing default derives order from live
state and titlecases host ids — so the package is usable with no config, and a
provider, once installed, takes over entirely.

### 2. Telemetry — `setTelemetrySink`

`utils/telemetry.ts`. `logTelemetry(name, data)` routes through an injectable
sink. The default sink only `console.log`s. A host (or a dev/CI harness) installs
its own sink with `setTelemetrySink`, or layers an additional listener with
`teeTelemetrySink` (returns an untee function). This is how the desktop dev/CI
harness captures lifecycle + display-rule telemetry without changing production
behavior.

## Platform-neutrality guarantee + drift guard

The package must never import a platform module or touch a DOM/RN global. This
is enforced from the **desktop** repo by the drift guard
(`pentacle/test/chat_core_drift_guard.test.js`, run via `npm run
test:drift-guard`). It asserts two things:

1. **No platform imports** in the package — no `expo*`, `react`, `react-native`,
   or `react-dom`, and no banned DOM globals (`document`, `window`, `navigator`,
   `localStorage`, `HTMLElement`).
2. **No reimplementation outside the package** — the canonical symbols
   (`interpretPentacleEvent`, `coalesceInterpretedEvents`,
   `optimisticMatchesServerUser`, `applyPentacleEvent`, `selectSessionDetail`)
   must not be *defined* anywhere under the desktop `renderer/` or `main/` trees
   (the allowlist is empty). Imports and delegating calls are fine; a second
   definition is a drift failure.

A display-rule parity test (`npm run test:parity` in the desktop repo) asserts
the interpreter's display rules match the expected mapping.

## Consumption

Both consumers depend on the package by **bare specifier** and resolve it from a
`file:`-linked submodule checkout. The package ships **TypeScript source** (no
build step — `package.json` `main`/`types` point at `src/index.ts`); each
consumer's bundler compiles it.

```ts
import {
  applyPentacleEvent,
  selectSessionDetail,
  setHostConfigProvider,
} from 'pentacle-chat-core';
```

### pentacle-mobile (React Native / Metro)

- `package.json`: `"pentacle-chat-core": "file:./pentacle-chat-core"`.
- `metro.config.js` adds the submodule to `watchFolders` and maps the bare
  specifier to the submodule root so Metro compiles the TS source.
- Jest maps `^pentacle-chat-core$` → `pentacle-chat-core/src/index.ts` and
  un-ignores the package in `transformIgnorePatterns`.
- Seams wired at `app/_layout.tsx` (`setHostConfigProvider` from
  `src/config/local`) and `test/setup.ts` (same provider, lazy-required).

### pentacle desktop (Electron / esbuild)

- `package.json`: `"pentacle-chat-core": "file:./pentacle-chat-core"`.
- The renderer entry `renderer/src/chat_core_entry.ts` imports the package and
  esbuild bundles it (resolving the bare specifier + compiling the package TS)
  into `renderer/dist/chat_core.bundle.js` via the `build:renderer` script (run
  at `prestart` and in `scripts/build-mac.js` before packaging).
- The host-config seam is installed in the renderer; the telemetry sink is left
  at its default in production and only teed by the dev/CI harness.

See the desktop architecture doc (`pentacle/docs/desktop_chat_ui_shared_core.md`)
for the full desktop wiring, and `pentacle/docs/chat_protocol.md` for the
daemon wire contract that produces these frames.

## Git submodule + updating the pin

This repo (`github.com/HJK6/pentacle-chat-core`, branch `main`) is consumed as a
git **submodule** inside both `pentacle` (desktop) and `pentacle-mobile`. The
superproject records a commit **pin**, not a branch. To roll a change:

1. Land the change here and push `main`:
   ```sh
   cd pentacle-chat-core
   git checkout main && git pull
   # …edit…
   git commit -am "…" && git push origin main
   ```
2. In each superproject, advance the submodule and commit the new pin:
   ```sh
   cd <superproject>/pentacle-chat-core
   git fetch && git checkout <new-sha>     # or: git pull origin main
   cd ..
   git add pentacle-chat-core               # stages the submodule pointer
   git commit -m "chore: bump pentacle-chat-core pin to <new-sha>"
   ```
3. Rebuild: mobile re-bundles through Metro automatically; desktop must
   re-run `npm run build:renderer` (or `prestart`) to refresh
   `renderer/dist/chat_core.bundle.js`.

`git submodule status` in either superproject shows the currently pinned SHA.

## Markdown rendering (`parseMarkdown` / `parseInline`)

`src/services/markdown.ts` is the **single source of truth** for how chat
assistant prose is interpreted as markdown, shared by the desktop renderer
(HTML strings) and the mobile renderer (React-Native `<Text>`). The parser is
platform-agnostic — it emits an `MdBlock[]` / `MdInline[]` token tree and never
touches the DOM or RN, so it stays drift-guard clean.

**Escape-first contract.** Leaf `text` / code `value` / link `href` fields are
the RAW source substrings; the parser never emits HTML. Each platform escapes at
render time (desktop wraps every leaf in `escapeHtml` before `innerHTML`; mobile
passes leaves to `<Text>`, which is inert). Link `href`s are pre-filtered to a
safe-scheme allow-list (`http(s)`, `mailto`, relative, anchor); an unsafe URL
(`javascript:`/`data:`) degrades to plain text, so no renderer ever receives a
dangerous href.

**Supported subset** (deliberately not full CommonMark): ATX headings
(`#`–`######`), `**bold**`/`__bold__`, `*italic*`/`_italic_` (underscore is
boundary-only, so `snake_case` is untouched), `` `inline code` ``, ```` ``` ````
fenced code, unordered (`-`,`*`,`+`) + ordered (`1.`/`1)`) lists, thematic
breaks, conservative GFM-style pipe tables, and `[text](href)` links.
Blockquotes, nested lists, images, and HTML passthrough are intentionally
unsupported (rendered literally). A future swap to a full CommonMark library
would replace this file behind the same `parseMarkdown` boundary. Tests live
desktop-side: `npm run test:markdown`.

## Daemon child contracts

`ChildAgent`, `ThreadReadRequest`, `ThreadReadResponse`, and `DaemonQuestionAnswer` describe the daemon updates wire contract. `decodeChildAgents` preserves nullable model/objective fields and raw UTC transition timestamps; the inventory reducer uses it without truncating rosters. `decodeThreadRead` validates paged thread responses. `validSpawnObjective` checks the shared one-line, 120-code-point admission boundary.

The daemon and core tests consume `tests/fixtures/daemon_updates_v1.json`; mobile producers and navigation consume the same committed fixture. Thread reads require the viewed parent for operator clients; agent clients derive the parent from their verified seat token.
