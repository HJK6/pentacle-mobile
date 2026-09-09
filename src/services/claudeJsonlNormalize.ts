import type { PentacleEvent } from 'pentacle-chat-core';

type NormalizeOptions = {
  host?: string;
  sessionName?: string;
  daemonSeqStart?: number;
};

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        if (block.type === 'tool_reference' && typeof block.tool_name === 'string') return block.tool_name;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function toolUseText(name: string, input: Record<string, unknown>) {
  if (name === 'Bash') return `Bash(${String(input.command || '').trim()})`;
  if (name === 'Read') return `Read ${String(input.file_path || '').trim()}`;
  if (name === 'Write') return `Write ${String(input.file_path || '').trim()}`;
  if (name === 'Edit') return `Edit ${String(input.file_path || '').trim()}`;
  if (name === 'Agent') return `Agent: ${String(input.description || input.subagent_type || 'Sub-agent').trim()}`;
  const preview = Object.keys(input).length ? ` ${JSON.stringify(input)}` : '';
  return `${name}${preview}`;
}

function contentBlocks(record: Record<string, any>): any[] {
  const content = record.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function definedObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function normalizeClaudeJsonlRecord(
  record: Record<string, any>,
  options: NormalizeOptions = {},
): PentacleEvent[] {
  const host = options.host || 'unknown';
  const sessionName = options.sessionName || 'claude-jsonl-fixture';
  const sessionId = String(record.sessionId || record.session_id || '');
  const timestamp = String(record.timestamp || new Date(0).toISOString());
  const baseRaw = definedObject({
    source: 'claude-jsonl',
    host,
    provider: 'claude',
    session_name: sessionName,
    uuid: record.uuid,
    parent_uuid: record.parentUuid,
    is_sidechain: Boolean(record.isSidechain),
    stop_reason: record.message?.stop_reason,
    cwd: record.cwd,
  });

  let nextSeq = options.daemonSeqStart || 0;
  const makeEvent = (kind: string, text: string, raw: Record<string, unknown> = {}): PentacleEvent => ({
    daemon_seq: nextSeq++,
    host,
    provider: 'claude',
    session_id: sessionId,
    session_name: sessionName,
    stream_id: `${host}:${sessionName}`,
    timestamp,
    kind,
    text,
    raw: definedObject({ ...baseRaw, ...raw }),
  });

  if (record.type === 'system') {
    return [makeEvent('SYSTEM', textFromContent(record.content || record.message?.content || record.subtype || ''), {
      subtype: record.subtype,
    })];
  }

  if (record.type === 'user') {
    const content = record.message?.content;
    if (typeof content === 'string') return [makeEvent('USER', content)];

    const events: PentacleEvent[] = [];
    const userText: string[] = [];
    for (const block of contentBlocks(record)) {
      if (block?.type === 'tool_result') {
        const text = textFromContent(block.content);
        events.push(makeEvent('TOOL_RESULT', text, {
          tool_use_id: block.tool_use_id,
          tool_content: text,
          is_error: Boolean(block.is_error),
        }));
      } else {
        const text = textFromContent(block.text || block.content || '');
        if (text) userText.push(text);
      }
    }
    if (userText.length) events.unshift(makeEvent('USER', userText.join('\n')));
    return events;
  }

  if (record.type !== 'assistant') return [];

  const events: PentacleEvent[] = [];
  for (const block of contentBlocks(record)) {
    if (block?.type === 'text') {
      events.push(makeEvent('ASSIST_TEXT', String(block.text || '')));
    } else if (block?.type === 'thinking') {
      const thinking = String(block.thinking || '');
      events.push(makeEvent('THINKING', thinking || 'Thinking', { thinking }));
    } else if (block?.type === 'tool_use') {
      const name = String(block.name || 'Tool');
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      events.push(makeEvent('TOOL_USE', toolUseText(name, input), {
        tool_use_id: block.id,
        tool_name: name,
        tool_input: input,
      }));
    }
  }
  return events;
}
