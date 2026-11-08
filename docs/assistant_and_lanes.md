# Assistant and work lanes

How the always-on assistant and the work lanes list look and behave on the
phone. All screenshots use invented fixture data from the
[screenshot harness](SCREENSHOT_HARNESS.md); see [Capture notes](#capture-notes).
Source files and tests for the assistant tab are listed in the
[assistant shell guide](assistant_shell.md).

## Always-on assistant

The first tab is the assistant's conversation. The tab and header use the
assistant session's display name (default **Zephyr**). Most screenshots use a
session named **Assistant**; the expanded-specs image has no assistant session
and shows the default name. Setup is in the README's
[Always-on assistant](../README.md#always-on-assistant) section.

<p>
<img src="images/mobile-assistant-home.png" width="260" alt="Assistant tab: header with Sessions button, assistant name, 4 LANES and 1 Blocked, Questions button; the conversation shows lane update cards for an unblocked lane, a decision, a milestone and a completed lane" />
<img src="images/mobile-assistant-sessions.png" width="260" alt="Sessions drawer open over the assistant tab, listing invented sessions under Needs you, Working and IDLE with a message preview on each row and a + button" />
</p>

- **Header.** Left: the **Sessions** button. Its badge counts other chats that
  need an answer. Centre: the assistant's icon and name, a working/idle status
  ring, the open lane count (**N LANES**) and, when any lane is blocked,
  **N Blocked**. Tapping the icon, name or lane count opens the
  [work lanes list](#work-lanes). Right: the voice mic and the **?** Questions
  button. Its badge counts pending questions from every chat, including the
  assistant.
- **Conversation.** The same transcript, composer and voice input as any other
  session. When the daemon publishes a lane update, it appears in the thread as a
  card with its kind (**LANE STARTED**, **LANE Blocked**, **LANE UNBlocked**,
  **DECISION**, **MILESTONE**, **LANE COMPLETED**), the lane title and a one-line
  summary.
- **Sessions drawer.** Slides in from the left. Other chats are grouped as
  **Needs you**, **Working** and **IDLE**, each row with the chat's latest
  message preview. Tap a row to open that chat, or **+** to start a session on a
  machine. Close it with the scrim, system Back or a left swipe.

<p>
<img src="images/mobile-assistant-questions.png" width="260" alt="Questions overlay showing question 1 of 1 from an invented session, with two options, See chat, Skip and an unanswered count" />
<img src="images/mobile-session-status-card.png" width="260" alt="Status card for an invented session: goal, context use, plan with three of five steps done, latest update and a spec list with one issue" />
</p>

- **Questions.** **?** opens one deck with every open question across chats, one
  question per page. Answer some and submit, skip, or use **See chat** to jump to
  the asking chat. Details: [Questions overlay](QUESTIONS_OVERLAY.md).
- **Status card.** In a session that publishes a status card, tap the header
  title to open it:
  goal, context use, plan steps, the latest update and spec progress. On the
  assistant tab, the header opens the lanes list instead.

## Work lanes

A work lane is one stream of work the daemon tracks: its title, state, lead
and specs. Open `/pentacle/lanes` from the assistant header. The map is the
only overview; the grouped list is its bottom sheet. The approved design is
`mobile/Pentacle Lanes Goals.html`, frames 01–02, on the geometry from
`mobile/Pentacle Lanes Flow v2.html`, frames 01–04.

- **Map and sheet.** The first six attention lanes sit clockwise from the top:
  blocked, needs-you, working, then active-idle, with latest update time and
  lane ID breaking ties. Further lanes remain reachable on the outer orbit
  and in the sheet. Drag or tap the sheet handle between 40% and full height.
  At full height, state dots surround the header lamp.
- **Paused lanes.** Recent pauses appear as unlabeled outer icons, clear of
  the bottom arc. Pauses of at least 14 days fold into one `+N` icon and row;
  the row shows the oldest age and unfolds in place. Age uses the last lane
  update, falling back to the lane's update timestamp.
- **Lane rows.** Needs you / Working / Paused groups follow map order. Rows
  show a lane icon, goal title and done/total count, machine/estimate or
  question/blocker text, and a bar split into equal-width goal parts.
  The first two in-progress goals supply the map rings; otherwise the first
  goal supplies one ring. Goals sort by rank then ID, with the transitional
  unassigned part last. Blocked in-progress parts are amber; other started/done
  parts are green. Needs-you lanes retain the question badge and amber rings.
  Node labels show only the lane title; state stays accessible to screen readers. Icons resolve from the stream, then the shared title
  keyword table, then a two-letter monogram. Tap a row or node to zoom.
- **Lane zoom.** The lane is at the centre with its acceptance arc. The app
  reads `work_lanes.show` sequentially in pages of 32 until `members_next` is
  null; inventory frames inline only eight. Rows appear as pages arrive, with
  loaded-subset counts until the final page. A failed page retains fetched rows
  and offers Retry from page one. `detail_revision` invalidates open details
  when source content changes, including work outside the preview; presence
  and no-op scans do not. Mixed revisions restart once, then offer Retry.
  In-progress specs carry labels and arcs; ready and backlog specs occupy
  the outer orbit. Done and deprecated specs fold together as `✓N` and
  unfold in the grouped sheet. The sheet begins with a plain acceptance bar,
  fraction, percent, spec counts and estimate.
- **Spec detail.** Tap a spec to turn it to the top and dim the others.
  The sheet shows state, title, acceptance, estimate and changed age. When
  supplied, it also shows lifecycle dates, worked hours, the lead seat's
  machine/provider/activity/ETA/step, open questions and criteria with open
  entries first and completed entries last. A matching spec log is shown
  only when the lane update identifies that spec. Status and Next use the
  daemon's `status_line` / `next_line`; explicit null stays blank. Older
  streams use the same public first-sentence guard as the daemon. Missing
  optional fields stay hidden. The action opens the lane's visible chat.
- **Back.** First deselect the spec, then return from lane zoom to the map
  with the previous sheet height and scroll position. Chat targets retain
  their original semantics: open session, assistant tab, exact-generation
  read-only history, or Chat unavailable.
- **Working motion.** One native Animated loop drives inward spoke dashes,
  node pulses and lamp breathing. Working lanes and live in-progress spec
  seats participate. Static states stay still; Reduce Motion disables the
  loop, and leaving the screen stops it.
- **Updates and stale data.** Latest update opens the full publication log.
  A publication opens its lane log; a missing lane reports unavailability.
  An unavailable work index keeps the DATA AS OF snapshot banner visible.

When goals are absent, a single whole-lane part uses the uncapped completed
and nondeprecated counts. The inline fallback for an older partial goal contract
is transitional. Legacy nonpaged show replies still work; known incomplete
replies retain their warning. Optional `icon`, `worked`, `criteria`,
`transitions`, `lead_seat`, `status_line` and `next_line` light up when present.
The shared keyword data lives in vendored `pentacle-chat-core/lane_icons.json`;
prose rules and cases live in its `tests/fixtures/summary_prose_cases.json`.

## Capture notes

Captured 2026-10-26 from `81f820e402d49e07e3e7b664794ae85eff31c7b5` under
react-native-web (the [screenshot harness](SCREENSHOT_HARNESS.md)) in headless
Chrome at 390×844, 2× scale, UTC. These are web renders of the real screens, not
native iOS captures, and may differ from iOS in small details. Fixtures:
`assistant:lane_updates` (assistant tab) and `session:status_card`. The lane
flow described above supersedes those historical lane captures; current flow
fixtures and the layout driver are documented in the screenshot harness. The Sessions
drawer and Questions images use the default populated fixture. The server ran
with `EXPO_PUBLIC_SCREENSHOT_HARNESS=1`, `EXPO_PUBLIC_HARNESS=1`,
`EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK=1`, a placeholder `EXPO_PUBLIC_HARNESS_TOKEN`
and `EXPO_PUBLIC_VOICE_RENDER_FIXTURE=1`, which gives voice an in-memory store
on web. Every image was
checked for personal names, real hosts and account details, and carries no
EXIF metadata.
