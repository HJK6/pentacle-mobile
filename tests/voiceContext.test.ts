import {
  appendVoiceContext, createVoiceContext, finalizeVoiceContext, validVoiceContext,
  setVoiceContextPage, voiceContextPageSnapshot, voiceContextBytes,
} from '../src/services/voiceContext';
import { VoiceRecorder, type RecordingEngine, type Scheduler, type RecordingOwnership } from '../src/services/voiceRecording';
import { voiceQuestionSnapshot } from '../src/components/questions/voice/voiceAnswersBinding';
import { ASSISTANT_STREAM_ID } from '../src/services/assistantIdentity';

// Exact owner-amended fixture; SHA-256 1402d54a7cd6609ccaa91d7b1132d0425a2150561e4ad87f11e86acfe48acac6.
const ID_ALPHABET = {
  "pattern": "[A-Za-z0-9][A-Za-z0-9._:-]{0,95}",
  "match": "Full string only; reject controls and trailing newlines.",
  "assistant_page_id": "assistant",
  "accept": [
    "q-example-1",
    "q:one",
    "item_2.3",
    "A0"
  ],
  "reject": [
    "q/one",
    "q one",
    "\u00e9",
    "_prefix",
    "q\nline",
    "q-example-1\n",
    "q-example-1\r",
    "q\u0000line",
    "q\tline",
    "q-example-1\u202e",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ]
};

const fixture = { visits: [
  { offset_ms: 0, page_id: 'personal', title: 'Personal' },
  { offset_ms: 3100, page_id: 'calendar', title: 'Calendar' },
  { offset_ms: 7200, page_id: 'questions', title: 'Questions', question_id: 'q-example-1' },
  { offset_ms: 11000, page_id: 'questions', title: 'Questions', question_id: 'q-example-2' },
] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function recorder(ownership?: RecordingOwnership) {
  let capturedMs = 0, handler: (() => void) | undefined;
  const engine: RecordingEngine = {
    mime: 'audio/mp4', nativeUri: 'file:///cache/context.m4a',
    getPermission: jest.fn(async () => 'granted' as const), requestPermission: jest.fn(async () => 'granted' as const),
    start: jest.fn(async () => {}), pause: jest.fn(async () => {}), resume: jest.fn(async () => {}),
    poll: () => ({ level: 0.5, durationMs: capturedMs }),
    stop: async () => ({ uri: 'file:///cache/context.m4a', durationMs: capturedMs }), discard: async () => {},
  };
  const scheduler: Scheduler = { setInterval: fn => { handler = fn; return 1; }, clearInterval: () => { handler = undefined; } };
  return { rec: new VoiceRecorder(engine, scheduler, ownership), engine, at: (ms: number) => { capturedMs = ms; }, tick: () => handler?.() };
}
afterEach(() => { setVoiceContextPage(null); });

test('four visits use exact compact 306-byte metadata and omit false truncated', () => {
  let context = createVoiceContext(fixture.visits[0]);
  for (const visit of fixture.visits.slice(1)) context = appendVoiceContext(context, visit, visit.offset_ms);
  expect(finalizeVoiceContext(context, 15000)).toEqual(fixture);
  expect(voiceContextBytes(context)).toBe(306);
  expect(validVoiceContext(context, 15000)).toBe(true);
  expect(Object.isFrozen(context.visits[0])).toBe(true);
});

test('identity coalesces title changes, while intervening views and Questions next/back remain', () => {
  let context = createVoiceContext({ page_id: 'questions', title: 'Questions', question_id: 'q:one' });
  context = appendVoiceContext(context, { page_id: 'questions', title: 'new title', question_id: 'q:one' }, 100);
  context = appendVoiceContext(context, { page_id: 'questions', title: 'Questions', question_id: 'q-two' }, 200);
  context = appendVoiceContext(context, { page_id: 'questions', title: 'Questions', question_id: 'q:one' }, 300);
  expect(context.visits.map(v => [v.offset_ms, v.question_id])).toEqual([[0, 'q:one'], [200, 'q-two'], [300, 'q:one']]);
  expect(context.visits[0].title).toBe('Questions');
});

test('fixed registry, exact ASCII ID alphabet, code-point title cap and allow-list exclude bodies', () => {
  for (const id of ID_ALPHABET.accept) {
    const context = createVoiceContext({ page_id: 'list', title: 'List', entity_id: id, question_id: id });
    expect(context.visits[0]).toMatchObject({ entity_id: id, question_id: id });
  }
  for (const id of [...ID_ALPHABET.reject, 'q\\nline', 42]) {
    const context = createVoiceContext({ page_id: 'list', title: 'List', entity_id: id, question_id: id } as any);
    expect(context.visits[0]).toEqual({ offset_ms: 0, page_id: 'list', title: 'List' });
  }
  const context = createVoiceContext({ page_id: 'personal', title: ' \t😀'.repeat(60), body: 'secret', token: 'secret', url: 'https://secret.invalid' } as any);
  expect([...context.visits[0].title].length).toBeLessThanOrEqual(48);
  expect(context.visits[0].title).toBe(context.visits[0].title.trim());
  expect(context.visits[0].title).not.toMatch(/[\t\n]/);
  expect(JSON.stringify(context)).not.toContain('secret');
  expect(appendVoiceContext(context, { page_id: 'host-device', title: 'bad' }, 500)).toEqual(context);
  expect(validVoiceContext({ visits: [{ offset_ms: 0, page_id: 'other', title: 'line\ncontrol' }] }, 500)).toBe(false);
});

test('overflow keeps earliest 23 and latest in monotone order, including backwards clock samples', () => {
  let context = createVoiceContext({ page_id: 'list', title: '', entity_id: 'item-0' });
  for (let n = 1; n < 40; n++) context = appendVoiceContext(context, { page_id: 'list', title: '', entity_id: `item-${n}` }, n * 10);
  expect(context.truncated).toBe(true);
  expect(context.visits).toHaveLength(24);
  expect(context.visits.map(v => v.entity_id)).toEqual([...Array.from({ length: 23 }, (_, n) => `item-${n}`), 'item-39']);
  context = appendVoiceContext(context, { page_id: 'personal', title: 'Personal' }, 1);
  expect(context.visits.at(-1)?.offset_ms).toBe(390);
  expect(voiceContextBytes(context)).toBeLessThanOrEqual(2048);
});

test('Unicode UTF8 byte bound trims earliest retained tail slots for the latest whole identity', () => {
  let context = createVoiceContext({ page_id: 'list', title: '😀'.repeat(48), entity_id: '0'.repeat(96) });
  for (let n = 1; n < 40; n++) context = appendVoiceContext(context, { page_id: 'list', title: '😀'.repeat(48), entity_id: String(n).padEnd(96, 'a') }, n);
  expect(context.truncated).toBe(true);
  expect(context.visits.length).toBeLessThan(24);
  expect(voiceContextBytes(context)).toBe(Buffer.byteLength(JSON.stringify(context), 'utf8'));
  expect(voiceContextBytes(context)).toBeLessThanOrEqual(2048);
  expect(context.visits[0].entity_id).toBe('0'.repeat(96));
  expect(context.visits.at(-1)?.entity_id).toBe('39'.padEnd(96, 'a'));
  expect(validVoiceContext(context, 39)).toBe(true);
});

test('finalize clamps late tail to final captured duration and rejects malformed persisted metadata', () => {
  let context = createVoiceContext({ page_id: 'personal', title: 'Personal' });
  context = appendVoiceContext(context, { page_id: 'calendar', title: 'Calendar' }, 1200.9);
  context = appendVoiceContext(context, { page_id: 'list', title: 'List' }, 900000);
  const frozen = finalizeVoiceContext(context, 1000.9);
  expect(frozen.visits.map(v => v.offset_ms)).toEqual([0, 1000, 1000]);
  expect(Object.isFrozen(frozen)).toBe(true);
  for (const bad of [null, [], {}, { visits: [] }, { ...fixture, truncated: false }, { ...fixture, extra: 'body' },
    { visits: [{ offset_ms: 0.5, page_id: 'personal', title: '' }] },
    { visits: [{ offset_ms: 1, page_id: 'personal', title: '' }] },
    { visits: [{ offset_ms: 0, page_id: 'unknown', title: '' }] },
    { visits: [{ offset_ms: 0, page_id: 'personal', title: '', entity_id: 'q/bad' }] },
    { visits: [{ offset_ms: 0, page_id: 'personal', title: '', body: 'bad' }] },
    { visits: [fixture.visits[0], { ...fixture.visits[1], offset_ms: -1 }] },
    { visits: [fixture.visits[0], { ...fixture.visits[1], offset_ms: 300001 }] },
  ]) expect(validVoiceContext(bad, 300000)).toBe(false);
});

test('recorder samples real captured time at visible changes, pauses and resumes without question bindings', async () => {
  const h = recorder();
  setVoiceContextPage(fixture.visits[0]);
  const id = await h.rec.start(ASSISTANT_STREAM_ID);
  for (const page of fixture.visits.slice(1)) { h.at(page.offset_ms); setVoiceContextPage(page); }
  h.at(12000); await h.rec.pause('background');
  setVoiceContextPage({ page_id: 'settings', title: 'Settings' });
  setVoiceContextPage({ page_id: 'lists', title: 'Lists' });
  await h.rec.resume();
  h.at(15000);
  const take = await h.rec.send();
  expect(take.context_v1).toEqual({ visits: [...fixture.visits, { offset_ms: 12000, page_id: 'lists', title: 'Lists' }] });
  expect(take.frozenAnswers).toBeUndefined();
  expect(voiceQuestionSnapshot(id)).toBeUndefined();
  setVoiceContextPage({ page_id: 'settings', title: 'Settings' });
  expect(take.context_v1?.visits.at(-1)?.page_id).toBe('lists');
  expect(h.engine.start).toHaveBeenCalledTimes(1);
});

test('permission dwell is absent and current view starts at zero; frozen context survives later navigation', async () => {
  const h = recorder(), permission = deferred<'granted'>();
  h.engine.getPermission = () => permission.promise;
  setVoiceContextPage({ page_id: 'personal', title: 'Personal' });
  const start = h.rec.start(ASSISTANT_STREAM_ID);
  setVoiceContextPage({ page_id: 'calendar', title: 'Calendar' });
  permission.resolve('granted'); await start;
  h.at(300); h.tick();
  const finished = await h.rec.send();
  expect(finished.context_v1).toEqual({ visits: [{ offset_ms: 0, page_id: 'calendar', title: 'Calendar' }] });
  setVoiceContextPage({ page_id: 'questions', title: 'Questions', question_id: 'q-new' });
  expect(voiceContextPageSnapshot()).toEqual({ page_id: 'questions', title: 'Questions', question_id: 'q-new' });
  expect(finished.context_v1?.visits).toHaveLength(1);
});

test('native paused/reset state blocks route visits before a delayed JS interruption notification', async () => {
  const h = recorder(); setVoiceContextPage({ page_id: 'personal', title: 'Personal' });
  await h.rec.start(ASSISTANT_STREAM_ID);
  h.at(1000); h.tick();
  h.engine.poll = () => ({ level: 0, durationMs: 1000, interrupted: true });
  setVoiceContextPage({ page_id: 'calendar', title: 'Calendar' });
  expect(h.rec.snapshot()?.context_v1?.visits).toHaveLength(1);
  await h.rec.discard();
});

test('repeated recorder runs reset the context and permission denial leaves no fake trail', async () => {
  const h = recorder(); setVoiceContextPage({ page_id: 'personal', title: 'Personal' });
  await h.rec.start(ASSISTANT_STREAM_ID); h.at(1000); await h.rec.discard();
  setVoiceContextPage({ page_id: 'settings', title: 'Settings' }); h.at(0);
  await h.rec.start(ASSISTANT_STREAM_ID); const take = await h.rec.send();
  expect(take.context_v1).toEqual({ visits: [{ offset_ms: 0, page_id: 'settings', title: 'Settings' }] });
  h.engine.getPermission = async () => 'denied';
  await expect(h.rec.start(ASSISTANT_STREAM_ID)).rejects.toThrow('microphone_permission_denied');
  expect(h.rec.snapshot()).toBeNull();
});


test.each([
  ['A \u200b B', 'A B'],
  ['a'.repeat(47) + ' b', 'a'.repeat(47)],
  ['A\t\u200b \nB', 'A B'],
])('title normalization is idempotent at controls and truncation boundaries: %p', (input, expected) => {
  const context = createVoiceContext({ page_id: 'list', title: input });
  expect(context.visits[0].title).toBe(expected);
  expect(validVoiceContext(context, 0)).toBe(true);
  expect(createVoiceContext(context.visits[0])).toEqual(context);
});


test('owner-amended assistant page ID is fixed context vocabulary, independent of route names', () => {
  const context = createVoiceContext({ page_id: ID_ALPHABET.assistant_page_id, title: 'Assistant' });
  expect(context.visits[0].page_id).toBe('assistant');
  expect(validVoiceContext(context, 0)).toBe(true);
  expect(validVoiceContext({ visits: [{ offset_ms: 0, page_id: 'invalid-page', title: 'Assistant' }] }, 0)).toBe(false);
});

test.each(ID_ALPHABET.reject)('full-string ID validation rejects amended fixture %p in both optional fields', id => {
  for (const key of ['entity_id', 'question_id']) {
    const visit = { offset_ms: 0, page_id: 'list', title: 'List', [key]: id };
    expect(validVoiceContext({ visits: [visit] }, 0)).toBe(false);
    expect(createVoiceContext(visit).visits[0]).toEqual({ offset_ms: 0, page_id: 'list', title: 'List' });
  }
});


test.each(['credential', 'server'] as const)('permission wait cannot migrate a draft to a changed %s scope', async changed => {
  let scope = { server: 'wss://synthetic.invalid/ws', credential: 'account-a' };
  const create = jest.fn(async (_stream: string, draft: any) => ({ recordingId: '123e4567-e89b-42d3-a456-000000000001', draft }));
  const ownership: RecordingOwnership = {
    captureScope: () => JSON.stringify(scope), create, checkpoint: async () => {}, finalize: async () => {},
    requestSend: async () => {}, discard: async () => {}, originAvailable: () => true,
  };
  const h = recorder(ownership), permission = deferred<'granted'>(), releaseDraft = jest.fn();
  h.engine.getPermission = () => permission.promise;
  const draft = { originGeneration: 'same-generation', originLabel: 'Original chat', textPrefix: 'Original account draft', images: [] };
  const pending = h.rec.start('hosta:chat', draft, releaseDraft).then(() => null, error => error as Error);
  for (let n = 0; n < 4; n++) await Promise.resolve();
  scope = changed === 'credential' ? { ...scope, credential: 'account-b' } : { ...scope, server: 'wss://other.invalid/ws' };
  permission.resolve('granted');
  const error = await pending;
  try {
    expect(error?.message).toBe('Account or connection changed. Start recording again.');
    expect(create).not.toHaveBeenCalled();
    expect(h.engine.start).not.toHaveBeenCalled();
    expect(releaseDraft).not.toHaveBeenCalled();
    expect(h.rec.snapshot()).toBeNull();
    expect(draft.textPrefix).toBe('Original account draft');
  } finally { await h.rec.discard(); }
});
