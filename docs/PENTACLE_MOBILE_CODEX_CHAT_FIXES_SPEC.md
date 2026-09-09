# Structured Chat Rendering Improvements

This public design note describes two parser fixes and two session-screen UX
features. Examples are synthetic and do not identify a user, host, session, or
private work item.

## Goals

1. Render Codex-style file actions as a bounded file card rather than a prose
   wall.
2. Keep ordinary assistant prose beginning with “I'm”, “I am”, or “I'll” in a
   normal assistant bubble.
3. Respect the user's scroll position and show a new-message indicator.
4. Allow native text selection and copy for message content on iOS.

Composer transport, list navigation, and visual theming are outside this note.

## Event pipeline

```text
normalized event
  → event interpreter (case + display rule)
  → chat model selector (transcript item)
  → session row renderer (layout + accessibility)
```

Relevant display rules are `bubble:assistant`, `activity:progress`,
`activity:file-change`, and `activity:code-block`.

## File-action rendering

An Apply Patch can produce a synthetic event such as:

```text
Added example-project/src/index.ts (+2 -0)
1 +export const answer = 42;
2 +export default answer;
```

The interpreter must recognize `Added`, `Edited`, `Wrote`, `Created`, and
`Updated` prefixes and route them to the file-action rule. The row parser also
handles an action chunk following ordinary prose. The header keeps the action
title and metadata; the body is the diff.

Use a dedicated `FileActionCard` with two zones:

- a non-selectable `Pressable` header that toggles local collapsed state;
- a selectable monospace body, collapsed to six lines with a `+N more lines`
  tail and expanded on header tap.

Do not wrap the body in the `Pressable`; native long-press selection must not
race with the header toggle. Standalone file-action rows still use a bounded
chip detail and never render the entire diff inline.

## Provider-aware prose classification

The short progress heuristic was designed for status text and is too broad for
assistant prose. Pass the provider into classification:

```ts
function classifyAssistantText(text: string, options: { provider?: string } = {}) {
  if (/^(Edited|Updated)\b/i.test(text)) return 'edit-action';
  if (/^(Wrote|Added|Created)\b/i.test(text)) return 'write-action';
  const allowProgress = String(options.provider || '').toLowerCase() !== 'codex';
  if (allowProgress && /^(I'm|I am|I'll|I will|Checking|Inspecting)\b/i.test(text)
      && text.length < 220) return 'assistant-progress';
  return 'assistant-message';
}
```

The `Codex` branch must leave a multi-sentence “I'm going to update the title
helper…” message as `bubble:assistant`. A non-Codex status line such as
“Checking the files (12s)” may retain the progress pill.

## Sticky-bottom scrolling

The session list is inverted, so offset zero is the newest content. Track:

```ts
const [isAtBottom, setIsAtBottom] = useState(true);
const [unreadCount, setUnreadCount] = useState(0);
```

Treat offsets up to 120 px as the bottom. New content auto-scrolls with at most
one animation frame when the user is there. When the user is reading older
content, suppress that scroll and increment the unread count. Render a floating
`↓ N new messages` button above the composer; tapping it scrolls to offset zero
and clears the count. Reaching the bottom manually also clears it.

Initialize the last-seen id during first hydration without showing the pill.
Reset it when `streamId` changes. Explicit actions such as composer focus and
Send may still scroll to the bottom. Keep the existing keyboard dismissal and
do not add timer bursts that can fight user scrolling.

## Native selection

Use separate text props:

```ts
const SELECTABLE_TEXT = { selectable: true, selectionColor: accent };
const NON_SELECTABLE_TEXT = { selectable: false } as const;
```

Apply the selectable props to assistant prose, user text, agent messages, code,
command output, and activity details. Keep headers, timestamps, status labels,
system dividers, option chrome, file-card headers, and the new-message pill
non-selectable. Do not add row-level long-press handlers that steal the native
selection gesture.

Virtualized rows need not support selection across multiple messages; selection
within one text node is the supported behavior.

## Tests

- interpreter tests cover file-action prefixes and provider-aware prose;
- row tests cover bounded diff cards, six-line collapse, header expansion, and
  selectable body text;
- navigation tests cover offset 200, unread increment, pill press, and manual
  bottom dismissal;
- accessibility/render tests distinguish selectable message text from chrome.

All examples should be generated from synthetic fixtures such as
`tool-example-1`, `example-project/src/index.ts`, and local timestamps.

## Validation

Run the focused tests first, then:

```bash
npm run test:unit
npm run typecheck
npm run validate
```

Manual device checks should cover a long diff, an “I'm going to…” assistant
message, scrollback while new events arrive, and long-press copy on prose/code.
