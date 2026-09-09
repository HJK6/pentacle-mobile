import {
  coalesceInterpretedEvents,
  interpretPentacleEvent,
  stripClaudeExpandHint,
} from 'pentacle-chat-core';
import type { PentacleEvent } from 'pentacle-chat-core';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'alpha',
    provider: 'codex',
    session_id: 'alpha:chat-1',
    session_name: 'chat-1',
    stream_id: 'alpha:chat-1',
    timestamp: '2026-04-24T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'Hello',
    ...overrides,
  };
}

test('interpretPentacleEvent classifies durable user messages', () => {
  const result = interpretPentacleEvent(event({ kind: 'USER', text: 'Clean up the mobile UI' }));
  expect(result.caseId).toBe('user-message');
  expect(result.displayRule).toBe('bubble:user');
  expect(result.hidden).toBe(false);
});

test('interpretPentacleEvent hides Codex helper suggestions', () => {
  const result = interpretPentacleEvent(event({ kind: 'USER', text: 'summarize recent commits' }));
  expect(result.caseId).toBe('codex-helper-suggestion');
  expect(result.displayRule).toBe('hidden:helper');
  expect(result.hidden).toBe(true);
});

test('interpretPentacleEvent hides Codex slash command helper suggestions', () => {
  for (const text of ['run/review on my current changes', 'run /review on my current changes']) {
    const result = interpretPentacleEvent(event({ kind: 'USER', text }));
    expect(result.caseId).toBe('codex-helper-suggestion');
    expect(result.displayRule).toBe('hidden:helper');
    expect(result.hidden).toBe(true);
  }
});

test('interpretPentacleEvent hides multi-line USER events that begin with a Codex starter prompt', () => {
  // The pane parser sometimes appends adjacent splash lines onto the USER
  // event whose ❯ prompt was a starter suggestion. The whole event must
  // still be filtered as a helper suggestion.
  const text = [
    'run /review on my current changes',
    'summarize recent commits',
    'explore the repository structure',
    'use /skills to list available skills',
  ].join('\n');
  const result = interpretPentacleEvent(event({ kind: 'USER', text }));
  expect(result.caseId).toBe('codex-helper-suggestion');
  expect(result.displayRule).toBe('hidden:helper');
  expect(result.hidden).toBe(true);
});

test('interpretPentacleEvent hides helper suggestions before provider-specific branches', () => {
  const result = interpretPentacleEvent(event({
    kind: 'USER',
    text: 'run /review on my current changes',
    raw: { source: 'claude-jsonl' },
  }));

  expect(result.caseId).toBe('codex-helper-suggestion');
  expect(result.displayRule).toBe('hidden:helper');
  expect(result.hidden).toBe(true);
});

test('interpretPentacleEvent preserves explored tool output as a collapsed tool block', () => {
  const result = interpretPentacleEvent(event({ text: 'Explored\n└ Read app.js\n  Search renderSlotChat in app.js' }));
  expect(result.caseId).toBe('tool-output');
  expect(result.displayRule).toBe('activity:tool-output');
  expect(result.hidden).toBe(false);
  expect(result.disclosure?.expandedText).toBe('Explored\n└ Read app.js\n  Search renderSlotChat in app.js');
});

test('interpretPentacleEvent routes Codex file actions to file-change activity', () => {
  const added = interpretPentacleEvent(event({
    provider: 'codex',
    text: 'Added ~/foo/bar.ts (+12 -0)\n1 +line\n2 +line',
  }));
  const wrote = interpretPentacleEvent(event({
    provider: 'codex',
    text: 'Wrote ~/foo/bar.ts (+5)',
  }));
  const updated = interpretPentacleEvent(event({
    provider: 'codex',
    text: 'Updated ~/foo/bar.ts',
  }));

  expect(added.caseId).toBe('write-action');
  expect(added.displayRule).toBe('activity:file-change');
  expect(wrote.caseId).toBe('write-action');
  expect(wrote.displayRule).toBe('activity:file-change');
  expect(updated.caseId).toBe('edit-action');
  expect(updated.displayRule).toBe('activity:file-change');
});

test('interpretPentacleEvent keeps Codex first-person prose as assistant bubbles', () => {
  const message = interpretPentacleEvent(event({
    provider: 'codex',
    text: "I'm going to factor the title parsing into a helper.",
  }));
  const multiSentence = interpretPentacleEvent(event({
    provider: 'codex',
    text: "I'll split the view state out. Then I'll add focused tests.",
  }));
  const claudeProgress = interpretPentacleEvent(event({
    provider: 'claude',
    text: "I'm checking the docs (12s)",
  }));

  expect(message.caseId).toBe('assistant-message');
  expect(message.displayRule).toBe('bubble:assistant');
  expect(multiSentence.caseId).toBe('assistant-message');
  expect(multiSentence.displayRule).toBe('bubble:assistant');
  expect(claudeProgress.caseId).toBe('assistant-progress');
  expect(claudeProgress.displayRule).toBe('activity:progress');
});

test('interpretPentacleEvent hides live working noise but keeps completed background commands', () => {
  const working = interpretPentacleEvent(event({ text: '• Working (2m 08s • esc to interrupt)' }));
  const booting = interpretPentacleEvent(event({ text: 'Booting MCP server: codex_apps (7s • esc to interrupt)' }));
  const waited = interpretPentacleEvent(event({ text: 'Waited for background terminal · npm run test:unit' }));
  expect(working.displayRule).toBe('hidden:status');
  expect(booting.displayRule).toBe('hidden:status');
  expect(waited.caseId).toBe('tool-command');
  expect(waited.displayRule).toBe('activity:command');
  expect(working.hidden).toBe(true);
  expect(booting.hidden).toBe(true);
  expect(waited.hidden).toBe(false);
});

test('interpretPentacleEvent classifies Claude spinner status rows as transient furniture', () => {
  for (const text of [
    '✢ Wibbling…',
    '✻ Wibbling… (4s · ↓ 141 tokens)',
    '· Wibbling… (7s · ↓ 141 tokens)',
    '✻ Baked for 11s',
    '✻ Cogitated for 1m 22s',
  ]) {
    const result = interpretPentacleEvent(event({ provider: 'claude', text }));
    expect(result.caseId).toBe('transient-noise');
    expect(result.displayRule).toBe('hidden:noise');
    expect(result.hidden).toBe(true);
  }
});

test('interpretPentacleEvent cleans Claude pane markers into view-layer rows', () => {
  const command = interpretPentacleEvent(event({ provider: 'claude', text: '⏺ Bash(sleep 8)' }));
  const output = interpretPentacleEvent(event({
    provider: 'claude',
    text: '  ⎿  origin     https://github.com/example-org/example-mobile.git (fetch)\n     origin     https://github.com/example-org/example-mobile.git (push)\n     ---\n     … +3 lines (ctrl+o to expand)\n  ⎿  Shell cwd was reset to /workspace',
  }));
  const final = interpretPentacleEvent(event({
    provider: 'claude',
    text: '  ⎿  (No output)\n\n⏺ done\n\n✻ Baked for 11s',
  }));

  expect(command.caseId).toBe('tool-command');
  expect(command.displayRule).toBe('activity:command');
  expect(command.text).toBe('Bash(sleep 8)');
  expect(output.caseId).toBe('tool-output');
  expect(output.displayRule).toBe('activity:tool-output');
  expect(output.text).toBe('origin     https://github.com/example-org/example-mobile.git (fetch)\norigin     https://github.com/example-org/example-mobile.git (push)\n---\n… +3 lines');
  expect(final.caseId).toBe('assistant-message');
  expect(final.displayRule).toBe('bubble:assistant');
  expect(final.text).toBe('done');
});

test('stripClaudeExpandHint removes desktop Claude expansion suffixes only at line end', () => {
  expect(stripClaudeExpandHint('… +3 lines (ctrl+o to expand)')).toBe('… +3 lines');
  expect(stripClaudeExpandHint('Searched for 1 pattern (ctrl+o to expand).')).toBe('Searched for 1 pattern');
  expect(stripClaudeExpandHint('Running in the background (↓ to manage)')).toBe('Running in the background');
  expect(stripClaudeExpandHint('Running in the background (↓ to manage).')).toBe('Running in the background');
  expect(stripClaudeExpandHint('keep (ctrl+o to expand) in the middle of text')).toBe('keep (ctrl+o to expand) in the middle of text');
  expect(stripClaudeExpandHint('keep (↓ to manage) in the middle of text')).toBe('keep (↓ to manage) in the middle of text');
});

test('interpretPentacleEvent strips Claude JSONL tool-result expansion hints', () => {
  const result = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: 'Searched for 1 pattern (ctrl+o to expand).',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Grep',
    },
  }));

  expect(result.caseId).toBe('tool-result');
  expect(result.displayRule).toBe('activity:tool-output');
  expect(result.text).toBe('Searched for 1 pattern');
});

test('interpretPentacleEvent classifies and summarizes Claude JSONL file tool results', () => {
  const read = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: '1\tconst value = 1;',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Read',
      is_error: false,
    },
  }));
  const write = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: 'File written successfully',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Write',
      is_error: false,
      cwd: '/workspace',
      tool_input: {
        file_path: '/tmp/synthetic-prompt.txt',
        content: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'),
      },
    },
  }));
  const edit = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: 'The file has been updated.',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Edit',
      is_error: false,
      tool_input: {
        file_path: '/workspace/example.ts',
        old_string: 'old line',
        new_string: Array.from({ length: 6 }, (_, index) => `new ${index + 1}`).join('\n'),
      },
    },
  }));
  const editError = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Edit',
      is_error: true,
    },
  }));

  expect(read.caseId).toBe('code-block');
  expect(read.displayRule).toBe('activity:code-block');
  expect(write.caseId).toBe('tool-result');
  expect(write.displayRule).toBe('activity:tool-output');
  expect(write.text).toBe('Wrote 40 lines to ../../../tmp/synthetic-prompt.txt');
  expect(edit.caseId).toBe('tool-result');
  expect(edit.displayRule).toBe('activity:tool-output');
  expect(edit.text).toBe('Added 6 lines, removed 1 line');
  expect(editError.caseId).toBe('tool-result');
  expect(editError.displayRule).toBe('activity:tool-output');
  expect(editError.text).toBe('File must be read first');
});

test('interpretPentacleEvent summarizes Claude JSONL Bash background starts', () => {
  const result = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_RESULT',
    text: 'Command running in background with ID: job-1. Output is being written to: /tmp/foo',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Bash',
      is_error: false,
    },
  }));

  expect(result.caseId).toBe('tool-result');
  expect(result.displayRule).toBe('activity:tool-output');
  expect(result.text).toBe('Running in the background');
});

test('interpretPentacleEvent synthesizes Claude JSONL Grep and Glob search bodies', () => {
  const grep = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_USE',
    text: 'Grep {"pattern":"TranscriptRow"}',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Grep',
      tool_input: {
        pattern: 'TranscriptRow',
        path: 'app/pentacle/session',
      },
    },
  }));
  const glob = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'TOOL_USE',
    text: 'Glob {"pattern":"**/*.tsx"}',
    raw: {
      source: 'claude-jsonl',
      tool_name: 'Glob',
      tool_input: {
        pattern: '**/*.tsx',
        path: 'tests',
      },
    },
  }));

  expect(grep.caseId).toBe('tool-use');
  expect(grep.displayRule).toBe('activity:explored');
  expect(grep.text).toBe('Grep: pattern: "TranscriptRow" · path: "app/pentacle/session"');
  expect(glob.caseId).toBe('tool-use');
  expect(glob.displayRule).toBe('activity:explored');
  expect(glob.text).toBe('Glob: pattern: "**/*.tsx" · path: "tests"');
});

test('interpretPentacleEvent drops terminal furniture but preserves context compaction milestones', () => {
  const divider = interpretPentacleEvent(event({ text: '─ Worked for 1m 11s ───────────────────────────────' }));
  const plainDivider = interpretPentacleEvent(event({ text: '────────────────────────────────────────────────────────────────────────────────────────────────' }));
  const compacted = interpretPentacleEvent(event({ text: 'Context Compacted' }));

  expect(divider.caseId).toBe('transient-noise');
  expect(divider.displayRule).toBe('hidden:noise');
  expect(divider.hidden).toBe(true);
  expect(plainDivider.caseId).toBe('transient-noise');
  expect(plainDivider.displayRule).toBe('hidden:noise');
  expect(plainDivider.hidden).toBe(true);
  expect(compacted.caseId).toBe('context-compacted');
  expect(compacted.displayRule).toBe('system:compacted');
  expect(compacted.hidden).toBe(false);
});

test('interpretPentacleEvent maps Claude JSONL turn summaries to divider activity', () => {
  const summary = interpretPentacleEvent(event({
    provider: 'claude',
    kind: 'SYSTEM',
    text: 'Worked for 4m 52s · 53 msgs',
    raw: {
      source: 'claude-jsonl',
      subtype: 'turn-summary',
    },
  }));

  expect(summary.caseId).toBe('turn-summary');
  expect(summary.displayRule).toBe('activity:turn-summary');
  expect(summary.text).toBe('Worked for 4m 52s · 53 msgs');
  expect(summary.hidden).toBe(false);
});

test('interpretPentacleEvent maps Claude JSONL tool batch summaries to tool-batch activity', () => {
  const result = interpretPentacleEvent(event({
    kind: 'TOOL_BATCH_SUMMARY',
    text: 'Read 1 file',
    raw: { source: 'claude-jsonl', subtype: 'tool-batch-summary', tool_use_ids: ['toolu_1'] },
  }));

  expect(result.caseId).toBe('tool-batch');
  expect(result.displayRule).toBe('activity:tool-batch');
  expect(result.text).toBe('Read 1 file');
});

test('coalesceInterpretedEvents keeps the fullest progressive update', () => {
  const first = interpretPentacleEvent(event({
    daemon_seq: 10,
    text: 'Interpreting this as the state of the 0DTE bot. Current state: stopped.',
  }));
  const second = interpretPentacleEvent(event({
    daemon_seq: 11,
    text: 'Interpreting this as the state of the 0DTE bot. Current state: stopped. Latest trading-day state was data-starved.',
  }));
  const result = coalesceInterpretedEvents([first, second]);
  expect(result.length).toBe(1);
  expect(result[0]?.event.daemon_seq).toBe(11);
});

test('interpretPentacleEvent suppresses Claude Code slash-command caveat envelopes', () => {
  const result = interpretPentacleEvent(event({
    kind: 'SYSTEM',
    text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
    raw: { source: 'claude-jsonl', subtype: 'synthetic-user' },
  }));
  expect(result.hidden).toBe(true);
  expect(result.displayRule).toBe('hidden:noise');
  expect(result.caseId).toBe('transient-noise');
});

test('interpretPentacleEvent renders local-command stdout inner text as a system row', () => {
  const result = interpretPentacleEvent(event({
    kind: 'SYSTEM',
    text: '<local-command-stdout>bye!</local-command-stdout>',
    raw: { source: 'claude-jsonl', subtype: 'synthetic-user' },
  }));
  expect(result.hidden).toBe(false);
  expect(result.caseId).toBe('system-notice');
  expect(result.displayRule).toBe('activity:system');
  expect(result.label).toBe('Output');
  expect(result.text).toBe('bye!');
});

test('interpretPentacleEvent renders local-command stderr as a system row labelled Error', () => {
  const result = interpretPentacleEvent(event({
    kind: 'SYSTEM',
    text: '<local-command-stderr>oops\nstack trace</local-command-stderr>',
    raw: { source: 'claude-jsonl', subtype: 'synthetic-user' },
  }));
  expect(result.hidden).toBe(false);
  expect(result.label).toBe('Error');
  expect(result.text).toBe('oops\nstack trace');
});

test('interpretPentacleEvent keeps compact tag-name notice for non-local-command synthetic envelopes', () => {
  const result = interpretPentacleEvent(event({
    kind: 'SYSTEM',
    text: '<task-notification>Build finished</task-notification>',
    raw: { source: 'claude-jsonl', subtype: 'synthetic-user' },
  }));
  expect(result.hidden).toBe(false);
  expect(result.caseId).toBe('system-notice');
  expect(result.text).toBe('task-notification');
});
