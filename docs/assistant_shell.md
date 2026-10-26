# Assistant tab shell

For what these screens look like and how to use them, see
[Assistant and work lanes](assistant_and_lanes.md). This page covers the implementation.

The tab bar is implemented in [`app/(tabs)/_layout.tsx`](../app/(tabs)/_layout.tsx):
**Zephyr · Personal · Dashboards · Settings**, using the configured assistant
name instead of the default. The `assistant` route is the navigator’s initial tab.
Chats, Unified, and Updates remain registered routes with `href: null`; they are
not shown in the bar. Existing Dashboards content is unchanged.

[`app/(tabs)/assistant.tsx`](../app/(tabs)/assistant.tsx) composes the exported `SessionScreen`
for `ASSISTANT_STREAM_ID`. Transcript rendering, composer, session questions, and voice
remain the existing session implementation. It does not fork a session screen,
create a store, or change the daemon. The tab and header read one local [identity adapter](../src/components/assistant/assistantIdentity.tsx):
the canonical session’s `display_name`, then `title`, then **Zephyr**. Its
icon uses that session’s configured host accent with the `djinni` identity
glyph; the tab retains its active/inactive tint. The adapter is the single
replacement point for a future shared identity selector.

## Header and overlays

- The left button opens Sessions and shows the number of other chats needing
  an answer. The assistant’s own thread is excluded from that count and from the drawer
- The right button opens `/pentacle/questions`. Its badge counts pending question
  pages across all chats, including the assistant, following the frozen Questions contract
- Zero counts hide badges. Opening or closing a surface never clears a question
- The name block (and the lamp ring) opens the open work lanes list, `/pentacle/lanes`; so does the
  lanes count
- The locked `StatusSurface` is no longer opened from the header; `AssistantStatusOverlay` is kept
  but unmounted, and the status surface stays reachable from the hidden `Updates` route

Implementation: [`AssistantHeader`](../src/components/assistant/AssistantHeader.tsx) and
[`AssistantStatusOverlay`](../src/components/assistant/AssistantStatusOverlay.tsx). The locked
[`StatusSurface`](../src/components/status/StatusSurface.tsx) and hidden
[`Updates`](../app/(tabs)/updates.tsx) route are unchanged.

## Sessions drawer

[`ChatsDrawer`](../src/components/assistant/ChatsDrawer.tsx) preserves the Chats list's
ordering within NEEDS YOU, WORKING, and IDLE groups. Attention takes precedence
over working. Empty groups are omitted. Its panel occupies 86% of the viewport;
its 300 ms left-slide and 250 ms scrim fade reverse on dismissal. Tap the scrim,
use system Back, or swipe left more than 50 px to close. Vertical scrolling is
not captured as a horizontal swipe.

The + button uses `useNewSessionFlow`, with the returned modal rendered once and
the button disabled when `canStart` is false. Only real machine hosts enter its
picker. On iOS the summon sheet waits for the drawer’s native dismissal, so two
modals are not presented at the same time.

Rows use the shared duplicate-safe `performChatOpenNavigation`. Opening the
drawer dismisses the composer keyboard, and handled row taps are preserved.
[`MachineMark`](../src/components/assistant/MachineMark.tsx) gives the machine with the
djinni skin a muted B monogram; drawer rows do not reuse the assistant’s lamp. The locked
status surface retains its existing marks unchanged.

## Integration boundary

See the [frozen shared contracts](assistant_home_contracts.md) for ownership. The
startup redirect, session back/missing-session targets, and push-tap home target
are integration-owner changes (S3). Setting the tab navigator's initial route
does not override those explicit routes. The Questions overlay and Personal
content are separate packets. A minimal Personal placeholder is permitted only
until that packet lands. README design section 10 does not replace the existing
Dashboards screen.

Source tests use synthetic fixtures. Jest and TypeScript checks do not certify
native rendering, a device build, or live daemon operations. The assembled-home
journey and release-device checks remain separate integration gates.

## Source validation

The series is based on `613b75e756bb331782b03822c780f8e057121af2` and the frozen
v1.5 contract at that commit. It includes the explicitly permitted one-line
Personal placeholder; later Personal work is integrated by the packet owner.
No shared files or locked status/session/voice code are changed by this series.
The tab bar leaves the layout while the keyboard is visible, preserving the
embedded session composer’s keyboard offset. The session renderer is isolated
from unrelated session prose updates. Newer navigation cancels the drawer’s
queued summon transition, and late spawn completion cannot steal focus.

Run the normal full gates from the repository root:

```sh
npm run test:unit
npm run typecheck
scripts/check-public-boundary.sh origin/main
node node_modules/jest/bin/jest.js --listTests --json --runInBand
```

Shell coverage is collected from:

- `tests/components/assistant/assistantIdentity.test.ts` (renamed/default identity and host icon)
- `tests/components/assistant/AssistantTabBar.test.tsx` (real React Navigation bar)
- `tests/components/assistant/AssistantRenderStability.test.tsx` (real stream subscription isolation)
- `tests/components/assistant/AssistantHeader.test.tsx`
- `tests/components/assistant/AssistantHome.test.tsx` (real session, selectors, and summon flow)
- `tests/components/assistant/AssistantStatusOverlay.test.tsx` (real focus registration)
- `tests/components/assistant/ChatsDrawer.test.tsx`
- `tests/components/assistant/MachineMark.test.tsx`
- `tests/components/assistant/assistantSelectors.test.ts`
- Existing `tests/app/(tabs)/_layout.test.tsx` and `tests/app/tabsLayout.test.tsx`

The delivery report records full-suite totals and exact final-head output, plus
clean `git am` application and final-tree equality. The Ruby and archive tests
need Ruby and bsdtar as documented for the existing native tooling tests; they
must not be skipped or replaced with stubs. An iOS export is a separate check,
not a device or assembled-home certificate.


The Sessions drawer uses the same `selectSmartChatList` preview as Agents.
Summary-mode inventory can omit message text, so the drawer's section list
passes visible session IDs to the existing `prefetchSettledStreams` history
queue after 250 ms of viewability. Section headers and offscreen rows are
excluded, and a closed drawer requests nothing. The shared queue retains its
freshness, coalescing and concurrency controls and tagged prefetch telemetry.
Fetched events update the canonical preview; truly empty chats retain
“Waiting for first message…”. `tests/components/assistant/ChatsDrawer.test.tsx`
covers visible-row hydration, preview updates, empty chats and close/reopen.
