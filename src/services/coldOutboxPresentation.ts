import { mutatePentacleEventBuckets, peekEventsForStream } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState, PentacleTranscriptItem } from 'pentacle-chat-core';
import { getAssistantStreamId } from '../config/local';
import type { OutboxText } from './outboxStore';

const DAY_MS = 86_400_000;
const ASSISTANT_GENERATION = 'assistant-composite-v1';
type Origin = { streamId: string; generation: string; requestId: string; composite: boolean };
type Preview = Pick<PentacleSessionSummary, 'last_text' | 'last_kind' | 'last_event_at' | 'last_text_provenance'>;

const restored = new Map<string, Origin>();
const materialized = new Set<string>();
let localPreviews = new WeakMap<PentacleSessionSummary, { optimisticId: string; prior: Preview }>();
let previewStates = new WeakMap<PentacleStreamState, PentacleStreamState>();

export function resetColdOutboxPresentation() {
  restored.clear();
  materialized.clear();
  localPreviews = new WeakMap();
  previewStates = new WeakMap();
}

export function isOlderRecordedSend(createdAt: number, requestId: string, now: number): boolean {
  const match = /^send-([1-9][0-9]*)-[0-9a-z]{1,6}$/.exec(requestId);
  if (!match) return false;
  const attemptAt = Number(match[1]);
  return [createdAt, attemptAt, now].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15)
    && now - Math.max(createdAt, attemptAt) > DAY_MS;
}

function originFor(entry: OutboxText, scopeHash: string, generation?: string): Origin | undefined {
  const frame = entry.frame;
  const requestId = frame?.request_id;
  if (entry.scopeHash !== scopeHash || entry.removed || !entry.id || !entry.streamId || !frame
    || frame.type !== 'send' || typeof requestId !== 'string'
    || (frame.attachments !== undefined && (!Array.isArray(frame.attachments) || frame.attachments.length > 0))
    || frame.reply_to_message_id !== undefined || frame.reply_to_question_id !== undefined || frame.meta !== undefined) return;
  if (frame.msg_id === entry.id && frame.optimistic_id === undefined
    && frame.host === undefined && frame.session_name === undefined && frame.text === undefined
    && frame.stream_id === entry.streamId && entry.streamId === getAssistantStreamId()
    && typeof frame.message === 'string' && frame.message.trim()
    && (entry.originGeneration == null || (typeof entry.originGeneration === 'string' && entry.originGeneration))) {
    return { streamId: entry.streamId, generation: entry.originGeneration ?? generation ?? ASSISTANT_GENERATION,
      requestId, composite: true };
  }
  if (frame.optimistic_id === entry.id && frame.msg_id === undefined
    && frame.stream_id === undefined && frame.message === undefined
    && typeof frame.host === 'string' && frame.host && typeof frame.session_name === 'string' && frame.session_name
    && `${frame.host}:${frame.session_name}` === entry.streamId
    && typeof frame.text === 'string' && frame.text.trim()
    && typeof entry.originGeneration === 'string' && entry.originGeneration) {
    return { streamId: entry.streamId, generation: entry.originGeneration, requestId, composite: false };
  }
}

function matchesSession(origin: Origin, session: PentacleSessionSummary): boolean {
  return (session.session_kind === 'assistant_composite') === origin.composite
    && (session.session_generation ?? (origin.composite ? ASSISTANT_GENERATION : undefined)) === origin.generation;
}

export function hasObservedAuthoritativeUser(
  entry: OutboxText, scopeHash: string, state: PentacleStreamState,
): boolean {
  const session = state.sessions.find(row => row.stream_id === entry.streamId);
  // Legacy records without a generation may be folded in the UI. They do not
  // carry enough identity to skip materialization on an observed echo.
  if (!entry.originGeneration || session?.session_generation !== entry.originGeneration) return false;
  const origin = originFor(entry, scopeHash, session.session_generation);
  if (!origin || !matchesSession(origin, session)) return false;
  return peekEventsForStream(state, entry.streamId).some(event => {
    if (event.stream_id !== entry.streamId || event.kind !== 'USER' || event.optimistic_id !== entry.id) return false;
    if (event.raw?.session_generation !== undefined && event.raw.session_generation !== origin.generation) return false;
    const seq = event.client_origin === true ? event.correlatedDaemonSeq : event.daemon_seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0;
  });
}

function matchesRow(state: PentacleStreamState, id: string, origin: Origin): boolean {
  const row = state.optimisticSends?.[id];
  return row?.status === 'failed' && row.request_id === origin.requestId && row.stream_id === origin.streamId;
}

function isLocalFailedEvent(event: PentacleEvent, ids: ReadonlySet<string>): boolean {
  return event.client_origin === true && event.correlatedDaemonSeq == null
    && event.optimistic_id !== undefined && ids.has(event.optimistic_id);
}

export function isEarlierLocalMessage(item: PentacleTranscriptItem, ids: ReadonlySet<string>): boolean {
  return item.sendState === 'failed' && item.optimisticId !== undefined
    && ids.has(item.optimisticId) && item.correlatedDaemonSeq == null;
}

export function presentEarlierLocalMessages(
  items: readonly PentacleTranscriptItem[],
  ids?: ReadonlySet<string>,
  revealed?: readonly PentacleTranscriptItem[],
): readonly PentacleTranscriptItem[] {
  if (!ids?.size) return items;
  return [...items.filter(item => !isEarlierLocalMessage(item, ids)), ...(revealed ?? [])];
}

const NO_IDS: ReadonlySet<string> = new Set();
export function earlierLocalMessageIds(state: PentacleStreamState, streamId: string): ReadonlySet<string> {
  if (!restored.size) return NO_IDS;
  const session = state.sessions.find(row => row.stream_id === streamId);
  if (!session) return NO_IDS;
  const ids = new Set<string>();
  for (const [id, origin] of restored) {
    if (origin.streamId === streamId && matchesSession(origin, session) && matchesRow(state, id, origin)) ids.add(id);
  }
  return ids.size ? ids : NO_IDS;
}

export function rememberColdRestoredFailure(
  entry: OutboxText, scopeHash: string, previous: PentacleStreamState, next: PentacleStreamState, now: number,
): boolean {
  if (materialized.has(entry.id)) return false;
  materialized.add(entry.id);
  const before = previous.sessions.find(session => session.stream_id === entry.streamId);
  const origin = originFor(entry, scopeHash, before?.session_generation);
  if (!origin || !isOlderRecordedSend(entry.createdAt, origin.requestId, now) || !matchesRow(next, entry.id, origin)) return false;
  if (before && !matchesSession(origin, before)) return false;
  const events = peekEventsForStream(next, origin.streamId);
  if (events.some(event => event.optimistic_id === entry.id
    && (event.client_origin !== true || event.correlatedDaemonSeq != null))) return false;
  const local = events.find(event => event.optimistic_id === entry.id
    && event.client_origin === true && event.correlatedDaemonSeq == null);
  if (!local) return false;

  restored.set(entry.id, origin);
  const after = next.sessions.find(session => session.stream_id === origin.streamId);
  if (before && after && before !== after && after.last_event_at === local.timestamp
    && after.last_text === local.text && after.last_kind === local.kind) {
    // Only this exact object is known to carry a locally projected preview.
    // A later inventory can carry the same text verbatim and is authoritative.
    localPreviews.set(after, { optimisticId: entry.id, prior: localPreviews.get(before)?.prior ?? {
      last_text: before.last_text, last_kind: before.last_kind,
      last_event_at: before.last_event_at, last_text_provenance: before.last_text_provenance,
    } });
  }
  return true;
}

export function retireColdRestoredFailures(state: PentacleStreamState) {
  for (const [id, origin] of restored) {
    const session = state.sessions.find(row => row.stream_id === origin.streamId);
    if (!matchesRow(state, id, origin) || (session && !matchesSession(origin, session))) restored.delete(id);
  }
}

export function coldOutboxPreviewState(state: PentacleStreamState): PentacleStreamState {
  if (!restored.size) return state;
  const cached = previewStates.get(state);
  if (cached) return cached;
  const byStream = new Map<string, ReadonlySet<string>>();
  for (const { streamId } of restored.values()) {
    if (byStream.has(streamId)) continue;
    const ids = earlierLocalMessageIds(state, streamId);
    if (ids.size) byStream.set(streamId, ids);
  }
  if (!byStream.size) return state;
  const sessions = state.sessions.map(session => {
    const local = localPreviews.get(session);
    return local && byStream.get(session.stream_id)?.has(local.optimisticId) ? { ...session, ...local.prior } : session;
  });
  // The core projection owns its event identities and indexes. Build a view
  // over the affected streams only; the transport continues using the input.
  let presentation = { ...state, sessions };
  for (const [streamId, ids] of byStream) {
    const events = peekEventsForStream(state, streamId);
    const visible = events.filter(event => !isLocalFailedEvent(event, ids));
    if (visible.length !== events.length) {
      presentation = mutatePentacleEventBuckets(presentation, { type: 'replace-stream', streamId, events: visible });
    }
  }
  previewStates.set(state, presentation);
  previewStates.set(presentation, presentation);
  return presentation;
}
