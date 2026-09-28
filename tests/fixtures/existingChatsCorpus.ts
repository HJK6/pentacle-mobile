// Reusable corpus of representative EXISTING-CHAT transcripts for the
// "existing chats render" regression lock (spec § T1).
//
// WHY THIS EXISTS
// ---------------
// The operator hit a reg1-class defect: opening an existing chat sometimes
// showed a frozen / truncated transcript ("I don't see the latest messages").
// That is a CLIENT render failure — the data is present in the model but a row
// never reaches the screen. This corpus drives the REAL session-screen render
// path over a set of existing chats and the companion test
// (tests/existingChatsRender.test.tsx) asserts every transcript row the model
// produces actually mounts at the client, and that each message's key content
// is visible.
//
// HOW TO ADD A CHAT
// -----------------
// Append an `ExistingChat` to `EXISTING_CHAT_CORPUS`. Each message becomes a
// daemon `chat.event`; the chat becomes one `session.inventory` entry. The
// test converts the chat with `buildExistingChatFrames(chat)` and asserts the
// `keyContent` fragments render. For a plain user/assistant row, omit
// `keyContent` and the message `text` is used as the expected fragment. For a
// structured row (Option-B answer, tool card) the rendered text differs from
// the on-wire `text`, so provide the visible fragments explicitly via
// `keyContent`. Use `buildAnswerMessage(...)` to add an answer row.
//
// Keep most chats at or under INITIAL_TRANSCRIPT_ROWS (16) messages so EVERY
// message sits in the initial render window and is asserted. Chats longer than
// the window exercise the "latest messages always render" (reg1) + load-earlier
// path; mark them `windowed: true`.

import { buildPentacleQuestionAnswerText } from 'pentacle-chat-core';

export type CorpusMessageKind = 'USER' | 'ASSIST' | 'TOOL_USE';

export interface CorpusMessage {
  kind: CorpusMessageKind;
  /** On-wire event text (what the daemon emitted). */
  text: string;
  /**
   * Visible fragments that MUST appear in the rendered transcript for this
   * message. Defaults to `[text]` for plain bubbles. Provide explicitly when
   * the rendered presentation differs from the on-wire text (answer blocks,
   * tool cards).
   */
  keyContent?: string[];
  /** Optional raw passthrough (e.g. tool metadata) merged onto the event. */
  raw?: Record<string, unknown>;
}

export interface ExistingChat {
  /** Stable corpus id (used in test names). */
  id: string;
  streamId: string;
  host: string;
  provider: string;
  sessionName: string;
  title: string;
  /** Ordered oldest -> newest, exactly as the daemon would replay them. */
  messages: CorpusMessage[];
  /**
   * True when the transcript is intentionally longer than the initial render
   * window (INITIAL_TRANSCRIPT_ROWS). The test then asserts the LATEST window
   * renders (the reg1 lock) and drives "load earlier" to reveal the rest,
   * instead of requiring every message up-front.
   */
  windowed?: boolean;
}

/** Helper: build a USER message that carries an Option-B answer payload. */
export function buildAnswerMessage(input: {
  header: string;
  prompt: string;
  options?: { index: number; label: string }[];
  multiSelect?: boolean;
  selectedOptionLabel?: string;
  selectedOptionLabels?: string[];
  freeText?: string;
  note?: string;
  keyContent: string[];
}): CorpusMessage {
  const answer: Record<string, unknown> = {};
  if (input.selectedOptionLabel !== undefined) answer.selectedOptionLabel = input.selectedOptionLabel;
  if (input.selectedOptionLabels !== undefined) answer.selectedOptionLabels = input.selectedOptionLabels;
  if (input.freeText !== undefined) answer.text = input.freeText;
  if (input.note !== undefined) answer.note = input.note;
  const text = buildPentacleQuestionAnswerText({
    question: {
      header: input.header,
      prompt: input.prompt,
      options: input.options ?? [],
      ...(input.multiSelect ? { multiSelect: true } : {}),
    },
    answers: [answer],
  });
  return { kind: 'USER', text, keyContent: input.keyContent };
}

// A long, multi-turn thread used for the windowing / "latest messages always
// render" case. Generated so the newest rows carry recognizable markers.
function buildLongThread(turns: number): CorpusMessage[] {
  const messages: CorpusMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    // Trailing period terminates the marker so "question 1." can never be a
    // prefix-substring of "question 13." in window assertions.
    messages.push({ kind: 'USER', text: `Long-thread question ${turn}.` });
    messages.push({ kind: 'ASSIST', text: `Long-thread answer ${turn} — detailed reply body.` });
  }
  return messages;
}

// Entire corpus is generated synthetic data, independent of recorded chats.
export const EXISTING_CHAT_CORPUS: ExistingChat[] = [
 { id: 'short', streamId: 'hosta:codex:short', host: 'hosta', provider: 'codex', sessionName: 'short', title: 'Synthetic short chat', messages: [{ kind: 'USER', text: 'Describe a blue triangle.' }, { kind: 'ASSIST', text: 'A blue triangle has three sides.' }] },
 { id: 'structured', streamId: 'hostb:codex:structured', host: 'hostb', provider: 'codex', sessionName: 'structured', title: 'Synthetic structured chat', messages: [buildAnswerMessage({header:'Shape',prompt:'Choose a shape', options:[{index:0,label:'Circle'},{index:1,label:'Triangle'}],selectedOptionLabel:'Triangle',keyContent:['Triangle']}), {kind:'TOOL_USE',text:'Synthetic file lookup', keyContent:['Synthetic file lookup']}] },
 { id: 'windowed', streamId: 'hostc:codex:windowed', host: 'hostc', provider: 'codex', sessionName: 'windowed', title: 'Synthetic long chat', messages: buildLongThread(14), windowed: true },
];

export interface InventorySession {
  stream_id: string;
  host: string;
  provider: string;
  session_name: string;
  last_event_at: string;
  last_text: string;
  last_kind: string;
  draft: string;
  pending: boolean;
  working: boolean;
  online: boolean;
}

export interface ChatEvent {
  daemon_seq: number;
  host: string;
  provider: string;
  session_id: string;
  session_name: string;
  stream_id: string;
  timestamp: string;
  kind: string;
  text: string;
  raw?: Record<string, unknown>;
}

const BASE_TIME_MS = Date.parse('2026-06-16T00:00:00.000Z');

// `seqOffset` makes daemon_seq globally unique across chats. The daemon's
// daemon_seq is a single monotonic stream-wide counter, and the client drops
// events whose seq it has already seen — so when seeding MULTIPLE chats onto one
// connection, each chat must start above the previous chat's highest seq, or its
// rows are silently discarded as stale. Pass a running offset per chat.
export function buildExistingChatFrames(
  chat: ExistingChat,
  seqOffset = 0,
): {
  session: InventorySession;
  events: ChatEvent[];
} {
  const events: ChatEvent[] = chat.messages.map((message, index) => {
    const daemonSeq = seqOffset + index + 1;
    return {
      daemon_seq: daemonSeq,
      host: chat.host,
      provider: chat.provider,
      session_id: chat.streamId,
      session_name: chat.sessionName,
      stream_id: chat.streamId,
      timestamp: new Date(BASE_TIME_MS + daemonSeq * 1000).toISOString(),
      kind: message.kind,
      text: message.text,
      ...(message.raw ? { raw: message.raw } : {}),
    };
  });
  const last = chat.messages[chat.messages.length - 1];
  const lastEvent = events[events.length - 1];
  const session: InventorySession = {
    stream_id: chat.streamId,
    host: chat.host,
    provider: chat.provider,
    session_name: chat.sessionName,
    last_event_at: lastEvent?.timestamp ?? new Date(BASE_TIME_MS).toISOString(),
    last_text: last?.text ?? '',
    last_kind: last?.kind ?? 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
  return { session, events };
}

/** Expected visible fragments for a message (defaults to its on-wire text). */
export function expectedFragments(message: CorpusMessage): string[] {
  return message.keyContent ?? [message.text];
}
