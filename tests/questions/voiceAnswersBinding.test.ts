import {
  VOICE_ANSWERS_VERSION,
  buildVoiceAnswersMeta,
  installVoiceAnswersCarrier,
  isVoiceAnswersCarrierInstalled,
  parseVoiceAnswersStatus,
  registerVoiceAnswersBinding,
  releaseVoiceAnswersBinding,
  voiceAnswersItemCount,
  resetVoiceAnswersForTests,
} from '../../src/components/questions/voice/voiceAnswersBinding';

const item = (n: number) => ({
  key: `n-${n}:0`,
  question_id: `q-n-${n}`,
  notification_id: `n-${n}`,
  producer_stream_id: `hostc:codex:seat-${n}`,
  surface_stream_id: `hostc:codex:surface-${n}`,
  prompt: `Prompt ${n}?`,
  segment: { start_s: n, end_s: n + 2 },
});

beforeEach(() => resetVoiceAnswersForTests());

describe('voice_answers.v1 wire shape (spec § V2)', () => {
  test('buildVoiceAnswersMeta emits exactly the contract fields, with producer and surface ids per item', () => {
    registerVoiceAnswersBinding('rec-1', [item(1), item(2)]);
    expect(buildVoiceAnswersMeta('rec-1', { blobSha: 'sha256:abc', durationS: 9 })).toEqual({
      version: 1,
      recording_id: 'rec-1',
      blob_sha: 'sha256:abc',
      duration_s: 9,
      items: [item(1), item(2)],
    });
    expect(VOICE_ANSWERS_VERSION).toBe(1);
    expect(Object.keys(buildVoiceAnswersMeta('rec-1', { blobSha: 's', durationS: 1 })!).sort())
      .toEqual(['blob_sha', 'duration_s', 'items', 'recording_id', 'version']);
    expect(Object.keys(buildVoiceAnswersMeta('rec-1', { blobSha: 's', durationS: 1 })!.items[0]).sort())
      .toEqual(['key', 'notification_id', 'producer_stream_id', 'prompt', 'question_id', 'segment', 'surface_stream_id']);
  });

  test('a recording without a binding yields no meta (plain voice note)', () => {
    expect(buildVoiceAnswersMeta('rec-none', { blobSha: 's', durationS: 3 })).toBeNull();
    expect(voiceAnswersItemCount('rec-none')).toBe(0);
  });

  test('the binding is frozen at registration: later mutation of the source never reaches the wire', () => {
    const source = [item(1)];
    registerVoiceAnswersBinding('rec-1', source);
    source[0].prompt = 'mutated';
    source.push(item(2));
    expect(buildVoiceAnswersMeta('rec-1', { blobSha: 's', durationS: 1 })!.items).toEqual([item(1)]);
  });

  test('retry identity: every build for one recording is identical (pre-send re-run and post-send resend)', () => {
    registerVoiceAnswersBinding('rec-1', [item(1), item(2)]);
    const first = buildVoiceAnswersMeta('rec-1', { blobSha: 'sha', durationS: 7 });
    const retry = buildVoiceAnswersMeta('rec-1', { blobSha: 'sha', durationS: 7 });
    expect(retry).toEqual(first);
    expect(retry!.recording_id).toBe(first!.recording_id);
    expect(voiceAnswersItemCount('rec-1')).toBe(2);
  });

  test('registering an empty selection is a no-op and release forgets the binding', () => {
    registerVoiceAnswersBinding('rec-0', []);
    expect(buildVoiceAnswersMeta('rec-0', { blobSha: 's', durationS: 1 })).toBeNull();
    registerVoiceAnswersBinding('rec-1', [item(1)]);
    releaseVoiceAnswersBinding('rec-1');
    expect(buildVoiceAnswersMeta('rec-1', { blobSha: 's', durationS: 1 })).toBeNull();
  });

  test('the carrier gate is off until the voice send leg declares it carries meta.voice_answers', () => {
    expect(isVoiceAnswersCarrierInstalled()).toBe(false);
    installVoiceAnswersCarrier();
    expect(isVoiceAnswersCarrierInstalled()).toBe(true);
  });
});

describe('voice_answers_status echo (spec § V2 binding status)', () => {
  test('parses bound and dropped from the echoed event meta', () => {
    expect(parseVoiceAnswersStatus({ voice_answers_status: { state: 'bound', stale_keys: ['n-1:0'] } }))
      .toEqual({ state: 'bound', staleKeys: ['n-1:0'] });
    expect(parseVoiceAnswersStatus({ voice_answers_status: { state: 'dropped', reason: 'identity_mismatch', stale_keys: [] } }))
      .toEqual({ state: 'dropped', reason: 'identity_mismatch', staleKeys: [] });
  });

  test('absent, malformed or unknown status parses to null (never invents a state)', () => {
    expect(parseVoiceAnswersStatus(undefined)).toBeNull();
    expect(parseVoiceAnswersStatus({})).toBeNull();
    expect(parseVoiceAnswersStatus({ voice_answers_status: { state: 'weird' } })).toBeNull();
    expect(parseVoiceAnswersStatus({ voice_answers_status: 'dropped' })).toBeNull();
  });
});
