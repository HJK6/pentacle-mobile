import { selectSmartChatList } from '../app/(tabs)/chats';

// The one-line chats-list preview shows an agent's Markdown latest message as the
// words it renders to, matching the web sidebar (pentacle renderer/chat_ui_state.js
// plainInlineMarkdown). The chat view keeps full Markdown.
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function stateWithLatest(lastText: string) {
  return {
    sessions: [{
      stream_id: 'laptop:codex:s',
      host: 'laptop',
      provider: 'codex',
      session_name: 's',
      title: 'laptop chat',
      last_event_at: '2026-10-26T12:00:00.000Z',
      last_text: lastText,
      last_kind: 'ASSIST',
      online: true,
    }],
    notifications: [],
    events: [],
    drafts: {},
    workingByStream: {},
    turnsByStream: {},
    optimisticSends: {},
  } as any;
}

function previewFor(lastText: string) {
  const rows = selectSmartChatList(stateWithLatest(lastText));
  expect(rows).toHaveLength(1);
  return rows[0].previewText;
}

test.each([
  ['bold and italics', '**Done**: the *fast* path and _slow_ path', 'Done: the fast path and slow path'],
  ['underscore bold and strike', '__Shipped__ without ~~the old flag~~', 'Shipped without the old flag'],
  ['inline code keeps its content', 'Renamed `src/a_b.ts` and `**raw**`', 'Renamed src/a_b.ts and **raw**'],
  ['link and image', 'See [PR 12](https://example.com/pr/12) and ![chart](https://example.com/c.png)', 'See PR 12 and chart'],
  ['heading prefix', '## Summary of the run', 'Summary of the run'],
  ['list prefix', '- first item', 'first item'],
  ['ordered list prefix', '1. step one', 'step one'],
  ['quote prefix', '> quoted *note*', 'quoted note'],
  ['multi-line latest message', '## Summary\n**Done** with `a.ts`', 'Summary Done with a.ts'],
  ['identifiers stay intact', 'use my_var_name and 2 * 3 * 4', 'use my_var_name and 2 * 3 * 4'],
])('chats list preview reduces %s to plain text', (_label, lastText, expected) => {
  expect(previewFor(lastText)).toBe(expected);
});

test('plain previews are unchanged', () => {
  expect(previewFor('All checks passed on the candidate.')).toBe('All checks passed on the candidate.');
});
