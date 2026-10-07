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
`action`, `itemIndex`, `question`, `questionId` (durable resolver id; `null` for legacy; the voice binding is built from `key` + `streamId` + `questionId` + the notification's producer, see Voice answers) and `locked` (scan-incomplete legacy item, counted
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
  (for the assistant's own questions: the shared assistant identity name from `useAssistantIdentity()` — the assistant session's display name, then title, then `Assistant`; operator requirement R-ident forbids a literal name, contracts § Assistant identity; the source mark uses the same identity's `sigilKind`), **See chat ›** (hidden for Bart; `performChatOpenNavigation(streamId,
  router)`, never a direct href), the accessory slot (the voice mic when voice answers are available, otherwise empty), ✕.
- Body: `MobileQuestionOne` for the page's item (options with descriptions, custom, free-text note),
  scrollable and keyboard-avoiding. A `qc-rise` entrance (250 ms opacity + 4 px) plays on mount and on
  every page change.
- Dots: one per page; the active dot is 22 wide in its question's accent, answered dots are accent
  `66`, the rest the line color; tapping a dot goes to that page.
- The current page is tracked by key: a question answered elsewhere disappears, a new one is appended
  in deck order, and neither moves the current page (clamped if its key vanishes).
- Zero pending: "No questions waiting" with ✕ (`questions-empty`).

## Voice answers (P6)

Contract: `spec_pentacle_mobile__voice_answers_2026_10` (`voice_answers.v1`). Code: `src/components/questions/voice/`.
The mic answers many durable questions with **one take** and never answers anything itself.

- **Mic** (`questions-voice-mic`, in `questions-header-accessory`): shown only when at least one durable page can
  be bound (it has a resolver id and an asker) **and** the voice send leg declares that it carries
  `meta.voice_answers` (`installVoiceAnswersCarrier`, see Shared dependencies). A deck with no durable page, or a build
  without that leg, shows no mic. Tapping it while recording is Done.
- **Recording** is the app's ordinary voice recording (`voiceRecorder.start(BART_STREAM_ID)`): the take belongs to the
  assistant thread, and upload, transcription and send are the existing voice unit. A busy recorder or a
  denied microphone shows a toast and starts nothing. There is no live transcription.
- **Segments** (`SegmentTracker`): the interval spent on a page while recording. A page whose single visit reaches
  1.5 s is covered (the longest qualifying visit is its segment; visits never add up). The current page reads
  `RECORDING YOUR ANSWER…` until covered, then `ANSWER RECORDED`. Only durable pages that existed at recording start are
  tracked; legacy pages, durable pages without a resolver id and **arrivals during the take** read `ANSWER BY TAP` and
  are never covered.
- **Bar** (`questions-voice-bar`, above the dots): red dot, elapsed, wave, `k of n answered by voice`, green Done.
  k = covered pages the daemon still lists, n = bindable durable pages at recording start (legacy never counts: 3 durable +
  1 legacy covering 2 reads `2 of 3 answered by voice`). At most 20 pages are bound (the daemon limit); the earliest by segment win.
- **Done** freezes the selected set (covered ∩ still listed), registers the binding for the recording id, stops the take and
  leaves the overlay (back to the assistant tab). With nothing covered Done discards the take and stays. The recorder's own
  stops (5-minute cap, interruption, backgrounding) freeze and leave the same way; with nothing covered the delivered take is discarded.
- **Discard**: ✕ (or Android back) while recording asks `Discard this recording?` (`questions-voice-confirm`, keep/discard);
  discarding drops the take, uploads nothing and leaves. Unmounting the overlay by any other route discards a live take.
- **No false answers**: Done, discard, upload and transcription call no answer verb, add no optimistic answer and do not change
  `selectPendingQuestionCount`; a question leaves the deck and the counts only when the daemon closes it.

### Wire shape

`meta.voice_answers` on the voice turn (alongside `meta.voice`), built by `buildVoiceAnswersMeta(recordingId, { blobSha, durationS })`:

```
{ version: 1, recording_id, blob_sha, duration_s,
  items: [{ key, question_id, notification_id,
            producer_stream_id,   // notification.question.producer_stream_id (the asker)
            surface_stream_id,    // agentQuestionSurfaceStreamId (display only)
            prompt, segment: { start_s, end_s } }] }          // ordered by segment start
```

The registry is frozen per recording id and a pure read, so a pre-send re-run (same `recording_id`, same transcribe request id)
and a post-send resend (same transcript, same optimistic row and meta) carry the identical binding; the daemon dedups on `recording_id`.

### Shared dependencies

The overlay compiles and behaves as before on a tree without them (no mic). Each shared edit is routed by the planner:

1. `voiceDelivery` attaches `meta.voice_answers` (`buildVoiceAnswersMeta`) on the send leg, releases it once the send lands, and calls
   `installVoiceAnswersCarrier()`; `PentacleSendMeta` types it.
2. The echoed USER event meta (`voice_answers_status`) reaches the transcript row, and the session renders
   `VoiceAnswersStatusNote` (`Couldn't attach questions` when `dropped`).
3. `VoiceBubble` shows `ANSWERS n QUESTIONS` (`voiceAnswersItemCount`) while the take is transcribing.

Tests: `tests/questions/voice*.test.*`, `VoiceAnswersStatusNote.test.tsx`, `noVoice.test.ts` (no second audio path, no streaming transcription).

## Route (C5)

`/pentacle/questions`, param `notificationId?`. It opens on the first page of that notification when it
is still pending (a durable action's `id` is the notification id), otherwise on page 1. The deck can
load after mount (notification backfill); the param is honoured once when it first arrives.

## testIDs

Table elements: `questions-counter`, `questions-see-chat`, `questions-close`, `questions-dot-<i>`,
`questions-back`, `questions-submit`, `questions-next`, `questions-unanswered`, `questions-toast`,
`questions-empty`. Supporting: `questions-overlay`, `questions-subtitle`, `questions-submit-label`,
`questions-unanswered-label`, `questions-header-accessory`, `questions-source-mark`,
`questions-scroll`, `questions-item-error`, voice: `questions-voice-mic`, `-bar`, `-elapsed`, `-wave`, `-progress`, `-done`, `-page-label`, `-confirm`, `-keep`, `-discard`, `questions-legacy-error` / `-see-chat` / `-dismiss`
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
