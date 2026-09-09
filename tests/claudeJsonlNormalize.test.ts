import { readFileSync } from 'node:fs';
import { normalizeClaudeJsonlRecord } from '../src/services/claudeJsonlNormalize';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const jsonlPath = 'test/fixtures/claude_jsonl_normalize_fixture.jsonl';

function loadRecords() {
  return readFileSync(jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('normalizeClaudeJsonlRecord matches checked-in synthetic-record expectations', () => {
  const records = loadRecords();
  const expected = JSON.parse(readFileSync('test/fixtures/claude_jsonl_normalize_expected.json', 'utf8')) as Array<{ line: number; events: unknown[] }>;
  let seq = 2000;

  const actual = expected.map(({ line }) => {
    const events = normalizeClaudeJsonlRecord(records[line - 1], {
      host: 'hostb',
      sessionName: 'claude-jsonl-fixture',
      daemonSeqStart: seq,
    });
    seq += 10;
    return { line, events };
  });

  expect(actual).toEqual(expected);
});

test('normalizeClaudeJsonlRecord emits only submitted USER records and no drafts', () => {
  const records = loadRecords();
  const events = normalizeClaudeJsonlRecord(records[2], {
    host: 'hostb',
    sessionName: 'claude-jsonl-fixture',
    daemonSeqStart: 1,
  });

  expect(events.length).toBe(1);
  expect(events[0]?.kind).toBe('USER');
  expect(events[0]?.raw?.source).toBe('claude-jsonl');
  expect(events.some((event) => event.kind === 'DRAFT')).toBe(false);
});

describe('deterministic Claude JSONL normalization', () => {
  test('preserves system metadata while applying documented content fallbacks', () => {
    const direct = normalizeClaudeJsonlRecord({
      type: 'system',
      content: 'ready',
      sessionId: 'session-1',
      timestamp: '2026-07-14T12:00:00.000Z',
      uuid: 'event-1',
      parentUuid: 'event-0',
      isSidechain: true,
      message: { stop_reason: 'end_turn' },
      cwd: '/project',
    }, { host: 'hostc', sessionName: 'claude-one', daemonSeqStart: 7 });

    expect(direct).toEqual([expect.objectContaining({
      daemon_seq: 7,
      host: 'hostc',
      session_id: 'session-1',
      stream_id: 'hostc:claude-one',
      timestamp: '2026-07-14T12:00:00.000Z',
      kind: 'SYSTEM',
      text: 'ready',
      raw: expect.objectContaining({
        source: 'claude-jsonl',
        uuid: 'event-1',
        parent_uuid: 'event-0',
        is_sidechain: true,
        stop_reason: 'end_turn',
        cwd: '/project',
      }),
    })]);

    expect(normalizeClaudeJsonlRecord({ type: 'system', message: { content: 'nested' } })[0]?.text).toBe('nested');
    expect(normalizeClaudeJsonlRecord({ type: 'system', subtype: 'compact_boundary' })[0]?.text).toBe('compact_boundary');
    expect(normalizeClaudeJsonlRecord({ type: 'system', content: { state: 'idle' } })[0]?.text).toBe('{"state":"idle"}');
    expect(normalizeClaudeJsonlRecord({ type: 'system', content: null })[0]?.text).toBe('');
  });

  test('turns submitted user content and tool results into ordered durable events', () => {
    expect(normalizeClaudeJsonlRecord({ type: 'user', session_id: 'snake', message: { content: 'ship it' } }))
      .toEqual([expect.objectContaining({
        daemon_seq: 0,
        host: 'unknown',
        session_id: 'snake',
        session_name: 'claude-jsonl-fixture',
        timestamp: '1970-01-01T00:00:00.000Z',
        kind: 'USER',
        text: 'ship it',
      })]);

    const events = normalizeClaudeJsonlRecord({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { content: 'second' },
          { type: 'tool_reference', tool_name: 'Read' },
          { ignored: true },
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            is_error: true,
            content: [
              { text: 'failure' },
              { content: 'details' },
              { type: 'tool_reference', tool_name: 'Bash' },
              { type: 'tool_reference' },
              { unknown: true },
              4,
            ],
          },
        ],
      },
    });

    expect(events.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'USER', text: 'first\nsecond' },
      { kind: 'TOOL_RESULT', text: 'failure\ndetails\nBash' },
    ]);
    expect(events[1]?.raw).toEqual(expect.objectContaining({
      tool_use_id: 'tool-1',
      tool_content: 'failure\ndetails\nBash',
      is_error: true,
    }));
    expect(normalizeClaudeJsonlRecord({ type: 'user', message: { content: { draft: true } } })).toEqual([]);
    expect(normalizeClaudeJsonlRecord({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: null }] },
    })[0]?.text).toBe('');
  });

  test('maps assistant text, thinking, and every supported tool preview without fabricating unknown events', () => {
    const events = normalizeClaudeJsonlRecord({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Answer' },
          { type: 'text' },
          { type: 'thinking', thinking: 'Reasoning' },
          { type: 'thinking' },
          { type: 'tool_use', id: '1', name: 'Bash', input: { command: ' npm test ' } },
          { type: 'tool_use', id: '2', name: 'Read', input: { file_path: ' src/a.ts ' } },
          { type: 'tool_use', id: '3', name: 'Write', input: { file_path: ' out.txt ' } },
          { type: 'tool_use', id: '4', name: 'Edit', input: { file_path: ' app.tsx ' } },
          { type: 'tool_use', id: '5', name: 'Agent', input: { description: ' review pass ' } },
          { type: 'tool_use', id: '6', name: 'Agent', input: { subagent_type: 'reviewer' } },
          { type: 'tool_use', id: '7', name: 'Agent', input: {} },
          { type: 'tool_use', id: '8', name: 'Custom', input: { safe: true } },
          { type: 'tool_use', id: '9', input: 'invalid' },
          { type: 'tool_use', id: '10', name: 'Bash', input: {} },
          { type: 'tool_use', id: '11', name: 'Read', input: {} },
          { type: 'tool_use', id: '12', name: 'Write', input: {} },
          { type: 'tool_use', id: '13', name: 'Edit', input: {} },
          { type: 'ignored' },
        ],
      },
    });

    expect(events.map((event) => event.text)).toEqual([
      'Answer',
      '',
      'Reasoning',
      'Thinking',
      'Bash(npm test)',
      'Read src/a.ts',
      'Write out.txt',
      'Edit app.tsx',
      'Agent: review pass',
      'Agent: reviewer',
      'Agent: Sub-agent',
      'Custom {"safe":true}',
      'Tool',
      'Bash()',
      'Read ',
      'Write ',
      'Edit ',
    ]);
    expect(events[2]?.raw).toEqual(expect.objectContaining({ thinking: 'Reasoning' }));
    expect(events[4]?.raw).toEqual(expect.objectContaining({
      tool_use_id: '1',
      tool_name: 'Bash',
      tool_input: { command: ' npm test ' },
    }));
    expect(normalizeClaudeJsonlRecord({ type: 'assistant', message: { content: 'plain assistant' } })[0])
      .toEqual(expect.objectContaining({ kind: 'ASSIST_TEXT', text: 'plain assistant' }));
    expect(normalizeClaudeJsonlRecord({ type: 'progress' })).toEqual([]);
  });
});
