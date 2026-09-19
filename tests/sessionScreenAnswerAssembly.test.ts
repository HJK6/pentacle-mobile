// Public synthetic fixtures preserve the reviewed notification-answer wire shapes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assembleSessionTranscriptRows,
  formatNotificationAnswerTellItem,
} from '../app/pentacle/session/[streamId]';
import { buildDurableQuestionAnswerText } from '../src/services/agentQuestionNotifications';
import { isSessionSending } from 'pentacle-chat-core';
import type { PentacleSessionSummary, PentacleTranscriptItem } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

const NOTIFICATION_ID = '00000000-0000-4000-8000-000000000001';

// Synthetic notification-answer fixture.
const LIVE_NOTICE = [
  `[pentacle-notice:notification-answer-${NOTIFICATION_ID}]`,
  '[notification.answer]',
  `notification_id=${NOTIFICATION_ID}`,
  'answer=continue',
  'choice=True',
  'by=operator',
].join('\n');

const RAW_MARKER_RE = /\[pentacle-notice|\[notification\.answer\]|notification_id=|"type":"notification\.answer"/;

// The detail echo the daemon replays into the producer's own stream: a USER bubble carrying the
// raw notice text. This is what the transcript feeds through formatNotificationAnswerTellItem.
function detailNoticeEcho(id: string, text: string): PentacleTranscriptItem {
  return {
    id,
    timestampLabel: '',
    label: 'You',
    tone: 'user',
    provider: 'codex',
    source: 'chat',
    text,
    kind: 'USER',
    isUser: true,
    eventCase: 'user-message',
    displayRule: 'bubble:user',
  };
}

// Mirrors the SessionQuestionAnswerProjection shape the real transcriptData iterates (source is the
// 'pane' | 'durable' union, so the pane-vs-durable guards below are exercised as in the product).
type AnswerProjection = {
  key: string;
  source: 'pane' | 'durable';
  attemptId: number;
  notificationId: string;
  childCount: number;
  answeredAt: string;
  pending: boolean;
  text: string;
};

// The authoritative resolved-notification projection (built from the durable notification, one per
// answerable child). childCount=1 => the single answer fully covers the notification.
function authoritativeProjection(): AnswerProjection {
  return {
    key: `durable:${NOTIFICATION_ID}:q-primary`,
    source: 'durable',
    attemptId: 0,
    notificationId: NOTIFICATION_ID,
    childCount: 1,
    answeredAt: '2026-09-17T14:33:20.000Z',
    pending: false,
    text: buildDurableQuestionAnswerText({
      notificationId: NOTIFICATION_ID,
      actionKind: 'answered',
      selections: ['continue'],
    }),
  };
}

// Assemble via the REAL screen helper the transcriptData memo calls — NOT a reproduced pipeline —
// so the test exercises the exact code that builds the rendered FlatList. The delegation guard at
// the bottom pins the memo to this helper, so a regression that bypasses or overwrites the
// filtering cannot leave the test green (the cycle-1 evidence hole).
function assemble(input: {
  detail: PentacleTranscriptItem[];
  authoritative: AnswerProjection[];
  local?: Record<string, AnswerProjection>;
  eventTimestamps?: Map<string, string>;
}): PentacleTranscriptItem[] {
  const { detail, authoritative, local = {}, eventTimestamps = new Map<string, string>() } = input;
  return assembleSessionTranscriptRows(authoritative, local, detail, eventTimestamps);
}

function answerRows(rows: PentacleTranscriptItem[]) {
  return rows.filter((row) => row.displayRule === 'activity:question');
}

function rawRows(rows: PentacleTranscriptItem[]) {
  return rows.filter((row) => RAW_MARKER_RE.test(row.text));
}

test('AC2: the live notice echo + authoritative projection assemble to exactly one card, zero raw markers', () => {
  const rows = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
  });

  // Exactly one answer card survives — the authoritative "Operator answered" row.
  expect(answerRows(rows)).toHaveLength(1);
  expect(answerRows(rows)[0].eventCase).toBe('agent-question-answer');
  expect(answerRows(rows)[0].notificationId).toBe(NOTIFICATION_ID);
  // No row leaks the raw transport bytes.
  expect(rawRows(rows)).toEqual([]);
  // And no raw `bubble:user` echo of the notice survives at all.
  expect(rows.some((row) => row.displayRule === 'bubble:user' && RAW_MARKER_RE.test(row.text))).toBe(false);
});

test('AC2: a repeated echo of the same notice still assembles to a single card', () => {
  const rows = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE), detailNoticeEcho('echo-2', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
  });

  expect(answerRows(rows)).toHaveLength(1);
  expect(rawRows(rows)).toEqual([]);
});

test('AC2: suppression survives a remount with the transient local projection map cleared', () => {
  // On remount the in-memory questionAnswerProjections map is empty; suppression must key on the
  // notice bytes + the authoritative projection, NOT the transient local map.
  const rows = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
    local: {},
  });

  expect(answerRows(rows)).toHaveLength(1);
  expect(rawRows(rows)).toEqual([]);
});

test('AC2: a differing-key local durable projection is deduped against the authoritative card', () => {
  // The optimistic local projection was built with a child index while the authoritative one used
  // the durable questionId, so authoritativeKeys misses it; the fully-covered notification filter
  // must still drop the duplicate "Operator answered" card (spec AC2, product edit #3).
  const local = {
    'local-key': {
      ...authoritativeProjection(),
      key: `durable:${NOTIFICATION_ID}:0`,
    },
  };
  const rows = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
    local,
  });

  expect(answerRows(rows)).toHaveLength(1);
  expect(rawRows(rows)).toEqual([]);
});

test('AC2: PARTIAL coverage (one of two children projected) does NOT suppress the echo at the screen', () => {
  // A two-child notification with only one authoritative projection is NOT fully covered. The echo
  // carries no child identity, so suppressing it could hide the only representation of the second
  // child's answer — it must survive on screen alongside the one authoritative card. Over-showing
  // is recoverable; hiding is not. (Cycle-1 coverage gap: the screen was only exercised at
  // childCount=1.)
  const partialAuthoritative = { ...authoritativeProjection(), childCount: 2 };
  const rows = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE)],
    authoritative: [partialAuthoritative],
  });

  // Two answer rows: the authoritative card AND the un-suppressed (normalized, non-raw) echo.
  expect(answerRows(rows)).toHaveLength(2);
  expect(rawRows(rows)).toEqual([]);
  // The echo survived — every answer row is for this notification, none is a raw bubble.
  expect(answerRows(rows).every((row) => row.notificationId === NOTIFICATION_ID)).toBe(true);
});

test('AC2: suppression is by notification identity, never by text (same text, different id survives)', () => {
  // Two echoes with BYTE-IDENTICAL answer text but different notification ids; only notification A
  // is authoritatively covered. A's echo is suppressed; B's — same text, uncovered — must survive.
  // This pins the never-by-text invariant at the screen layer (cycle-1 finding on the projectionTexts
  // filter: that guard is a narrow pending same-device suppression, not the cross-answer dedup).
  const OTHER_ID = '00000000-0000-4000-8000-000000000002';
  const noticeB = [
    `[pentacle-notice:notification-answer-${OTHER_ID}]`,
    '[notification.answer]',
    `notification_id=${OTHER_ID}`,
    'answer=continue',
    'choice=True',
    'by=operator',
  ].join('\n');

  const rows = assemble({
    detail: [detailNoticeEcho('echo-a', LIVE_NOTICE), detailNoticeEcho('echo-b', noticeB)],
    authoritative: [authoritativeProjection()], // covers A only
  });

  expect(rawRows(rows)).toEqual([]);
  // Exactly two answer rows: A's authoritative card + B's surviving echo (never dropped by text).
  expect(answerRows(rows)).toHaveLength(2);
  expect(answerRows(rows).some((row) => row.notificationId === NOTIFICATION_ID)).toBe(true);
  expect(answerRows(rows).some((row) => row.notificationId === OTHER_ID)).toBe(true);
});

test('AC2: a reconnect replay of the echo does not resurrect the raw notice', () => {
  // First assembly (live), then a reconnect replays the same detail echo. Neither pass leaks raw
  // markers nor adds a second card.
  const first = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
  });
  expect(answerRows(first)).toHaveLength(1);

  const replayed = assemble({
    detail: [detailNoticeEcho('echo-1', LIVE_NOTICE), detailNoticeEcho('echo-1-replay', LIVE_NOTICE)],
    authoritative: [authoritativeProjection()],
  });
  expect(answerRows(replayed)).toHaveLength(1);
  expect(rawRows(replayed)).toEqual([]);
});

test('AC2: formatNotificationAnswerTellItem recognises the wrapper-prefixed live notice', () => {
  // The specific regression: the wrapper line must not defeat recognition. RED at 3bb888c9
  // (local parser required the first line to be `[notification.answer]`); GREEN here.
  const formatted = formatNotificationAnswerTellItem(detailNoticeEcho('echo-1', LIVE_NOTICE));
  expect(formatted.eventCase).toBe('agent-question-answer');
  expect(formatted.notificationId).toBe(NOTIFICATION_ID);
  expect(formatted.displayRule).toBe('activity:question');
  expect(RAW_MARKER_RE.test(formatted.text)).toBe(false);
});

// --- isSessionSending (header-symptom) oracle, exact live bytes for THIS notification ------------
// The "header stuck sending" symptom is driven by the chat-core isSessionSending selector. The
// store reconciliation is also covered verbatim in tests/questionAnswerNoticeReconcile.test.ts;
// this asserts it for the 95e32c18 continue/choice=True bytes exercised above.

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ wasClean: false }); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const STREAM_ID = 'beta:v2-d77b62f9';

function producerSession(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'beta',
    provider: 'codex',
    session_name: 'd77b62f9',
    last_event_at: '2026-09-17T14:33:19.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

test('AC1/AC6: the live continue-answer notice clears "sending" for this notification', () => {
  jest.useFakeTimers({ now: Date.parse('2026-09-17T14:33:20.000Z') });
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [producerSession()] });

  const optimisticId = stream.beginOptimisticQuestionAnswer({
    streamId: STREAM_ID,
    text: buildDurableQuestionAnswerText({ notificationId: NOTIFICATION_ID, actionKind: 'answered', selections: ['continue'] }),
    notificationId: NOTIFICATION_ID,
  });
  stream.queueOptimisticQuestionAnswer(optimisticId);
  expect(isSessionSending(stream.getPentacleStreamState(), STREAM_ID)).toBe(true);

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 452259425,
      host: 'beta',
      provider: 'codex',
      session_id: STREAM_ID,
      session_name: 'd77b62f9',
      stream_id: STREAM_ID,
      timestamp: '2026-09-17T14:33:21.000Z',
      kind: 'USER',
      text: LIVE_NOTICE,
    },
  });

  const state = stream.getPentacleStreamState();
  expect(isSessionSending(state, STREAM_ID)).toBe(false);
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  const userEvents = state.events.filter((e) => e.stream_id === STREAM_ID && String(e.kind).toUpperCase() === 'USER');
  expect(userEvents).toHaveLength(1);

  unsubscribe();
  jest.clearAllTimers();
});

// --- Source-wiring guard: pin the real transcriptData memo to the pipeline reproduced above ------

test('the transcriptData memo delegates to the exported assembleSessionTranscriptRows helper', () => {
  // The tests above run the REAL helper; this guard ensures the SCREEN memo still routes through it
  // (a regression that stopped calling the helper, or post-processed its rows, would otherwise pass
  // the behavioral tests while the FlatList diverged — the cycle-1 hole).
  const source = readFileSync(resolve('app/pentacle/session/[streamId].tsx'), 'utf8');
  // The shared notice parser (the AC2 regression fix) stays imported and used by the helper.
  expect(source).toContain("import { parseNotificationAnswerNotice } from 'pentacle-chat-core';");
  expect(source).toContain('export function assembleSessionTranscriptRows(');

  // Scope to the transcriptData memo and assert it is a DIRECT delegation to the helper with the
  // four inputs, with no reimplemented pipeline that could drift from the tested code.
  const memoStart = source.indexOf('const transcriptData = useMemo(');
  expect(memoStart).toBeGreaterThan(-1);
  const memoEnd = source.indexOf('useEffect(', memoStart);
  expect(memoEnd).toBeGreaterThan(memoStart);
  const memo = source.slice(memoStart, memoEnd);
  expect(memo).toMatch(
    /assembleSessionTranscriptRows\(\s*authoritativeQuestionAnswerProjections,\s*questionAnswerProjections,\s*detail\?\.transcriptItems\s*\?\?\s*\[\],\s*questionEventTimestamps,\s*\)/,
  );
  // The assembly primitives live ONLY in the helper now, never re-inlined in the memo.
  expect(memo.includes('orderSessionTranscriptRows(')).toBe(false);
  expect(memo.includes('formatNotificationAnswerTellItem')).toBe(false);
  expect(memo.includes('fullyCoveredAnswerNotificationIds(')).toBe(false);
});
