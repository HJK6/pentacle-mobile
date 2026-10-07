# Questions overlay

`/pentacle/questions` is the Bart-first cross-session answer surface: every open durable question
(Bart's and every session's) one per page, with partial submit. It replaces the Unified tab's
question drawer as the place to answer across sessions. Shared route, selector and answer contracts
live in [bart_home_contracts.md](bart_home_contracts.md); this page records what the overlay does.

## Files

| Path | Role |
| --- | --- |
| `app/pentacle/questions.tsx` | Route. Reads `notificationId?`, sets `presentation: 'transparentModal'`, renders `QuestionsScreen`. |
| `src/components/questions/questionSelectors.ts` | `selectQuestionDeck`, `selectPendingQuestionCount`, `QuestionDeckEntry`. |
| `src/components/questions/submitDeckAnswers.ts` | `submitDeckAnswers`, `sendableKeys`: serial send orchestration over `submitQuestionSubmission`. |
| `src/components/questions/QuestionsScreen.tsx` | The overlay (header, page body, dots, footer, toast). |
| `src/components/questions/SourceMark.tsx`, `DeckDots.tsx` | Source ring and the per-question-accent dots. |
| `src/components/questions/index.ts` | Re-exports; P3 imports `selectPendingQuestionCount` from here. |
| `tests/questions/*` | Selector, submit and screen tests (`fixtures.ts` builds the shared synthetic state). |
| `test/e2e/scenarios/mock_questions_overlay_partial_submit.py` + `fixtures/scripted_daemon/questions_overlay_partial_submit.json` | Simulator scenario (3 questions, answer one). |

## Deck (C1) and count (C2)

`selectQuestionDeck(state)` walks `selectSmartChatList(state)` in its order (Bart included), each
chat's `openQuestions` in order, each action's `mobileQuestionItems(questionForAction(action))` in
order. One item is one page, keyed `${action.id}:${itemIndex}` (the Chats `QuestionPanel` key).
A durable item is dropped when

- its `{notificationId, questionId}` is in `selectOptimisticQuestionAnswerIdentities(state)`
  (Chats hides a multi-item notification only once every item is covered), or
- the notification marks it answered: its raw `question.questions[i]` has a `state` that is present
  and not `open`, or a non-null `answer` (the window after a partial answer is acknowledged and the
  optimistic identity clears while the notification stays open).

`selectPendingQuestionCount(state)` is `selectQuestionDeck(state).length`, which is the contracts v1.5 count (rule unchanged since v1.4)
formula in the contracts. Both are pure functions of state. The deck keeps its array reference while
its content is unchanged (the Chats list rebuilds rows, and legacy actions, on every call), so it is a
safe store selector. Opening, closing or paging never changes the count.

`QuestionDeckEntry` carries `key`, `streamId`, `isBart` (`streamId === BART_STREAM_ID`),
`machineLabel`, `machineName`, `sessionTitle`, `accent` (Bart = `#3dff66`, else the machine accent),
`action`, `itemIndex`, `question`, `questionId` (durable resolver id; `null` for legacy: P6 binds a
recording to `key` + `streamId` + `questionId`) and `locked` (scan-incomplete legacy item, counted
answered exactly as on Chats).

## Answering (C4)

`submitDeckAnswers({ actions, deck, answers })` sends serially, in deck order, through
`submitQuestionSubmission`:

- one submission per answered durable item: `{ action, answers: [answer], items: [item] }`, i.e. one
  `prompt.answer` behind an optimistic answer;
- one submission per legacy action, only when every item of that action is answered
  (`sendableKeys`).

It never throws. Its result is `{ sent, failed, legacyFailed }`:

- `sent`: keys whose call resolved without `onLegacySendFailed`.
- `failed`: keys whose call threw, with the message. The item stays in the deck with its draft and the
  message shows under its page (`questions-item-error`). Remaining answered items are still attempted.
- `legacyFailed`: the question was dismissed by key and its answer message failed. The item left the
  deck (the daemon no longer lists it) and is not counted as sent. The overlay shows the persistent
  line "Answer to <session title> couldn't be sent — retry it from that chat" with **See chat ›**,
  until dismissed (`questions-legacy-dismiss`) or the overlay closes. The optimistic row with Retry
  stays in that chat's transcript, as on Chats.

### Footer (T10–T15)

The footer follows `BartQuestionsOverlay`. "Answered" is `useMobileQuestionFlow.answered`: entries
that are answered and constraint-free, plus locked (scan-incomplete legacy) entries, as on Chats.
Submit and "n unanswered" look only at non-locked answered pages; k in "Submit k of n" counts the sendable subset of it, which differs
only when a multi-item legacy action is partly answered (it cannot be sent, so it is not counted).

| State | Control |
| --- | --- |
| Not the first page | Back, chevron only, outline in accent `55` |
| Any page answered | Submit: "Send all answers" when every page is answered, else "Submit k of n"; filled when last page or all answered, outline otherwise; disabled while k = 0 (only a partly answered multi-item legacy action is answered) |
| Not the last page | Next; filled unless all answered |
| Last page, nothing answered | Disabled "n unanswered" |

- While sending, the submitted items stay pinned on screen (an item leaves the live deck the moment
  its optimistic answer begins, which would otherwise drop its draft); every other page stays live, so
  questions arriving during the send show at once. Submit is disabled meanwhile.
- When the send settles, the outcome is applied against the live deck at that moment (m = its length):
  - **Close:** if nothing failed and no pending question remains, the overlay closes with
    `router.back()` once (Send all normally ends here; so does a partial submit that empties the deck).
    The condition is the settled deck, not an arrival log: a question that arrived and was answered
    elsewhere before settlement does not keep it open.
  - **Toast:** otherwise, if at least one item was sent, toast `Sent ${k} answer(s) · ${m} left` for
    2200 ms (k = items whose call resolved). No toast when nothing was sent.
  - **Landing page:** the first item whose submission threw (durable or legacy dismiss failure), which
    keeps its draft and shows its error on its page; if none threw, page 1.
  - **Legacy send failure** (`onLegacySendFailed`: dismissed by key, answer message failed): the item
    has left the deck and is not counted in k; a persistent banner "Answer to <session title>
    couldn't be sent — retry it from that chat" with See chat › stays until dismissed. If that empties
    the deck the overlay stays on the empty state with the banner instead of closing.
- Close (✕) is `router.back()` and sends nothing; drafts are discarded.

## Screen

- Header: source ring (djinni sigil in lamp green for Bart, the host's machine sigil in its accent
  ring otherwise), `QUESTION i / n` in the page's accent, subtitle `Machine · session title`
  (for the assistant's own questions: the assistant identity name, default `Assistant` — operator requirement R-ident forbids a literal name; `src/components/questions/assistantIdentity.ts` is the single stand-in until shared edit S7's `selectAssistantIdentity(state)`, contracts v1.6, replaces it; the source mark uses the same identity's `sigilKind`), **See chat ›** (hidden for Bart; `performChatOpenNavigation(streamId,
  router)`, never a direct href), an empty accessory slot, ✕. No mic or voice: P6 owns that slot.
- Body: `MobileQuestionOne` for the page's item (options with descriptions, custom, free-text note),
  scrollable and keyboard-avoiding. A `qc-rise` entrance (250 ms opacity + 4 px) plays on mount and on
  every page change.
- Dots: one per page; the active dot is 22 wide in its question's accent, answered dots are accent
  `66`, the rest the line color; tapping a dot goes to that page.
- The current page is tracked by key: a question answered elsewhere disappears, a new one is appended
  in deck order, and neither moves the current page (clamped if its key vanishes).
- Zero pending: "No questions waiting" with ✕ (`questions-empty`).

## Route (C5)

`/pentacle/questions`, param `notificationId?`. It opens on the first page of that notification when it
is still pending (a durable action's `id` is the notification id), otherwise on page 1. The deck can
load after mount (notification backfill); the param is honoured once when it first arrives.

## testIDs

Table elements: `questions-counter`, `questions-see-chat`, `questions-close`, `questions-dot-<i>`,
`questions-back`, `questions-submit`, `questions-next`, `questions-unanswered`, `questions-toast`,
`questions-empty`. Supporting: `questions-overlay`, `questions-subtitle`, `questions-submit-label`,
`questions-unanswered-label`, `questions-header-accessory`, `questions-source-mark`,
`questions-scroll`, `questions-item-error`, `questions-legacy-error` / `-see-chat` / `-dismiss`
(suffix `-1`, `-2`, … for further errors). The question body uses `MobileQuestionOne` with
`testPrefix="questions"` (`questions-prompt`, `questions-option-<n>`, `questions-note`, …).

## Tests

`npx jest tests/questions --runInBand`. The count test implements the v1.4/v1.5 formula independently of
the selector and checks it on single-item, two-item partial-optimistic and two-item post-ack states.
The simulator scenario is `mock_questions_overlay_partial_submit`; it opens the overlay with
`xcrun simctl openurl <SIMULATOR_UDID> pentacle://pentacle/questions`, drives it through the accessibility tree by
testID (falling back to visible text for `Text` nodes, which iOS does not expose by testID), and
reads the single `prompt.answer` from the existing `harness:ui_trace` `prompt_answer_dispatched`
event.

Running it: `test/e2e/run_scenario.py` accepts only its report scenarios, and this repo ships no
runner for `mock_*` scenarios. The scenario is driven by composing the public harness pieces: start
`python3 test/e2e/tools/mock_v2_daemon.py --port <port>`, load the fixture
`test/e2e/fixtures/scripted_daemon/questions_overlay_partial_submit.json` through the scenario's
`params`/`preflight`, boot a dedicated simulator with a Release embedded-bundle harness build
(`EXPO_PUBLIC_HARNESS=1`, `EXPO_PUBLIC_PENTACLE_WS_URL` pointing at the mock daemon; a Debug build
needs Metro), start a `test/e2e/harness/log_capture.LogStream`, and call the scenario's
`run(config, stream, cap)` with `SIMULATOR_UDID`/`PENTACLE_TARGET_UDID`, `scenario_run_id`, `ws_url`.
The recorded PASS (run `p4-003416`) used such a composed driver on a macOS host. Wiring `mock_*`
scenarios into a checked-in runner is outside this packet.
