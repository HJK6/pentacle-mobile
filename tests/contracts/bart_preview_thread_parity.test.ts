/**
 * Chats-list preview must equal the thread's last row for the assistant
 * assistant composite (spec_pentacle_mobile__bart_chat_preview_thread_parity_2026_10).
 *
 * Fixture: the 2026-10-06 receipt tail of the composite (working session, last
 * durable row a USER question with no assistant reply after it). The daemon
 * emits no `last_text` on session rows, so none is set unless a case says so.
 */
import {
  initialPentacleStreamState,
  mutatePentacleEventBuckets,
  selectChatList,
  selectSafeSessionSummaryPreview,
  selectSessionDetail,
} from 'pentacle-chat-core';
import { selectSessionShellSlice } from '../../src/services/pentacleStream';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));

const COMPOSITE = 'fixture-chat:assistant';
const THREAD_VISIBLE_ROWS = 16; // INITIAL_TRANSCRIPT_ROWS in app/pentacle/session/[streamId].tsx
const iso = (minute: number, second: number) => (
  `2026-10-06T23:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`
);

function baseEvent(seq: number, at: string, over: Record<string, unknown>): any {
  return {
    daemon_seq: seq,
    host: 'hosta',
    provider: 'composite',
    session_id: COMPOSITE,
    session_name: 'assistant',
    stream_id: COMPOSITE,
    timestamp: at,
    event_id: String(seq),
    ...over,
  };
}

function userRow(seq: number, at: string, text: string) {
  return baseEvent(seq, at, {
    kind: 'USER',
    text,
    message_id: 'assistant-input:optimistic_bart_assistant_launch',
  });
}

function proseRow(seq: number, at: string, text: string, dispatchId: string) {
  return baseEvent(seq, at, {
    kind: 'ASSIST_TEXT',
    text,
    message_id: `assistant-publish:publish:${dispatchId}`,
    publish_kind: 'prose',
    raw: { assistant_composite: true, publish_kind: 'prose', response_state: 'final', dispatch_id: dispatchId },
  });
}

/** Earlier turns, then the 23:42 operator question with no assistant reply after it. */
function receiptRows(earlierTurns = 0) {
  const rows: any[] = [];
  for (let index = 0; index < earlierTurns; index += 1) {
    rows.push(userRow(455770000 + index * 2, iso(10, index % 60), `earlier question ${index}`));
    rows.push(proseRow(455770001 + index * 2, iso(10, index % 60), `earlier answer ${index}`, `assistant-direct-earlier-${index}`));
  }
  rows.push(userRow(455775469, iso(41, 46), 'How many more spools of the black PTEG filament do I need in order to complete the laptop stand build?'));
  rows.push(proseRow(
    455775491,
    iso(41, 59),
    "**One standard 1 kg spool** should finish the stand, with room to spare.  - **Still to print after tonight's plate:** P2 base (98 g), P5 L-piece (219 g) and the ties (69 g), about **386 g** in total.",
    'assistant-direct-e39718ac9221474bae39194202de86ca',
  ));
  rows.push(userRow(455775519, iso(42, 18), 'To finish all five levels of the stand, not just this one level.'));
  return rows;
}

function compositeSession(over: Record<string, unknown> = {}): any {
  return {
    stream_id: COMPOSITE,
    host: 'hosta',
    provider: 'composite',
    session_name: 'assistant',
    session_kind: 'assistant_composite',
    title: 'Assistant Fixture',
    last_event_at: iso(42, 18),
    draft: '',
    pending: false,
    working: true,
    online: true,
    ...over,
  };
}

function stateWithRows(events: any[], sessionOver: Record<string, unknown> = {}): any {
  const base: any = {
    ...initialPentacleStreamState,
    connected: true,
    sessions: [compositeSession(sessionOver)],
    events: [],
    eventBucketsByStream: undefined,
  };
  return mutatePentacleEventBuckets(base, { type: 'snapshot-replace', events, retainedStreamIds: [COMPOSITE] });
}

function listPreview(state: any) {
  const item = selectChatList(state).find((chat) => chat.streamId === COMPOSITE);
  expect(item).toBeDefined();
  return item!.previewText;
}

function threadLastRow(state: any, visibleCount: number | 'all') {
  // Same options the thread screen passes through selectStreamSlice.
  const detail = selectSessionDetail(state, COMPOSITE, { includeTools: false, includeDraft: false, visibleCount });
  expect(detail).not.toBeNull();
  return detail!.transcriptItems.at(-1);
}

describe('Bart chat-list preview matches the thread (composite, working, last row USER)', () => {
  const QUESTION = 'To finish all five levels of the stand, not just this one level.';

  test.each([
    ['receipt tail', 0],
    ['long history (windowed)', 40],
  ])('(a) windowed detail: %s', (_name, earlierTurns) => {
    const state = stateWithRows(receiptRows(earlierTurns));
    const preview = listPreview(state);
    expect(preview).toBe(threadLastRow(state, 'all')!.text);
    expect(preview).toBe(threadLastRow(state, THREAD_VISIBLE_ROWS)!.text);
    expect(preview).toBe(QUESTION);
  });

  test('(a) a stale summary last_text never replaces the working composite thread row', () => {
    const state = stateWithRows(receiptRows(), {
      last_text: "I'm still getting the full five-level total from the rack lead. I'll post it here as soon as it's in.",
      last_kind: 'ASSIST',
    });
    expect(listPreview(state)).toBe(threadLastRow(state, 'all')!.text);
    expect(listPreview(state)).toBe(threadLastRow(state, THREAD_VISIBLE_ROWS)!.text);
    expect(listPreview(state)).toBe(QUESTION);
  });

  test('(b) cached append: preview tracks the thread after an append over a seeded cache', () => {
    // The cached-append shortcut only applies when the previous last row is a
    // short plain ASSIST row, so seed that shape and then append another one.
    const seeded = [
      ...receiptRows(),
      baseEvent(455775560, iso(42, 30), { kind: 'ASSIST', text: 'Working' }),
    ];
    const before = stateWithRows(seeded);
    expect(listPreview(before)).toBe(threadLastRow(before, 'all')!.text); // seeds the list's detail cache
    const after = mutatePentacleEventBuckets(before, {
      type: 'append',
      events: [baseEvent(455775600, iso(42, 40), { kind: 'ASSIST', text: 'Done' })],
    });
    expect(listPreview(after)).toBe(threadLastRow(after, 'all')!.text);
    expect(listPreview(after)).toBe(threadLastRow(after, THREAD_VISIBLE_ROWS)!.text);
    expect(listPreview(after)).toBe('Done');
  });

  test('(b) cached append: USER-last composite falls back to full selection, preview still equals the thread', () => {
    const before = stateWithRows(receiptRows());
    expect(listPreview(before)).toBe(QUESTION);
    const after = mutatePentacleEventBuckets(before, {
      type: 'append',
      events: [baseEvent(455775600, iso(42, 40), { kind: 'ASSIST', text: 'On it' })],
    });
    expect(listPreview(after)).toBe(threadLastRow(after, 'all')!.text);
    expect(listPreview(after)).toBe(threadLastRow(after, THREAD_VISIBLE_ROWS)!.text);
  });

  describe('(c) pending-history shell (zero retained rows, history not ready)', () => {
    function pendingState(sessionOver: Record<string, unknown>): any {
      return {
        ...initialPentacleStreamState,
        connected: true,
        sessions: [compositeSession(sessionOver)],
        events: [],
        eventBucketsByStream: { [COMPOSITE]: { events: [], request: { status: 'loading' } } },
      };
    }

    test('shell preview text equals the list previewText when the summary is displayable', () => {
      const state = pendingState({ working: false, last_text: 'Stale summary text.', last_kind: 'ASSIST' });
      const shell = selectSessionShellSlice(state, COMPOSITE);
      expect(shell.retainedRows).toBe(0);
      expect(shell.preview).not.toBeNull();
      const safe = selectSafeSessionSummaryPreview(state, COMPOSITE);
      expect(safe).not.toBeNull();
      expect(shell.preview!.text).toBe(safe!.text);
      expect(listPreview(state)).toBe(safe!.text);
    });

    test('working composite shows no shell preview text and no summary text in the list', () => {
      const state = pendingState({ working: true, last_text: 'Stale summary text.', last_kind: 'ASSIST' });
      expect(selectSafeSessionSummaryPreview(state, COMPOSITE)).toBeNull();
      expect(selectSessionShellSlice(state, COMPOSITE).preview).toBeNull();
      expect(listPreview(state)).toBe('Waiting for first message…');
    });
  });
});

describe('turn-final projection row renders as an assistant bubble', () => {
  const DISPATCH = 'assistant-direct-ab64b38362164270aa5f2b57b80b6454';
  const INPUT_IDENTITY = 'assistant-input:optimistic_bart_assistant_launch';
  const TURN_FINAL_TEXT = "I don't have the filament total for all five levels yet. My last answer only counted what's left on the current level.";

  // Canonical shape from spec_pentacle__dispatch_turn_final_projection_2026_10
  // rule 1: explicit-publish-shaped composite tail row, publish_kind status.
  function turnFinalRow(seq = 455775600) {
    const raw = {
      assistant_composite: true,
      publish_kind: 'status',
      response_state: 'acknowledged',
      dispatch_id: DISPATCH,
      reply_to_message_id: INPUT_IDENTITY,
      reply_to_question_id: null,
      mirrored_from: {
        stream_id: 'hosta:front-desk',
        generation: 'gen-fixture-1',
        event_id: '455775533',
        event_ts: '2026-10-06T23:42:32.872Z',
      },
    };
    return baseEvent(seq, iso(42, 33), {
      provider: 'composite',
      kind: 'ASSIST_TEXT',
      text: TURN_FINAL_TEXT,
      message_id: `publication:turnfinal:${DISPATCH}`,
      publish_kind: 'status',
      reply_to_message_id: INPUT_IDENTITY,
      reply_to_question_id: null,
      raw,
    });
  }

  test('assistant bubble is the chats-list preview and the thread last row', () => {
    const state = stateWithRows([...receiptRows(), turnFinalRow()]);
    for (const visibleCount of [THREAD_VISIBLE_ROWS, 'all'] as const) {
      const last = threadLastRow(state, visibleCount);
      expect(last).toEqual(expect.objectContaining({
        text: TURN_FINAL_TEXT,
        kind: 'ASSIST_TEXT',
        tone: 'assistant',
        isUser: false,
        displayRule: 'bubble:assistant',
        messageId: `publication:turnfinal:${DISPATCH}`,
        publishKind: 'status',
        replyToMessageId: INPUT_IDENTITY,
      }));
    }
    expect(listPreview(state)).toBe(TURN_FINAL_TEXT);
    expect(listPreview(state)).toBe(threadLastRow(state, 'all')!.text);
  });

  test('still renders as the last row while the composite is working', () => {
    const state = stateWithRows([...receiptRows(), turnFinalRow()], { working: true });
    expect(threadLastRow(state, THREAD_VISIBLE_ROWS)!.text).toBe(TURN_FINAL_TEXT);
    expect(listPreview(state)).toBe(TURN_FINAL_TEXT);
  });
});
