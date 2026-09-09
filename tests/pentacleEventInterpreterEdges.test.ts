import {
  cleanClaudePaneText,
  coalesceInterpretedEvents,
  collapseCodeBlocks,
  displayTextForEvent,
  findCoalescibleTerminalDividerIndex,
  interpretPentacleEvent,
  isClaudeStatusText,
  isCodexHelperSuggestion,
  isContextCompactedText,
  isDaemonNotificationText,
  isOrchestrationReceiptAck,
  isTerminalDividerText,
  isTerminalFurnitureText,
  isTerminalToolEchoText,
  isTransientTranscriptNoise,
  isWorkingStatusText,
  normalizeWorkingLabel,
  normalizedEventText,
  parsePeerAgentMessage,
  isPeerAgentMessage,
  stripWorkingStatus,
  stripTerminalPromptPrefix,
  terminalDividerLabel,
} from 'pentacle-chat-core';
import type { PentacleEvent } from 'pentacle-chat-core';

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'codex',
    session_id: 'hostc:codex:edge',
    session_name: 'edge',
    stream_id: 'hostc:codex:edge',
    timestamp: '2026-07-14T12:00:00.000Z',
    kind: 'ASSIST',
    text: 'Deploying',
    ...overrides,
  };
}

test('Claude pane cleanup removes only transient chrome and preserves durable output', () => {
  expect(normalizedEventText('  one\n two  ')).toBe('one two');
  expect(isClaudeStatusText('✢ Compiling…')).toBe(true);
  expect(isClaudeStatusText('✽ Waiting (12s · esc to interrupt)')).toBe(true);
  expect(isClaudeStatusText('· Worked for 3s')).toBe(true);
  expect(isClaudeStatusText('ordinary durable output')).toBe(false);

  expect(cleanClaudePaneText([
    '⏺ Durable answer (ctrl+o to expand)',
    '',
    '✢ Thinking…',
    '(No output)',
    'Running… (2s)',
    '(ctrl+b to run in background)',
    'Shell cwd was reset to /repo',
    '⎿ Final line (↓ to manage).',
    '',
  ].join('\n'))).toBe('Durable answer\n\nFinal line');
  expect(displayTextForEvent('⏺')).toBe('');
  expect(displayTextForEvent('Shell cwd was reset to /repo')).toBe('');
  expect(displayTextForEvent(' plain ')).toBe('plain');
});

test('working and divider helpers classify boundary variants without hiding normal transcript text', () => {
  expect(normalizeWorkingLabel('Working (3s)')).toBe('Working (3s)');
  expect(normalizeWorkingLabel('✢ Compiling… (4s · esc to interrupt)')).toBe('Compiling 4s');
  expect(normalizeWorkingLabel('✽ Rendered for 8s')).toBe('Rendered 8s');
  expect(normalizeWorkingLabel('· Waiting')).toBe('Waiting');
  expect(normalizeWorkingLabel('ordinary')).toBe('ordinary');
  expect(collapseCodeBlocks('before ```ts\nconst x = 1\n``` after')).toBe('before [code hidden] after');

  for (const value of [
    'Working (3s)',
    '• Working (3s)',
    '⎿ Running… (3s)',
    'Booting MCP server figma',
    'Still running (4s • esc to interrupt)',
    '◦ Working (2s)',
  ]) expect(isWorkingStatusText(value)).toBe(true);
  expect(isWorkingStatusText('Completed build')).toBe(false);
  expect(isTerminalDividerText('──── Worked for 4s')).toBe(true);
  expect(isTerminalDividerText('Worked for 4s')).toBe(true);
  expect(isTerminalDividerText('────────')).toBe(true);
  expect(isTerminalDividerText('short')).toBe(false);
  expect(terminalDividerLabel('──── Worked for 4s ────')).toBe('Worked for 4s');
  expect(isContextCompactedText('Context Compacted at 12:00')).toBe(true);
  expect(isContextCompactedText('Context ready')).toBe(false);
  expect(isTransientTranscriptNoise('')).toBe(true);
  expect(isTransientTranscriptNoise('✢ Thinking…')).toBe(true);
  expect(isTransientTranscriptNoise('Durable')).toBe(false);
  expect(stripWorkingStatus('Durable\nWorking (3s)\n✢ Thinking…\nTail ◦ Working (2s)')).toBe('Durable');
});

test('Codex helper detection is bounded to actual short splash suggestions', () => {
  expect(isCodexHelperSuggestion('')).toBe(false);
  expect(isCodexHelperSuggestion('   \n  ')).toBe(false);
  expect(isCodexHelperSuggestion('\nSummarize recent commits\nother splash noise')).toBe(true);
  expect(isCodexHelperSuggestion('inspect the failing test')).toBe(true);
  expect(isCodexHelperSuggestion('inspect this deliberately long operator request with more than eight words total')).toBe(false);
  expect(isCodexHelperSuggestion('Please inspect the failing test')).toBe(false);
});

test('peer-agent envelopes require a durable line break and keep optional routing anchors', () => {
  expect(parsePeerAgentMessage('[from hostc:codex-one]\nbody')).toEqual({
    fromStreamId: 'hostc:codex-one',
    body: 'body',
  });
  expect(parsePeerAgentMessage('[from hosta:claude-two] [handoff:abc-123]\r\nnext')).toEqual({
    fromStreamId: 'hosta:claude-two',
    anchorId: 'handoff:abc-123',
    body: 'next',
  });
  expect(isPeerAgentMessage('[from 3:30pm] meeting')).toBe(false);
  expect(interpretPentacleEvent(event({ kind: 'USER', text: '[from daemon]\nhealth' })))
    .toEqual(expect.objectContaining({ caseId: 'peer-agent-message', label: 'daemon', hidden: true }));
});

test('event coalescing deduplicates every durable replay identity but not unrelated equal text', () => {
  const identityCases: Array<[Partial<PentacleEvent>, Partial<PentacleEvent>]> = [
    [{ optimistic_id: 'o' }, { optimistic_id: 'o' }],
    [{ jsonl_record_uuid: 'j' }, { jsonl_record_uuid: 'j' }],
    [{ raw: { jsonl_record_uuid: 'r' } }, { raw: { jsonl_record_uuid: 'r' } }],
    [{ jsonl_record_uuid: 'x' }, { raw: { jsonl_record_uuid: 'x' } }],
    [{ raw: { jsonl_record_uuid: 'x' } }, { jsonl_record_uuid: 'x' }],
    [{ raw: { uuid: 'u' } }, { raw: { uuid: 'u' } }],
    [{ jsonl_resolution_for_record_uuid: 'z' }, { jsonl_record_uuid: 'z' }],
    [{ jsonl_record_uuid: 'z' }, { jsonl_resolution_for_record_uuid: 'z' }],
    [{ raw: { jsonl_resolution_for_record_uuid: 'z' } }, { raw: { jsonl_record_uuid: 'z' } }],
    [{ raw: { jsonl_record_uuid: 'z' } }, { raw: { jsonl_resolution_for_record_uuid: 'z' } }],
    [{ raw: { jsonl_resolution_for_record_uuid: 'z' } }, { jsonl_record_uuid: 'z' }],
    [{ jsonl_record_uuid: 'z' }, { raw: { jsonl_resolution_for_record_uuid: 'z' } }],
    [{ daemon_seq: 41 }, { daemon_seq: 41 }],
    [{ correlatedDaemonSeq: 42 } as never, { daemon_seq: 42 }],
    [{ daemon_seq: 43 }, { correlatedDaemonSeq: 43 } as never],
  ];
  for (const [left, right] of identityCases) {
    const result = coalesceInterpretedEvents([
      interpretPentacleEvent(event({ daemon_seq: 1, ...left })),
      interpretPentacleEvent(event({ daemon_seq: 2, ...right })),
    ]);
    expect(result).toHaveLength(1);
  }

  const unrelated = coalesceInterpretedEvents([
    interpretPentacleEvent(event({ daemon_seq: 1 })),
    interpretPentacleEvent(event({ daemon_seq: 2 })),
  ]);
  expect(unrelated).toHaveLength(2);
});

test('progressive coalescing keeps the fullest nearby update and divider lookback stops at durable content', () => {
  const progressive = coalesceInterpretedEvents([
    interpretPentacleEvent(event({ daemon_seq: 1, text: 'Deploying the exact immutable candidate to production' })),
    interpretPentacleEvent(event({ daemon_seq: 2, text: 'Deploying the exact immutable candidate to production now' })),
  ]);
  expect(progressive).toHaveLength(1);
  expect(progressive[0]?.text).toBe('Deploying the exact immutable candidate to production now');

  expect(findCoalescibleTerminalDividerIndex([], { displayRule: 'bubble:assistant', text: '' })).toBe(-1);
  expect(findCoalescibleTerminalDividerIndex([
    { displayRule: 'terminal:divider', text: 'Worked for 1s' },
    { displayRule: 'activity:turn-summary', text: '' },
  ], { displayRule: 'terminal:divider', text: 'Worked for 2s' })).toBe(0);
  expect(findCoalescibleTerminalDividerIndex([
    { displayRule: 'terminal:divider', text: 'Worked for 1s' },
    { displayRule: 'activity:turn-summary', text: 'durable summary' },
  ], { displayRule: 'terminal:divider', text: 'Worked for 2s' })).toBe(-1);
  expect(findCoalescibleTerminalDividerIndex([
    { displayRule: 'terminal:divider', text: 'old' },
    { displayRule: 'activity:turn-summary', text: '' },
    { displayRule: 'activity:turn-summary', text: '' },
    { displayRule: 'activity:turn-summary', text: '' },
  ], { displayRule: 'terminal:divider', text: 'new' })).toBe(-1);
  const sparse = new Array(1) as Array<{ displayRule: 'terminal:divider'; text: string }>;
  expect(findCoalescibleTerminalDividerIndex(sparse, { displayRule: 'terminal:divider', text: 'new' })).toBe(-1);
});

test('generic event kinds map to stable transcript surfaces and provider-aware assistant activity', () => {
  const cases: Array<[Partial<PentacleEvent>, string, string]> = [
    [{ kind: 'DRAFT', raw: { pending: true } }, 'queued-draft', 'draft:composer'],
    [{ kind: 'DRAFT', raw: { pending: false } }, 'draft', 'draft:composer'],
    [{ kind: 'SYSTEM', text: '──── Worked for 4s' }, 'transient-noise', 'hidden:noise'],
    [{ kind: 'SYSTEM', text: 'Context Compacted after tool output' }, 'context-compacted', 'system:compacted'],
    [{ kind: 'ASSIST', text: 'Working (4s)' }, 'working-status', 'hidden:status'],
    [{ kind: 'TOOL', text: '⏺' }, 'transient-noise', 'hidden:noise'],
    [{ kind: 'ASSIST', text: '⎿ command output' }, 'tool-output', 'activity:tool-output'],
    [{ kind: 'USER', text: 'durable operator text' }, 'user-message', 'bubble:user'],
    [{ kind: 'THINK', text: 'plan' }, 'thinking', 'activity:thinking'],
    [{ kind: 'SYSTEM', text: 'runtime ready' }, 'system', 'activity:system'],
    [{ kind: 'TOOL', text: 'Read src/file.ts' }, 'explore-action', 'activity:explored'],
    [{ kind: 'TOOL', text: 'Edited src/file.ts' }, 'edit-action', 'activity:file-change'],
    [{ kind: 'TOOL', text: 'Write src/file.ts' }, 'write-action', 'activity:file-change'],
    [{ kind: 'TOOL', text: 'Bash(npm test)' }, 'tool-command', 'activity:command'],
    [{ kind: 'TOOL-OUT', text: 'all green' }, 'tool-output', 'activity:tool-output'],
    [{ kind: 'ASSIST', provider: 'claude', text: 'Checking the release candidate' }, 'assistant-progress', 'activity:progress'],
    [{ kind: 'ASSIST', provider: 'codex', text: 'Checking the release candidate' }, 'assistant-message', 'bubble:assistant'],
    [{ kind: 'ASSIST', provider: undefined, text: 'Checking the release candidate' }, 'assistant-progress', 'activity:progress'],
    [{ kind: '', text: 'fallback' }, 'unknown', 'bubble:assistant'],
  ];
  for (const [overrides, caseId, displayRule] of cases) {
    expect(interpretPentacleEvent(event(overrides))).toEqual(expect.objectContaining({ caseId, displayRule }));
  }
});

test('terminal furniture and orchestration receipts are removed without swallowing conversation', () => {
  const furniture: Array<[string, string]> = [
    ['USER', '   '],
    ['SYSTEM', '──── Worked for 4s'],
    ['ASSIST', '✻ Brewed for 12m 36s'],
    ['SYSTEM', '2,048 weighted tokens left'],
    ['SYSTEM', '87% context left'],
    ['SYSTEM', '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'],
    ['USER', '❯'],
    ['SYSTEM', 'How is Claude doing this session? (optional)\n1. Bad\n2. Fine\n3. Good'],
    ['SYSTEM', 'Agent "Triage lanes" finished · 1m 34s'],
  ];
  for (const [kind, text] of furniture) {
    expect(isTerminalFurnitureText(text, kind) || isDaemonNotificationText(text)).toBe(true);
    expect(interpretPentacleEvent(event({ kind, text })).hidden).toBe(true);
  }

  expect(stripTerminalPromptPrefix('❯ ship the fix')).toBe('ship the fix');
  expect(interpretPentacleEvent(event({ kind: 'USER', text: '❯ ship the fix' })))
    .toEqual(expect.objectContaining({ caseId: 'user-message', text: 'ship the fix', hidden: false }));
  expect(interpretPentacleEvent(event({ kind: 'ASSIST', text: 'We reduced token usage safely.' })).hidden).toBe(false);
  expect(interpretPentacleEvent(event({ kind: 'USER', text: 'Please remove the Claude feedback prompt.' })).hidden).toBe(false);
  expect(interpretPentacleEvent(event({ kind: 'SYSTEM', text: 'Permission mode behavior changed in this release.' })).hidden).toBe(false);

  const toolEcho = 'Ran npm test\n└ 24 tests passed';
  expect(isTerminalToolEchoText(toolEcho)).toBe(true);
  expect(interpretPentacleEvent(event({ kind: 'ASSIST', text: toolEcho })))
    .toEqual(expect.objectContaining({ displayRule: 'activity:tool-output', hidden: false }));

  const ack = '{"type":"status_card.ok","delivery_status":"submitting"}';
  expect(isOrchestrationReceiptAck(ack)).toBe(true);
  expect(interpretPentacleEvent(event({ kind: 'TOOL-OUT', text: ack })).hidden).toBe(true);
  expect(isOrchestrationReceiptAck('{"type":"tell.error","error":"offline"}')).toBe(false);
});

test('structured Claude events preserve user/assistant state and summarize tool activity', () => {
  const structured = (kind: string, text: string, raw: Record<string, unknown> = {}) => interpretPentacleEvent(event({
    kind,
    text,
    provider: 'claude',
    raw: { source: 'claude-jsonl', ...raw },
  }));

  expect(structured('WORKING', 'Indexing')).toEqual(expect.objectContaining({ caseId: 'working-status', hidden: true }));
  expect(structured('TOOL_BATCH_SUMMARY', '3 tools')).toEqual(expect.objectContaining({ caseId: 'tool-batch' }));
  expect(structured('USER', 'operator')).toEqual(expect.objectContaining({ caseId: 'user-message', text: 'operator' }));
  expect(structured('ASSIST_TEXT', 'answer')).toEqual(expect.objectContaining({ caseId: 'assistant-message', text: 'answer' }));
  expect(structured('THINKING', '')).toEqual(expect.objectContaining({ caseId: 'thinking', text: 'Thinking' }));
  expect(structured('THINKING', 'reason')).toEqual(expect.objectContaining({ caseId: 'thinking', text: 'reason' }));

  expect(structured('TOOL_USE', 'Agent: reviewer', { tool_name: 'Agent', child_count: 1 }).text)
    .toBe('Agent: reviewer\n1 child event');
  expect(structured('TOOL_USE', 'Agent: reviewers', { tool_name: 'Agent', child_count: 2 }).text)
    .toBe('Agent: reviewers\n2 child events');
  expect(structured('TOOL_USE', 'Agent', { tool_name: 'Agent' }).text).toBe('Agent');
  expect(structured('TOOL_USE', 'Grep', {
    tool_name: 'Grep',
    tool_input: { pattern: 'TODO', path: '/repo', include: '*.ts' },
  })).toEqual(expect.objectContaining({
    caseId: 'tool-use',
    displayRule: 'activity:explored',
    text: 'Grep: pattern: "TODO" · path: "/repo" · include: "*.ts"',
  }));
  expect(structured('TOOL_USE', 'Glob *.tsx', { tool_name: 'Glob', tool_input: null })).toEqual(expect.objectContaining({
    text: 'Glob: *.tsx',
  }));
  expect(structured('TOOL_USE', '', { tool_name: 'Glob', tool_input: {} })).toEqual(expect.objectContaining({
    text: 'Glob: search',
  }));
  expect(structured('TOOL_USE', 'Custom action', { tool_name: 'Custom' })).toEqual(expect.objectContaining({
    caseId: 'tool-use',
    displayRule: 'activity:command',
    disclosure: expect.objectContaining({ mode: 'collapsed-preview', previewText: 'Custom action' }),
  }));
});

test('structured Claude tool results summarize file changes and preserve error evidence', () => {
  const result = (toolName: string, text: string, raw: Record<string, unknown> = {}) => interpretPentacleEvent(event({
    kind: 'TOOL_RESULT',
    text,
    provider: 'claude',
    raw: { source: 'claude-jsonl', tool_name: toolName, ...raw },
  }));

  expect(result('Write', 'ok', { cwd: '/repo', tool_input: { file_path: '/repo/src/a.ts', content: 'one' } }).text)
    .toBe('Wrote 1 line to src/a.ts');
  expect(result('Write', 'ok', { tool_input: { file_path: 'a.ts', content: 'one\ntwo' } }).text)
    .toBe('Wrote 2 lines to a.ts');
  expect(result('Write', '\nfirst line\nsecond', { tool_input: {} }).text).toBe('first line');
  expect(result('Write', '', { cwd: '/repo', tool_input: { file_path: '/repo', content: 'one' } }).text)
    .toBe('Wrote 1 line to .');
  expect(result('Edit', 'ok', { tool_input: { old_string: 'a', new_string: 'b' } }).text).toBe('Updated file');
  expect(result('Edit', 'ok', { tool_input: { old_string: 'a\nb', new_string: 'a\nb\nc' } }).text)
    .toBe('Added 3 lines, removed 2 lines');
  expect(result('Edit', 'fallback', { tool_input: null }).text).toBe('fallback');
  expect(result('Read', 'contents')).toEqual(expect.objectContaining({ caseId: 'code-block', displayRule: 'activity:code-block' }));
  expect(result('Read', 'denied', { is_error: true })).toEqual(expect.objectContaining({ caseId: 'tool-result', text: 'denied' }));
  expect(result('Bash', 'Command running in background with ID: 42').text).toBe('Running in the background');
  expect(result('Custom', '<tool_use_error>File has not been read yet.</tool_use_error>').text).toBe('File must be read first');
});

test('structured Claude system envelopes distinguish summaries, command streams, notices, and unknown kinds', () => {
  const system = (text: string, subtype?: string) => interpretPentacleEvent(event({
    kind: 'SYSTEM',
    text,
    provider: 'claude',
    raw: { source: 'claude-jsonl', subtype },
  }));
  expect(system('turn complete', 'turn-summary')).toEqual(expect.objectContaining({ caseId: 'turn-summary' }));
  expect(system('<local-command-caveat>ignore</local-command-caveat>', 'synthetic-user'))
    .toEqual(expect.objectContaining({ caseId: 'transient-noise', hidden: true }));
  expect(system('<local-command-stdout> done </local-command-stdout>', 'synthetic-user'))
    .toEqual(expect.objectContaining({ caseId: 'system-notice', label: 'Output', text: 'done' }));
  expect(system('<local-command-stderr> failed </local-command-stderr>', 'synthetic-user'))
    .toEqual(expect.objectContaining({ caseId: 'system-notice', label: 'Error', text: 'failed' }));
  expect(system('<task-notification>complete</task-notification>', 'synthetic-user'))
    .toEqual(expect.objectContaining({ caseId: 'system-notice', label: 'Notice', text: 'task-notification' }));
  expect(system('ordinary system')).toEqual(expect.objectContaining({ caseId: 'system', text: 'ordinary system' }));
  expect(system('', 'synthetic-user')).toEqual(expect.objectContaining({ caseId: 'system-notice', text: 'System notice' }));
  expect(interpretPentacleEvent(event({ kind: '', text: '', raw: { source: 'claude-jsonl' } })))
    .toEqual(expect.objectContaining({ caseId: 'unknown', label: 'Agent' }));
  expect(interpretPentacleEvent(event({ kind: 'FUTURE', text: '', raw: { source: 'claude-jsonl' } })))
    .toEqual(expect.objectContaining({ caseId: 'unknown', label: 'FUTURE' }));
});

