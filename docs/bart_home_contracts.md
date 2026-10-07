# Bart-first home: frozen shared contracts

Contract version: **v1.6 (2026-10-07)** — v1.1 corrected § Answering questions and named the S1/S2 exports; v1.2 added § Household RPC (S4); v1.3 drops partially answered durable items from the pending count; v1.4 also drops items the notification itself marks answered; v1.5 lands the initial pending-count selector, the shared new-session flow and the new tab telemetry names (S6); v1.6 makes the assistant's name and icon follow the operator's customization (S7).
Design original: `design_handoff_bart_home/README.md`
(Pentacle-Mobile.zip sha256 `5ce4da05…`). Changing anything below is a contract change: the
integration owner publishes a new version here and tells every packet lead before code relies on it.

## Packets and file ownership

| Packet | Owns | Must not touch |
| --- | --- | --- |
| P3 Bart shell | `app/(tabs)/_layout.tsx`, `app/(tabs)/bart.tsx`, `src/components/bart/*` | everything below |
| P4 Questions overlay | `app/pentacle/questions.tsx`, `src/components/questions/*` | P3, P5, shared files |
| P5 Personal | `app/(tabs)/personal.tsx`, `app/pentacle/personal/*`, `src/components/personal/*`, `src/services/household/*` | P3, P4, shared files |
| Integration owner | every other file, in particular `pentacle-chat-core/src/types/*`, `src/services/pentacleStream.ts`, `app/_layout.tsx`, `app/pentacle/session/*`, `src/components/Session*`, `src/components/voice/*` | packet files |

`src/components/status/*` (PR #8) is locked; it is not edited by any packet. A packet that needs a
change outside its files asks the integration owner, who lands it on `feat/integration-shared`
(smallest change, with a test) and merges it to `main` before the packet rebases onto it.

## Assistant identity (operator requirement)

The home tab, its header and the status surface show the operator's own assistant, as Pentacle
web does (`renderer/app.js` `syncSlotAssistantIcon`). Never hard-code a product name in a visible
string; `tests/assistantIdentity.test.ts` parses `app/` and
`src/components/{bart,status,questions,personal}` and fails on any visible assistant product-name literal
(`Bart`, `BART` or the long form, in string, template or JSX text; lowercase route, telemetry and module
ids such as `'bart'`, the protocol id `bart:assistant` and `testID` values are not visible text). Until P3
merges it also exempts `app/(tabs)/_layout.tsx` (see Consumers below).

`src/services/assistantIdentity.ts` (shared edit S7):

- `selectAssistantIdentity(state): { streamId, name, hostId, sigilKind }` — `streamId` is
  `ASSISTANT_STREAM_ID` (`'bart:assistant'`, equal to `BART_STREAM_ID`); `name` is the assistant
  session's `display_name`, else its `title`, else `'Assistant'` (blank values skipped); `hostId` is
  the session's host (`null` before the session arrives); `sigilKind` is `'djinni'`. Draw the icon as
  that host's machine sigil with kind `djinni` (`ArcaneRingFrame` with the host's machine name).
- `useAssistantIdentity()` subscribes with field equality, so a renamed session re-renders only
  the consumers.

Consumers: the status surface header (`StatusSurface.tsx`, the one sanctioned edit; props
unchanged), the Questions overlay's assistant page (`QuestionsScreen`: name and sigil; P4's local
stand-in is removed), the Personal calendar's "ADDED BY" tag and, from P3, the home tab and its header. P3 owns the `app/(tabs)/_layout.tsx` rewrite
and uses this hook for the home header (name, sigil). Right after P3 merges, the integration owner
sets the home tab's title to `name` and its label to `name` upper-cased, and removes the
`_layout.tsx` exemption from the literal scan. Labels such as "Questions" stay generic.

## Shared constants

- `BART_STREAM_ID = 'bart:assistant'`, exported from `src/components/status/statusSelectors.ts`
  (PR #8). Import it; never re-declare the literal.

## Routes

The root stack already defaults to `headerShown: false` (`app/_layout.tsx`), so new route files need
no shared edit to register. A route sets its own presentation (e.g. the Questions overlay's
`<Stack.Screen options={{ presentation: 'transparentModal', animation: 'fade' }} />`) inside its file.

| Route | File (owner) | Params | Behaviour |
| --- | --- | --- | --- |
| `/(tabs)/bart` | `app/(tabs)/bart.tsx` (P3) | none | Home tab; initial route of the tab navigator. |
| `/(tabs)/personal` | `app/(tabs)/personal.tsx` (P5; P3 may ship a placeholder only if P5 has not landed) | none | Personal tab. |
| `/pentacle/questions` | `app/pentacle/questions.tsx` (P4) | `notificationId?: string` | Full-screen overlay over the current screen. Opens on the first page of that notification when it is still pending, otherwise on page 1. Closing returns with `router.back()`. |
| `/pentacle/personal/lists` | `app/pentacle/personal/lists.tsx` (P5) | none | Lists index; back chevron returns to Personal. |
| `/pentacle/personal/list/[id]` | `app/pentacle/personal/list/[id].tsx` (P5) | `id: string` — the list's id in its authoritative store (URL-encoded) | List detail. |
| `/pentacle/personal/calendar` | `app/pentacle/personal/calendar.tsx` (P5) | `date?: string` (`YYYY-MM-DD`, local day; default today) | Month grid with that day selected. |
| `/pentacle/session/[streamId]` | existing | unchanged | Opening a session from any new surface goes through `performChatOpenNavigation(streamId, router)` (`src/services/chatOpenNavigation.ts`); never push the href directly. |

## Selectors

Both derive only from `PentacleStreamState` — daemon-authoritative notifications and sessions plus
the existing optimistic-answer projection — and from the build's configured assistant role, which
`selectSmartChatList` uses for row order only (it never changes membership or counts). Opening, closing or
paging through a surface never changes either value; a count drops only when the daemon closes the
question or the existing optimistic-answer identity covers it.

### `selectPendingQuestionCount(state): number` — owned by P4

File: `src/components/questions/questionSelectors.ts` (initial export landed by shared edit S6 from
Lead A's tested commit; P4 owns the file afterwards). Consumed by P3's `?` badge (hidden at 0).

Value = the number of pages `n` in the Questions overlay deck ("QUESTION i / n"). One page is one
question item, i.e. `mobileQuestionItems(question).length` per open question — the same rule as a
Chats row's question badge (`openQuestionItemCount` in `app/(tabs)/chats.tsx`):

```ts
selectSmartChatList(state).reduce((sum, chat) => sum + chat.openQuestions.reduce(
  (n, action) => n + mobileQuestionItems(questionForAction(action)).length, 0), 0)
```

`questionForAction` and the `SmartQuestionAction` / `QuestionSubmission` types live in
`src/services/questionSubmit.ts` (shared edit S2); `mobileQuestionItems` comes from
`src/components/MobileQuestions.tsx`.

Then subtract each durable item whose `{ notificationId, questionId }` is in
`selectOptimisticQuestionAnswerIdentities(state)` (`src/services/pentacleStream.ts`): the Chats index
hides a notification only once all of its items are covered, so without this a partial submit would
re-show the sent item. Also subtract each durable item the notification itself marks answered:
its raw entry in `notification.question.questions[i]` has a `state` present and not `'open'`, or a
non-null `answer`. That covers the window after the daemon acknowledges a partial answer and the
optimistic identity clears while the notification is still open. Single-item and legacy questions
count as before. In short: value = deck length = the reduce above − durable items covered by
`selectOptimisticQuestionAnswerIdentities` − durable items the notification marks answered.

Sources: every chat in `selectSmartChatList(state)` including `BART_STREAM_ID` (Bart's own
questions are part of the deck). P4 exports the deck selector it renders from; the count selector
must equal that deck's length for every state (a unit test asserts this).

### `selectOthersNeedingYou(state): SmartChatListItem[]` — owned by P3

File: `src/components/bart/bartSelectors.ts`. The ☰ badge shows `.length` (hidden at 0).

```ts
selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID && smartChatAttention(chat))
```

This is the Chats screen's needs-you rule (`smartChatAttention`: at least one open question action)
minus Bart's own thread. The drawer's NEEDS YOU group is exactly this list, in the same order;
WORKING is `status === 'working'` without attention; IDLE is the rest. Bart's thread is not listed
in the drawer.

## New session (drawer + button)

`useNewSessionFlow({ machines, onOpened })` in `src/components/useNewSessionFlow.tsx` (shared edit
S6) is the one new-session flow: summon sheet, spawn catalog and idempotent spawn intent. It returns
`{ start, spawning, canStart, modal }`; the caller renders `modal` once, disables its button on
`!canStart`, calls `start()` on press, and opens the spawned session in `onOpened(streamId)` through
`performChatOpenNavigation`. `machines` is `SummonMachine[]` (`host`, `title`, `online`). The Chats +
button uses the same hook. Do not copy the spawn logic.

## Tab telemetry

`logFocusedTab` / `logTabPressed` (`src/services/mobileTabsTelemetry.ts`) accept the exported
`MobileTabName`, which includes `'bart'` and `'personal'` (shared edit S6).

## Status surface (locked, PR #8)

`src/components/status/StatusSurface.tsx` default export, props exactly:

```ts
{ updates: PentacleEvent[]; lanes: StatusLane[]; working: boolean; now: number; top: number;
  bottom: number; loading: boolean; error: boolean; showLog: boolean;
  onShowLog(visible: boolean): void; onOpen(streamId: string): void; onLoadEarlier(): void }
```

with `updates = selectStatusUpdates(state)` and `lanes = selectOpenLanes(state)` from
`statusSelectors.ts`. P3 opens it from the Bart header as a full-screen overlay that reuses the
existing data wiring in `app/(tabs)/updates.tsx` (`UpdatesScreen`) unchanged, with the route hidden
from the tab bar (`href: null`) and the overlay's ✕ drawn by P3 outside the component. Any API
change is an integration request, not a packet edit.

## Bart home mounts the session screen

The Bart tab renders the same session screen as every other chat for `BART_STREAM_ID`. The
integration owner exports a named component from `app/pentacle/session/[streamId].tsx` (shared
edit S1):

```ts
export function SessionScreen(props: {
  streamId: string;
  // Replaces the default combined header (back button + status trigger). The session's own
  // transcript, composer, questions and overlays are unchanged.
  header?: React.ReactNode;
}): JSX.Element
```

The route's default export renders `SessionScreen` fed by `useLocalSearchParams`; behaviour of the
session route is unchanged when `header` is absent. With a `header` the screen is embedded: no stack
options, no back/menu header, and no redirect away when the session is missing. The session's own
back button still returns to the Chats route until P3 lands; moving the app's home destination
(`app/index.tsx`, the session back/redirect target, the push-tap target) to the Bart tab is shared
edit S3, merged together with P3. `app/(tabs)/bart.tsx` renders
`<SessionScreen streamId={BART_STREAM_ID} header={<BartHeader … />} />`. P3 does not fork or copy
the session screen.

## Answering questions

P4 answers each action exactly as the Chats row does, by calling
`submitQuestionSubmission(actions, streamId, submission, hooks?)` from `src/services/questionSubmit.ts`
(shared edit S2; `actions` = `usePentacleStreamActions()`):

- a durable item is one `prompt.answer` frame (`actions.answerPrompt`) behind an optimistic answer
  (`beginOptimisticQuestionAnswer` → `queueOptimisticQuestionAnswer`, discarded on failure);
- a legacy keyed question is one unit: `dismissQuestion` by key, then one `sendMessage` with the
  formatted answer text.

A partial submit sends one submission per answered durable item; a legacy action is submittable
only when all of its items are answered. The function throws on the first failure that is not
recoverable from the transcript. New RPC verbs or types (e.g. P6's voice binding) are integration
requests.

## Household RPC (P5)

`sendHouseholdCommand<T>(verb, fields)` in `src/services/pentacleStream.ts` (shared edit S4) sends
`{ type: verb, ...fields }` with a `household-*` request id; `verb` must start with `household.`.
The reply `<verb>.ok` resolves with the whole frame; `<verb>.error` rejects with an `Error` carrying
`errorCode` (the frame's `error_code`). It is an ordinary RPC: it rejects when the stream is not
connected or drops, and is never replayed. Verbs and payload types are owned by P5
(`src/services/household/*`) and the household daemon spec, not by pentacle-chat-core.

## Assembled-home check

Run by the integration owner on each merged `main` head after a packet lands: `npm run typecheck`,
`npm run test:unit`, then the certified harness journey — open app → Bart home → drawer → open a
session → back → ? → answer one question partially → status surface → Personal → list detail →
calendar — reported PASS/FAIL per step. Steps whose packet has not landed are reported `N/A`.
