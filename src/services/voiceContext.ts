import type { PentacleSendMeta } from 'pentacle-chat-core';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Only app-owned logical surfaces may enter the observed UI trail. */
export const VOICE_CONTEXT_PAGES = Object.freeze([
  'assistant', 'chat', 'personal', 'calendar', 'lists', 'list', 'dashboards', 'settings',
  'agents', 'sessions', 'status', 'updates', 'lanes', 'lane', 'lane_history',
  'questions', 'report', 'image', 'other',
] as const);
export type VoiceContextPageId = typeof VOICE_CONTEXT_PAGES[number];
export type VoiceContextV1 = NonNullable<NonNullable<PentacleSendMeta['voice']>['context_v1']>;
export type VoiceContextPage = Omit<VoiceContextV1['visits'][number], 'offset_ms'>;
export const VOICE_CONTEXT_MAX_VISITS = 24;
export const VOICE_CONTEXT_MAX_BYTES = 2048;
const MAX_MS = 300000;
// Explicit end-of-input assertion: no line-terminator or multiline ambiguity.
const IDS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}(?![\s\S])/;
const pages = new Set<string>(VOICE_CONTEXT_PAGES);
const fallback: VoiceContextPage = Object.freeze({ page_id: 'other', title: '' });
const milliseconds = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(MAX_MS, Math.floor(value))) : 0;
function title(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Keep whitespace as word boundaries, remove other control/format characters,
  // then normalize. Cutting at a space must still produce canonical persisted text.
  const clean = value.replace(/\s/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ +/g, ' ').trim();
  return [...clean].slice(0, 48).join('').trim();
}
function page(value: unknown): VoiceContextPage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (typeof input.page_id !== 'string' || !pages.has(input.page_id)) return;
  return {
    page_id: input.page_id, title: title(input.title),
    ...(typeof input.entity_id === 'string' && IDS.test(input.entity_id) ? { entity_id: input.entity_id } : {}),
    ...(typeof input.question_id === 'string' && IDS.test(input.question_id) ? { question_id: input.question_id } : {}),
  };
}
const sameIdentity = (a: VoiceContextPage, b: VoiceContextPage) => a.page_id === b.page_id
  && a.entity_id === b.entity_id && a.question_id === b.question_id;
function frozen(context: VoiceContextV1): VoiceContextV1 {
  context.visits.forEach(Object.freeze);
  Object.freeze(context.visits);
  return Object.freeze(context);
}
export function voiceContextBytes(value: VoiceContextV1): number { return utf8ToBytes(JSON.stringify(value)).length; }
export function createVoiceContext(visible: unknown = fallback): VoiceContextV1 {
  return frozen({ visits: [{ offset_ms: 0, ...(page(visible) ?? fallback) }] });
}

/** Pure immutable accumulator: retain earliest slots and the latest complete identity. */
export function appendVoiceContext(context: VoiceContextV1, visible: unknown, capturedAudioMs: number): VoiceContextV1 {
  const next = page(visible), last = context.visits.at(-1);
  if (!next || (last && sameIdentity(last, next))) return context;
  const visit = { offset_ms: Math.max(last?.offset_ms ?? 0, milliseconds(capturedAudioMs)), ...next };
  const visits = (context.truncated ? context.visits.slice(0, -1) : context.visits.slice()).concat(visit);
  const result: VoiceContextV1 = { visits, ...(context.truncated ? { truncated: true } : {}) };
  if (visits.length > VOICE_CONTEXT_MAX_VISITS || voiceContextBytes(result) > VOICE_CONTEXT_MAX_BYTES) {
    result.truncated = true;
    // Drop from the tail of the earliest slots, never truncate a public app ID.
    while (visits.length > VOICE_CONTEXT_MAX_VISITS || voiceContextBytes(result) > VOICE_CONTEXT_MAX_BYTES) visits.splice(visits.length - 2, 1);
  }
  return frozen(result);
}

/** Clamp late native-tail observations before persisting the immutable send input. */
export function finalizeVoiceContext(context: VoiceContextV1, capturedAudioMs: number): VoiceContextV1 {
  const duration = milliseconds(capturedAudioMs);
  return frozen({ visits: context.visits.map(visit => ({ ...visit, offset_ms: Math.min(visit.offset_ms, duration) })),
    ...(context.truncated ? { truncated: true } : {}) });
}

/** Strict persisted contract; malformed optional metadata cannot enter dispatch. */
export function validVoiceContext(value: unknown, capturedAudioMs: number): value is VoiceContextV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as VoiceContextV1;
  if (Object.keys(context).some(key => key !== 'visits' && key !== 'truncated')
    || (context.truncated !== undefined && context.truncated !== true)
    || !Array.isArray(context.visits) || !context.visits.length || context.visits.length > VOICE_CONTEXT_MAX_VISITS) return false;
  let previous = 0;
  for (const [index, visit] of context.visits.entries()) {
    if (!visit || typeof visit !== 'object' || Array.isArray(visit)
      || Object.keys(visit).some(key => !['offset_ms', 'page_id', 'title', 'entity_id', 'question_id'].includes(key))
      || !Number.isInteger(visit.offset_ms) || visit.offset_ms < previous || visit.offset_ms > milliseconds(capturedAudioMs)
      || (index === 0 && visit.offset_ms !== 0) || typeof visit.title !== 'string' || visit.title !== title(visit.title)) return false;
    const clean = page(visit);
    if (!clean || clean.entity_id !== visit.entity_id || clean.question_id !== visit.question_id) return false;
    previous = visit.offset_ms;
  }
  return voiceContextBytes(context) <= VOICE_CONTEXT_MAX_BYTES;
}

// Visibility only, no recorder, persistence or routing ownership. The presentation
// owner supplies headers/opaque public IDs; never pass screen body or native routes.
let visiblePage = fallback;
const listeners = new Set<() => void>();
export function setVoiceContextPage(value: VoiceContextPage | null): void {
  const next = Object.freeze(page(value) ?? { ...fallback });
  if (sameIdentity(visiblePage, next) && visiblePage.title === next.title) return;
  visiblePage = next;
  for (const listener of listeners) listener();
}
export const voiceContextPageSnapshot = (): VoiceContextPage => visiblePage;
export function subscribeVoiceContextPage(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
