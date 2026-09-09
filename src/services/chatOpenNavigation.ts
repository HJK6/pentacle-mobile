import { beginChatOpenPaint, markChatOpenRouterDispatchReturned } from './chatOpenPaintSignals';
import { openChatRowNavigationIntent, type ChatOpenNavigationAction } from './chatOpenNavigationIntent';

export type ChatOpenNavigator = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

export type ChatOpenNavigationResult = {
  action: ChatOpenNavigationAction;
  correlationId: string | null;
  navigated: boolean;
};

// THE single source of truth for opening a chat's session screen. Both the
// interactive Chats-row handler (app/(tabs)/chats.tsx) and the harness open path
// (src/services/harnessOpenExistingChat.ts) MUST route through here — never
// re-implement the begin/intent/navigate/mark sequence in a caller. Two things
// have to stay welded together across every open path:
//   1. the chat_open_paint trace (begin -> mark router-dispatch-return), and
//   2. the push/replace/noop navigation branch the coordinator dictates.
// They drifted once — the paint trace lived only in the interactive handler,
// while the SLO scenario opened through the harness path — and that produced the
// 0-paint-event measurement gap this module exists to prevent. The drift
// regression test (tests/services/chatOpenNavigation.test.ts) fails if either
// caller stops routing through here.
//
// `onBeforeNavigate` runs only when a navigation actually happens (i.e. NOT on
// 'noop'), after the branch is decided — the interactive handler uses it to
// clear the expanded-row state exactly as it did inline.
export function performChatOpenNavigation(
  streamId: string,
  navigator: ChatOpenNavigator,
  onBeforeNavigate?: () => void,
): ChatOpenNavigationResult {
  if (!streamId) return { action: 'noop', correlationId: null, navigated: false };
  const correlationId = beginChatOpenPaint(streamId);
  const action = openChatRowNavigationIntent(streamId, correlationId);
  if (action === 'noop') return { action, correlationId, navigated: false };
  onBeforeNavigate?.();
  const href = `/pentacle/session/${encodeURIComponent(streamId)}`;
  if (action === 'replace') navigator.replace(href);
  else navigator.push(href);
  markChatOpenRouterDispatchReturned(correlationId, streamId);
  return { action, correlationId, navigated: true };
}

// A router with an optional `replace`, as the harness-only open services hold
// it (expo-router's `router` has both; some call sites type only `push`).
export type HarnessRouterLike = {
  push: (href: any) => void;
  replace?: (href: any) => void;
};

// The single entry point EVERY harness open path must call to reach the session
// route, so the chat_open_paint trace and the push/replace/noop branch stay
// welded to the navigation (see the drift guard). Navigation is wrapped so a
// pre-mount throw (harness cold launch fires before RootLayout mounts) is
// swallowed while the trace still completes. Production is unaffected: the paint
// sink defaults to NOOP, so this only navigates there.
export function performHarnessChatOpen(
  streamId: string,
  router: HarnessRouterLike,
): ChatOpenNavigationResult {
  return performChatOpenNavigation(streamId, {
    push: (href) => { try { router.push(href); } catch { /* pre-mount navigation */ } },
    replace: (href) => { try { router.replace?.(href); } catch { /* pre-mount navigation */ } },
  });
}
