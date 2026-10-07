// P6: the daemon's voice_answers_status on the stored USER event reaches the transcript item.
test('voice_answers_status on the stored USER event reaches the transcript item (bound, dropped, absent)', () => {
  jest.resetModules();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const STREAM = 'bart:assistant';
  const row = (seq: number, meta?: Record<string, unknown>) => ({
    daemon_seq: seq, host: 'bart', provider: 'claude', session_id: STREAM, session_name: 'assistant', stream_id: STREAM,
    timestamp: `2026-10-07T12:00:0${seq}.000Z`, kind: 'USER', text: `voice ${seq}`, ...(meta ? { meta } : {}),
  });
  const state = {
    ...core.initialPentacleStreamState,
    connected: true,
    sessions: [{ stream_id: STREAM, host: 'bart', provider: 'claude', session_name: 'assistant', last_event_at: '2026-10-07T12:00:00.000Z', last_text: '', last_kind: '', draft: '', pending: false, working: false, online: true }],
    events: [
      row(1, { voice: { duration_s: 7 }, voice_answers_status: { state: 'dropped', reason: 'unknown_question', stale_keys: [] } }),
      row(2, { voice: { duration_s: 7 }, voice_answers_status: { state: 'bound', stale_keys: ['n-1:0'] } }),
      row(3, { voice: { duration_s: 7 } }),
    ],
  } as any;
  const items = core.selectSessionDetail(state, STREAM, { visibleCount: 'all', emitRenderTelemetry: false })!.transcriptItems.filter((item: any) => item.isUser);
  const byText = (text: string) => items.find((item: any) => item.text === text) as any;
  expect(byText('voice 1').voiceAnswersStatus).toEqual({ state: 'dropped', reason: 'unknown_question', staleKeys: [] });
  expect(byText('voice 2').voiceAnswersStatus).toEqual({ state: 'bound', staleKeys: ['n-1:0'] });
  expect(byText('voice 3').voiceAnswersStatus).toBeUndefined();
});
