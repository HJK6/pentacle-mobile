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

Open `/pentacle/lanes` from the assistant header. The overview combines the
lane map with a list grouped into Moving, Stalled, Idle and Paused. The first
two lead goals supply the map rings. A stalled lane is amber, an open question
has a badge, and paused lanes appear on the outer orbit. Ages come from progress
or the time the lane entered its paused state; an unknown age is omitted.

Open a lane to see its goals and the existing question card. The app pages
`work_lanes.show` until membership is complete, and groups goals by their
projected class. Open a goal to see its specs, then open a spec for its stage,
criteria, readable status and next lines, trouble signals and recent progress.
Back returns through the same hierarchy. A question on a spec returns to the
lane card. Raw status text, host/provider details, lane history and chat links
are not shown on these screens.

The shared core owns classification, lead-goal selection, sentence selection,
age and hour formatting, and trouble signals. New projection fields are
optional: older daemons use the goal-state fallback, while absent ages,
summaries and other optional facts are omitted. Working animation respects
Reduce Motion and stops when the screen is inactive.

The synthetic `lanes:readable_full`, `lanes:readable_sparse` and
`lanes:readable_old` fixtures exercise the complete, missing-field and older
wire shapes. The [screenshot harness](SCREENSHOT_HARNESS.md) captures the real
components; native release validation remains separate.

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
