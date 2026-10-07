# Assistant tab shell

The tab bar is implemented in [`app/(tabs)/_layout.tsx`](../app/(tabs)/_layout.tsx):
**Assistant · Personal · Dashboards · Settings**, using the configured assistant
name instead of the default. The `bart` route is the navigator’s initial tab.
Chats, Unified, and Updates remain registered routes with `href: null`; they are
not shown in the bar. Existing Dashboards content is unchanged.

[`app/(tabs)/bart.tsx`](../app/(tabs)/bart.tsx) composes the exported `SessionScreen`
for `BART_STREAM_ID`. Transcript rendering, composer, session questions, and voice
remain the existing session implementation. It does not fork a session screen,
create a store, or change the daemon. The tab and header read one local [identity adapter](../src/components/bart/assistantIdentity.tsx):
the canonical session’s `display_name`, then `title`, then **Assistant**. Its
icon uses that session’s configured host accent with the `djinni` identity
glyph; the tab retains its active/inactive tint. The adapter is the single
replacement point for a future shared identity selector.

## Header and overlays

- The left button opens Sessions and shows the number of other chats needing
  an answer. The assistant’s own thread is excluded from that count and from the drawer
- The right button opens `/pentacle/questions`. Its badge counts pending question
  pages across all chats, including the assistant, following the frozen Questions contract
- Zero counts hide badges. Opening or closing a surface never clears a question
- The name block opens the locked `StatusSurface` in a full-screen modal. Its
  250 ms fade and 4 px rise sit over a permanently opaque ink background; the
  round close control and system Back dismiss it
- Status history keeps the existing Updates fetch, reconnect, sparse-page
  backfill, and cancellation behavior. The underlying `SessionScreen` remains
  the sole owner of the assistant’s focused-stream registration; modal closure cannot
  unpin the live thread

Implementation: [`BartHeader`](../src/components/bart/BartHeader.tsx) and
[`BartStatusOverlay`](../src/components/bart/BartStatusOverlay.tsx). The locked
[`StatusSurface`](../src/components/status/StatusSurface.tsx) and hidden
[`Updates`](../app/(tabs)/updates.tsx) route are unchanged.

## Sessions drawer

[`ChatsDrawer`](../src/components/bart/ChatsDrawer.tsx) preserves the Chats list's
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
[`MachineMark`](../src/components/bart/MachineMark.tsx) gives the machine with the
djinni skin a muted B monogram; drawer rows do not reuse the assistant’s lamp. The locked
status surface retains its existing marks unchanged.

## Integration boundary

See the [frozen shared contracts](bart_home_contracts.md) for ownership. The
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

- `tests/components/bart/assistantIdentity.test.ts` (renamed/default identity and host icon)
- `tests/components/bart/BartTabBar.test.tsx` (real React Navigation bar)
- `tests/components/bart/BartRenderStability.test.tsx` (real stream subscription isolation)
- `tests/components/bart/BartHeader.test.tsx`
- `tests/components/bart/BartHome.test.tsx` (real session, selectors, and summon flow)
- `tests/components/bart/BartStatusOverlay.test.tsx` (real focus registration)
- `tests/components/bart/ChatsDrawer.test.tsx`
- `tests/components/bart/MachineMark.test.tsx`
- `tests/components/bart/bartSelectors.test.ts`
- Existing `tests/app/(tabs)/_layout.test.tsx` and `tests/app/tabsLayout.test.tsx`

The delivery report records full-suite totals and exact final-head output, plus
clean `git am` application and final-tree equality. The Ruby and archive tests
need Ruby and bsdtar as documented for the existing native tooling tests; they
must not be skipped or replaced with stubs. An iOS export is a separate check,
not a device or assembled-home certificate.
