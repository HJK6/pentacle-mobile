import fs from 'node:fs';
import path from 'node:path';
import {
  CHAT_EVENT_ORDERING_REPLAY,
  HISTORY_FETCH_RETRY_HYDRATE,
  OPTIMISTIC_ECHO_RECONCILE,
  PENDING_SEND_LIVE_APPLY,
  QUESTION_ASK_ANSWER_DISPLAY,
  type DaemonStep,
  type TraceContract,
  isPositiveStep,
} from './traces';

type JsonRecord = Record<string, any>;

const TRACE_FIXTURE_CASES = [
  QUESTION_ASK_ANSWER_DISPLAY,
  CHAT_EVENT_ORDERING_REPLAY,
  OPTIMISTIC_ECHO_RECONCILE,
  PENDING_SEND_LIVE_APPLY,
  HISTORY_FETCH_RETRY_HYDRATE,
];

function fixtureRows(trace: TraceContract): JsonRecord[] {
  const fixturePath = path.join(__dirname, 'fixtures', `${trace.fixture}.jsonl`);
  return fs.readFileSync(fixturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function daemonSteps(trace: TraceContract): DaemonStep[] {
  return trace.steps
    .filter(isPositiveStep)
    .filter((step): step is DaemonStep => step.actor === 'daemon' && typeof step.fixtureRow === 'number');
}

function eventRecord(row: JsonRecord): JsonRecord {
  return row.event ?? row.events?.[0] ?? row.session ?? {};
}

function expectFixtureRowMatchesStep(trace: TraceContract, step: DaemonStep, row: JsonRecord) {
  const payload = (step.payload ?? {}) as JsonRecord;
  const event = eventRecord(row);

  if (step.event === 'QUESTION_SUMMARY') {
    expect(row.type).toBe('snapshot');
    expect(row.session?.question_key).toBe(payload.questionKey);
    if (trace.name === 'question_ask_answer_display') {
      expect(row.session?.question?.allow_custom).toBe(true);
    }
    return;
  }

  if (step.event === 'REQUEST_STREAM_EVENTS_ERROR') {
    expect(row.type).toBe('request_stream_events.error');
    expect(row.error).toBe(payload.error);
    return;
  }

  if (step.event === 'REQUEST_STREAM_EVENTS_OK') {
    expect(row.type).toBe('request_stream_events.ok');
  } else if (step.event === 'SNAPSHOT_REPLAY') {
    expect(row.type).toBe('snapshot');
  } else if (step.event === 'FETCHED_HISTORY') {
    expect(row.type).toBe('stream_events');
  } else if (step.event === 'HELLO_SUMMARY') {
    expect(row.type).toBe('snapshot');
    expect(row.sessions?.[0]?.stream_id).toBe(payload.streamId);
    return;
  } else {
    expect(row.type).toBe('chat.event');
    expect(event.kind).toBe(step.event);
  }

  if (payload.daemonSeq != null) expect(event.daemon_seq).toBe(payload.daemonSeq);
  if (payload.timestamp != null) expect(event.timestamp).toBe(payload.timestamp);
  if (payload.text != null) expect(event.text).toBe(payload.text);
  if (payload.optimisticId != null) expect(event.optimistic_id).toBe(payload.optimisticId);

  if (trace.name === 'question_ask_answer_display' && step.event === 'USER') {
    expect(event.text).toContain('Answering your question');
  }
}

describe('new trace fixture rows', () => {
  test.each(TRACE_FIXTURE_CASES)('%s fixtureRow metadata matches JSONL rows', (trace) => {
    const rows = fixtureRows(trace);
    for (const step of daemonSteps(trace)) {
      expect(step.fixtureRow).toBeLessThan(rows.length);
      expectFixtureRowMatchesStep(trace, step, rows[step.fixtureRow!]);
    }
  });
});
