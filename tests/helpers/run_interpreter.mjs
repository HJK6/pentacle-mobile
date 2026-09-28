// Pipeline test helper: read JSON event array on stdin, push them through the
// real selectSessionDetail (which calls interpretPentacleEvent), emit
// transcriptItems[] on stdout. Driven by chat-stream's
// tests/test_pipeline_jsonl_to_mobile.py.
//
// IMPORTANT: keep `run_interpreter.mjs`, `expected_pipeline_output.json`, and
// the daemon normalizer in lockstep. If the mobile interpreter or transcript
// model selector changes shape, update the expected fixture deliberately.
//
// Run as `node --import tsx --import ./tests/helpers/expoConstantsShim.mjs \
//   ./tests/helpers/run_interpreter.mjs`. tsx emits CJS interop for .ts
// modules, so the named exports surface under .default when imported from
// this .mjs entrypoint.
const chatModel = await import('../../src/services/pentacleChatModel');
const selectSessionDetail = (chatModel.selectSessionDetail
  || chatModel.default?.selectSessionDetail);

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const raw = (await readStdin()).trim();
const events = raw ? JSON.parse(raw) : [];
if (!Array.isArray(events)) {
  process.stderr.write('expected JSON array of events on stdin\n');
  process.exit(2);
}

const stamped = events.map((event, index) => ({
  ...event,
  daemon_seq: typeof event.daemon_seq === 'number' ? event.daemon_seq : index + 1,
}));

const first = stamped[0] || {};
const streamId = String(first.stream_id || 'hosta:claude-pipeline-test');
const last = stamped[stamped.length - 1] || first;

const session = {
  stream_id: streamId,
  host: String(first.host || 'hosta'),
  provider: String(first.provider || 'claude'),
  session_name: String(first.session_name || 'claude-pipeline-test'),
  display_name: 'pipeline-test',
  title: 'pipeline-test',
  last_event_at: String(last.timestamp || ''),
  last_text: String(last.text || ''),
  last_kind: String(last.kind || 'ASSIST_TEXT'),
  draft: '',
  pending: false,
  working: false,
  online: true,
};

const state = {
  connected: true,
  connecting: false,
  events: stamped,
  drafts: {},
  hosts: {},
  machineStats: {},
  sessions: [session],
  updates: [],
};

const detail = selectSessionDetail(state, streamId, {
  includeTools: true,
  includeSystem: true,
  visibleCount: 'all',
});

if (!detail) {
  process.stderr.write('selectSessionDetail returned null\n');
  process.exit(3);
}

process.stdout.write(JSON.stringify(detail.transcriptItems, null, 2));
