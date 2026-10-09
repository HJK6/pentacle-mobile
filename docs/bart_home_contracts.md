# Bart-first home: frozen shared contracts

Contract version: **v1.9 (2026-10-09)** — v1.9 expands § Work lanes with optional progress, list/map views and a separate lane log; v1.8 adds § Work lanes (daemon-owned lane projection in the header and `/pentacle/lanes`, typed `lane_update` cards); v1.1 corrected § Answering questions and named the S1/S2 exports; v1.2 added § Household RPC (S4); v1.3 drops partially answered durable items from the pending count; v1.4 also drops items the notification itself marks answered; v1.5 lands the initial pending-count selector, the shared new-session flow and the new tab telemetry names (S6); v1.6 makes the assistant's name and icon follow the operator's customization (S7); v1.7 lands P3 with the home destination (S3) and the shared identity in the home tab and header.
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
ids such as `'bart'`, the protocol id `bart:assistant` and `testID` values are not visible text).

`src/services/assistantIdentity.ts` (shared edit S7):

- `selectAssistantIdentity(state): { streamId, name, hostId, sigilKind }` — `streamId` is
  `ASSISTANT_STREAM_ID` (`'bart:assistant'`, equal to `BART_STREAM_ID`); `name` is the assistant
  session's `display_name`, else its `title`, else `'Assistant'` (blank values skipped); `hostId` is
  the session's host (`null` before the session arrives); `sigilKind` is `'djinni'`. Draw the icon as
  that host's machine sigil with kind `djinni`: `AssistantIcon` / `assistantAccent(identity)` in
  `src/components/bart/assistantIdentity.tsx`.
- `useAssistantIdentity()` subscribes with field equality, and the selector returns the previous
  object while the identity is unchanged, so memoized consumers (the home header) re-render only
  on a real rename or host change.

Consumers: the status surface header (`StatusSurface.tsx`, the one sanctioned edit; props
unchanged), the home tab (`app/(tabs)/_layout.tsx`: title = `name`, label = `name` upper-cased, icon
= `AssistantIcon`), the home header (`BartHeader`: name, sigil, accent), the Questions overlay's
assistant page (`QuestionsScreen`: name and sigil) and the Personal calendar's "ADDED BY" tag.
Labels such as "Questions" stay generic.

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
| `/pentacle/lanes` | `app/pentacle/lanes.tsx` (integration owner) | none | The daemon's open work lanes (§ Work lanes). Closing returns with `router.back()`. |
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
`statusSelectors.ts`. Since v1.8 the Bart header no longer opens it (its lanes tap goes to
`/pentacle/lanes`, § Work lanes); it stays reachable from the Updates route
(`app/(tabs)/updates.tsx`, `UpdatesScreen`) unchanged. `src/components/bart/BartStatusOverlay.tsx`
is kept, unmounted from the header. Any API change is an integration request, not a packet edit.

## Work lanes

The daemon owns lane identity, state, counts and order. The client does not infer these from
sessions. Contract fixture: `pentacle-chat-core/tests/fixtures/work-lanes-inventory.json`,
fixture version 2 (SHA256 `2be3dd8d99046c3c8dc293ae4d90a187ab72cb082ef36153d957037a39ddcce1`).
The v1.2 sections remain unchanged. All additional test cases are derived inline.

- **Capability and compatibility.** `hello` sends `capabilities.work_lanes_v1: true`.
  `snapshot.work_lanes` and `work_lanes.inventory` replace the projection in daemon order;
  identical inventory keeps state identity. Absent snapshot inventory keeps the prior value.
  Progress fields, members, observations, estimates and `work_index` are optional. A malformed
  optional field is omitted, never grounds for rejecting a valid v1 inventory. Unknown keys are
  ignored. A v1 connection renders lanes with a specs-pending note; the same mounted view gains
  members on the next valid increment-1 inventory, including after reconnect.
- **Defensive presentation.** `done` lanes are omitted. An active lane without a qualifying lead
  presents as paused with `lead_lost_unreconciled`. Invalid chat pointers fail closed. Counts remain
  the daemon's counts. Header count, header tap, and the thread's `LaneUpdateCard` are unchanged.
- **Shared selector.** `selectLaneCardViewModels(state, now)` in `src/services/workLanes.ts`
  supplies both views: state, member segments, estimates, freshness, update summary and questions.
  State labels are WORKING, ACTIVE · IDLE, BLOCKED, PAUSED and PAUSED · LEAD LOST (both
  `lead_lost` and `lead_lost_unreconciled`). Waiting-on-you is the number of entries in
  `selectQuestionDeck(state)` with the lane's `visible_chat.stream_id`; durable answers and
  composite routing follow the same selector as the Questions overlay.
- **Progress precedence.** First show the overlay's “Data as of <snapshot_at>” marker when
  `work_index.available` is false. Then, first match wins: `no_spec_reason`; N unresolved;
  total zero → No specs; open positive → est. open work; open zero and positive total with all
  completed → All specs done, all dropped → All specs dropped, or mixed completed/dropped →
  No open work. Absent optional counts never imply completion. The coarse range uses
  `open_estimate_h`, `—` for null and `+` for incomplete estimation; no remaining-time countdown.
  Segments represent each inline member: completed full, in-progress/QA AC fraction, unresolved
  red, blocked amber and paused muted. Observations disclose non-fresh quality, observation time
  and errors; the UI does not relabel stale/error data as fresh.
- **Overlay.** `/pentacle/lanes` renders `LanesOverlay` with a list/map toggle, default list.
  Last-view persistence is intentionally omitted. List cards expand inline members; “Show all”
  opens `LaneMembers` when the projection is partial. The map pages ordered lanes eight at a time;
  focus shows at most eight member nodes and a +N control only for `members_total > 8`. That
  control opens the same all-member list. All controls have at least 44pt targets. Member detail,
  all-member and log Back return to their originating view, retaining focus and card expansion.
- **Read-only show RPC.** `requestWorkLaneShow(laneId)` uses the existing `sendCommand` transport
  for `{type: 'work_lanes.show', lane_id}` with the normal RPC timeout. Typed `.ok` and `.error`
  frames settle by `request_id`; no separate connection, daemon or replay path is introduced.
  `parseWorkLaneShow` normalizes all members and three newest-first row sets. Missing update prose
  is enriched by `selectLaneUpdates(state)` using `update_id`, then falls back to kind and time.
  Update-linked audit summaries take precedence. Item-change prior/next snapshots create one
  Spec changes row per changed status, AC or estimate field. Other events are the Events tab.
  Rows sort by created time, then event id. Each tab renders at most 50 rows; Older replaces the
  current page. Errors/timeouts are explicit and retryable; obsolete replies after Back, target
  changes or reconnect cannot replace the current view.
- **Chat navigation.** See chat uses `resolveWorkLaneTap`: open → `performChatOpenNavigation`
  (assistant composite goes home); history → read-only `LaneHistoryScreen` using the exact
  generation and existing `requestLaneHistory`; unavailable → explicit disabled Chat unavailable.
  The chat-history screen is separate from the lane log. No hidden session or guessed fallback.
- **Publications.** Typed `publish_kind: 'lane_update'` events in the assistant timeline keep
  `LaneUpdateCard` behavior and message-id deduplication. Supported kinds remain `major_decision`,
  `lane_started`, `lane_completed`, `lane_blocked`, `lane_unblocked` and `milestone`.
- **Automation contract.** Frozen IDs: `lanes-overlay`, `lanes-view-toggle` (accessibility value
  list/map), `lanes-view-list`, `lanes-view-map`, `lanes-index-banner`; `lane-card-<lane_id>`,
  `lane-card-toggle-<lane_id>` (expanded), `lane-card-state-<lane_id>`,
  `lane-card-progress-<lane_id>`, `lane-card-members-pending-<lane_id>`,
  `lane-card-member-<lane_id>-<spec_id>`, `lane-card-show-all-<lane_id>`;
  `lanes-map-lane-<lane_id>` (label title, state, done/total; selected), `lanes-map-page-prev`,
  `lanes-map-page-next`, `lanes-map-page-label` (1/2), `lanes-map-member-<spec_id>`,
  `lanes-map-more-<lane_id>` (Show all N specs), `lanes-map-back`;
  `lane-members-<lane_id>`, `lane-members-row-<spec_id>`, `lane-members-loading`,
  `lane-members-error`, `lane-members-back`; `member-detail-<spec_id>`, `member-detail-back`;
  `lane-log-<lane_id>`, `lane-log-tab-updates`, `lane-log-tab-spec-changes`,
  `lane-log-tab-events` (selected), `lane-log-row-<n>`, `lane-log-empty`, `lane-log-error`,
  `lane-log-retry`, `lane-log-older`, `lane-log-back`. Log/chat entry IDs are
  `lane-card-log-<lane_id>`, `lanes-map-log-<lane_id>`, `lane-card-chat-<lane_id>` and
  `lanes-map-chat-<lane_id>`. Tappables have accessibility role button.
- **Harness traces.** Only armed harness builds emit `work_lanes_inventory_applied`,
  `work_lanes_view`, `work_lanes_map_render`, `work_lanes_show`, `work_lanes_members_list`
  and `work_lanes_log_rendered`. Payloads contain IDs and counts, never titles or prose.
  `spec_ids_sha256` hashes the UTF-8 JSON array of member IDs in daemon order. Map member-node
  count includes the overflow control. Inventory trace emits when the overlay consumes a new
  inventory; production builds do not emit these traces.

Source checks: focused lane Jest tests, full unit suite, typecheck, chat-core tests, committed-tree
pin, public boundary, and iOS JavaScript export with the ignored example-config stand-in.
These device-free checks do not certify a native build, signing, live-daemon protocol journey or
installation. `src/components/status/*` remains unchanged.

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
  // The header already carries the Questions button, so the in-chat question FAB is not drawn.
  questionsInHeader?: boolean;
}): JSX.Element
```

The route's default export renders `SessionScreen` fed by `useLocalSearchParams`; behaviour of the
session route is unchanged when `header` is absent. With a `header` the screen is embedded: no stack
options, no back/menu header, and no redirect away when the session is missing. The session's own
back button and missing-session redirect return to the home destination `HOME_ROUTE`
(`'/(tabs)/bart'`, `src/services/homeRoute.ts`, shared edit S3), which is also the app's launch
redirect (`app/index.tsx`), the post-enrollment target and the push-tap stack seed. `app/(tabs)/bart.tsx` renders
`<SessionScreen streamId={BART_STREAM_ID} header={<BartHeader … />} questionsInHeader />`: the header's
Questions button is then the only questions control on the home screen, and the glowing in-chat FAB
(`QuestionFab`) stays on every other chat, where it is the sole affordance. P3 does not fork or copy
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
