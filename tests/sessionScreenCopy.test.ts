import { setTelemetrySink, TELEMETRY_EVENTS, type TelemetryPayload } from 'pentacle-chat-core';

import { chatCopyIdentity, handleChatCopy } from '../src/utils/chatCopy';

const mockSetStringAsync = jest.fn<Promise<void>, [string]>(async () => undefined);

jest.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => mockSetStringAsync(text),
}));

afterEach(() => {
  setTelemetrySink(null);
  mockSetStringAsync.mockClear();
});

test('copy handler copies source message text and emits bounded telemetry identity', async () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const message = 'Source **message** text\nnot rendered markdown';

  await handleChatCopy({
    streamId: 'hostc:codex:copy',
    targetId: 'row-1:copy:message',
    copyKind: 'message',
    text: message,
  });

  expect(mockSetStringAsync).toHaveBeenCalledWith(message);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    message: TELEMETRY_EVENTS.CHAT_COPY_INVOKED,
    data: {
      stream_id: 'hostc:codex:copy',
      target_id: 'row-1:copy:message',
      copy_kind: 'message',
      copied_length: message.length,
      identity: chatCopyIdentity(message),
    },
  });
  expect(seen[0].data.identity).not.toContain(message);
});

test('copy handler copies raw code text and does not emit the copied text as identity', async () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const code = 'const raw = "<keep-me>";\nconsole.log(raw);';

  await handleChatCopy({
    streamId: 'hostc:codex:copy',
    targetId: 'row-2:copy:code:text-0-code-1',
    copyKind: 'code',
    text: code,
  });

  expect(mockSetStringAsync).toHaveBeenCalledWith(code);
  expect(seen[0]).toMatchObject({
    message: TELEMETRY_EVENTS.CHAT_COPY_INVOKED,
    data: {
      copy_kind: 'code',
      copied_length: code.length,
      identity: chatCopyIdentity(code),
    },
  });
  expect(seen[0].data.identity).not.toBe(code);
});

test('empty copy input remains deterministic and never writes a stringified null value', async () => {
  expect(chatCopyIdentity(null as never)).toBe('0:811c9dc5');
  await expect(handleChatCopy({
    streamId: 'hostc:codex:copy',
    targetId: 'empty',
    copyKind: 'message',
    text: null as never,
  })).resolves.toEqual({ identity: '0:811c9dc5', copiedLength: 0 });
  expect(mockSetStringAsync).toHaveBeenCalledWith('');
});

