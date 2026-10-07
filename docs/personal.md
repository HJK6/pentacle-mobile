# Personal, Lists and Calendar

The Personal tab and its Lists and Calendar pages (design handoff `design_handoff_bart_home`
README §§ 7–9). Routes and file ownership: [bart_home_contracts.md](bart_home_contracts.md).

## Where the data lives

There is no list or calendar store in the app or the daemon. Every row is a row of the
household store (Cosmo), which the operator shares with a second household member:

| Screen | Data |
| --- | --- |
| Lists › To-do, Grocery, Meals, Chores, Study plan | Cosmo lists `tasks`, `grocery`, `meals`, `chores`, `study` |
| Personal TO-DO | open items from those lists that are priority `hi` or due today, tomorrow or earlier |
| Personal TODAY | Cosmo events dated today (all-day first, then by time) |
| Personal UPCOMING | the next four events after today up to today + 7, by date then time |
| Calendar | Cosmo events of the shown month |

The app talks only to the Pentacle daemon, through `sendHouseholdCommand` in
`src/services/pentacleStream.ts` and six verbs (`household.snapshot`, `household.item.add`,
`household.item.done`, `household.item.remove`, `household.event.add`, `household.event.remove`;
daemon side: Pentacle `docs/chat_protocol.md`
§ Household). The daemon accepts only the operator's own connection and calls Cosmo with a
credential that acts for the operator. Cosmo decides visibility on the server: the operator sees
their own private rows and shared rows, never the other person's private rows. The app never
sends a `scope`, `priority`, `due_date` or `created_by`, so everything created here is private to
the operator. Priority and due dates are set by the assistant, not in the app.

## Code

- `src/services/household/types.ts` — wire shapes.
- `src/services/household/selectors.ts` — pure display rules: list order and names, sort
  (priority `hi` → `med` → `lo`, then Cosmo order), tags (`OVERDUE`/`DUE TODAY` red,
  `DUE TOMORROW`/`DUE <MMM D>`/`HIGH` amber, `LOW` muted), who labels, time format, route-date
  parsing.
- `src/services/household/householdClient.ts` — one function per verb.
- `src/services/household/householdStore.ts` — last snapshot plus UI state; no persistence.
- `src/components/personal/*` — `PersonalHome`, `ListsIndex`, `ListDetail`, `CalendarView`,
  `AddEventSheet`, shared atoms in `parts.tsx`.
- Routes: `app/(tabs)/personal.tsx`, `app/pentacle/personal/{lists,list/[id],calendar}.tsx`.

## Behaviour that is easy to get wrong

- **Days are America/Chicago.** "Today" is `snapshot.today` from the daemon; all day arithmetic is
  on `YYYY-MM-DD` strings. The phone's clock or time zone never decides a day. The calendar's
  `date` route parameter outside 2000-01-01 … 2100-12-31, or malformed, falls back to today.
- **Who is display only.** The daemon sends viewer-relative values: `who` `self` → `ME`,
  `partner` → the partner's display name in capitals (from the snapshot's `people.partner`, set by
  the daemon's runtime config; default `Partner`), `both` → `ME + <NAME>`. A private event tagged
  with the partner shows ` · PRIVATE`, and the new-event sheet says `PRIVATE TO YOU · <NAME> WON'T
  SEE THIS` while the partner toggle is on. Sharing is done by the assistant, never by the `who`
  tag. No household member's name is in this source.
- **Assistant attribution** follows `created_by: assistant` (the operator's assistant) only. Those
  rows show the assistant's lamp, its machine sigil from `useAssistantIdentity().sigilKind`, on
  Personal to-do and event rows, list rows and calendar agenda rows. Calendar agenda rows also read
  `ADDED BY <assistant name>` (the name from `useAssistantIdentity().name`, in capitals), and the
  month grid draws their day dots green instead of dim. A due date or priority alone never counts
  as attribution (the partner's assistant can set those on shared rows).
- **Checks.** Ticking an item starts a client-side 5 s window (`UNDO · Ns`, shrinking green bar);
  undo inside it sends nothing; at 5 s exactly one `household.item.done` is sent. ✕ removes now;
  removing a recurring chore's open occurrence records it as skipped in Cosmo.
- **Unknown outcomes are never resubmitted.** If a change times out or the daemon answers
  `unknown_outcome`, the app reads back immediately and again 6 s after that read finishes
  (`Couldn't confirm — checking again`). If the row then appears (or is gone, for a removal)
  nothing more happens; otherwise it shows `Not saved` and leaves the next action to the user. A
  failed read never decides (the kept snapshot may predate the write): the action stays
  unresolved, with Add/Save disabled or the row hidden, and is read again every 6 s until a read
  succeeds.
- **Calendar months.** ‹ / › in the Calendar header page one month at a time (2000-01 … 2100-12).
  Paging into today's month selects today; any other month selects the 1st. Off today's month the
  header reads `<YEAR> · BACK TO TODAY`, which returns to today. Paging and back-to-today are held
  while a change is unresolved, so the readbacks and the screen agree on the month. The `date`
  route parameter still opens on a given day.
- **New-event date.** The DATE field (`WED OCT 7`, with `, 2027` when the year is not today's)
  opens an inline month calendar with its own ‹ / › paging; tapping a day picks it and closes the
  picker. Paging the picker fetches nothing. An event may be saved in any month: on Save the
  calendar moves to the event's month with its day selected, and every readback for that event
  (and for a removal) reads the event's own month.
- **Loading.** Until the first snapshot arrives each screen shows the shared `Spinner` atom; a
  failed first read shows `Household store unavailable` instead.
- **Freshness.** The app refetches on screen focus, on returning to the foreground, on
  pull-to-refresh (Personal) and after each change; there is no live push yet.

## Deviations from the design original

D1 no "New list" (Cosmo lists are fixed); D2 `OVERDUE` tag; D3 `2:30p` times and `ALL DAY`;
D4 retired: the calendar now pages months, as in the updated design (see Calendar months); D5 `HIGH`/`LOW`
priority tags replace `FLAGGED`, lists sort by priority, later due dates are tagged; D6 the
private-event note/suffix and attribution-only lamps.

## Tests

`npm run test:unit -- tests/personal` (selectors, client, store timeline, every screen, static
check that no `todo.*`/`v2_todo` verb is used). The suites mock only `sendHouseholdCommand` with a
fake daemon (`tests/personal/support.ts`) that also fails any test sending a forbidden field.
