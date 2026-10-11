jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => ({ sessions: [], events: [] }),
  appendOptimisticUserMessage: jest.fn(),
  sendPentacleMessage: jest.fn(),
  voiceTransportSnapshot: () => ({ ready: false }),
  forgetVoiceDispatchIntent: jest.fn(),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) =>
    selector({ sessions: [], events: [] }),
  usePentacleStreamActions: () => ({}),
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('../src/services/voiceSendUnit', () => ({
  ...jest.requireActual('../src/services/voiceSendUnit'),
  runVoiceUploadTranscribe: () => new Promise(() => {}),
}));
// Use the production repository and projection, with only disk IO synthetic.
jest.mock('../src/services/voiceTakeStore', () => {
  const actual = jest.requireActual('../src/services/voiceTakeStore');
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  let serial = 0;
  const io = {
    root: 'file:///documents/voice-takes-v1/',
    cacheRoot: 'file:///cache/',
    now: () => 1000,
    uuid: () => `123e4567-e89b-42d3-a456-${String(++serial).padStart(12, '0')}`,
    stat: async (p: string) => ({
      exists: files.has(p) || dirs.has(p),
      size: files.get(p)?.length ?? 0,
      directory: dirs.has(p),
    }),
    list: async (p: string) => [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((k) => k.startsWith(p) && k !== p)
          .map((k) => k.slice(p.length).split('/')[0]),
      ),
    ],
    mkdir: async (p: string) => {
      dirs.add(p);
    },
    read: async (p: string) => {
      if (!files.has(p)) throw Error('ENOENT');
      return files.get(p)!;
    },
    write: async (p: string, text: string) => {
      files.set(p, text);
    },
    move: async (a: string, b: string) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    copy: async (a: string, b: string) => {
      files.set(b, files.get(a)!);
    },
    remove: async (p: string) => {
      for (const key of [...files.keys()])
        if (key === p || key.startsWith(p.endsWith('/') ? p : p + '/')) files.delete(key);
      dirs.delete(p);
    },
    free: async () => 1024 * 1024 * 1024,
    inspect: async (p: string) => {
      if (!files.has(p)) throw Error('ENOENT');
      return { bytes: files.get(p)!.length, sha256: 'a'.repeat(64) };
    },
  };
  return { ...actual, voiceTakeStore: new actual.VoiceTakeStore(io), __rowFiles: files };
});
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

import React from 'react';
import { act, render } from '@testing-library/react-native';

import { TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import {
  registerVoiceAnswersBinding,
  resetVoiceAnswersForTests,
} from '../src/components/questions/voice/voiceAnswersBinding';
import { voiceDelivery, voiceTakeRow } from '../src/services/voiceDelivery';
import { voiceTakeStore } from '../src/services/voiceTakeStore';

const chrome = hostChrome('bart');
const item = (n: number) => ({
  key: `n-${n}:0`,
  question_id: `q-${n}`,
  notification_id: `n-${n}`,
  producer_stream_id: 'hostc:codex:seat',
  surface_stream_id: 'bart:assistant',
  prompt: `Prompt ${n}?`,
  segment: { start_s: n, end_s: n + 2 },
});

beforeEach(() => resetVoiceAnswersForTests());

// Explicitly adopt owned audio, request Send, and commit its pending phase. Rendering
// does not invoke ASR, and the durable manifest is the source of row state.
async function transcribingRow(answerCount: number, restored = false) {
  const scope = {
    serverIdentity: 'wss://synthetic.invalid/ws',
    credentialId: 'synthetic-operator',
  };
  let id = '';
  await act(async () => {
    await voiceTakeStore.setScope(scope);
    const take = await voiceTakeStore.create({
      scope,
      origin: { streamId: 'bart:assistant', generation: 'generation-1', label: 'Synthetic origin' },
      operationKind: answerCount ? 'voice_answer' : 'voice_chat',
    });
    id = take.recordingId;
    const answers = Array.from({ length: answerCount }, (_, n) => item(n + 1));
    if (answerCount) registerVoiceAnswersBinding(id, answers);
    const uri = `file:///cache/${id}.m4a`;
    require('../src/services/voiceTakeStore').__rowFiles.set(uri, 'synthetic audio');
    await voiceTakeStore.adoptFinalized(id, {
      uri,
      mime: 'audio/mp4',
      capturedAudioMs: 5000,
      ...(answerCount ? { frozenAnswers: answers } : {}),
    });
    await voiceTakeStore.requestSend(id);
    await voiceTakeStore.setDelivery(id, { phase: 'transcribing' });
    if (restored) resetVoiceAnswersForTests();
  });
  return {
    id,
    row: voiceTakeRow(voiceDelivery.snapshot().takes.find((t) => t.recordingId === id)!),
  };
}
async function drop(recordingId: string) {
  await act(async () => {
    await voiceDelivery.discard(recordingId);
  });
}

test('the transcribing take shows "ANSWERS n QUESTIONS" for a bound recording and nothing for a plain note', async () => {
  const twoTake = await transcribingRow(2);
  const bound = render(<TranscriptRow item={twoTake.row} chrome={chrome} />);
  expect(bound.getByTestId('voice-answers-label').props.children).toBe('ANSWERS 2 QUESTIONS');
  expect(bound.getByText('TRANSCRIBING')).toBeTruthy();
  bound.unmount();
  await drop(twoTake.id);

  const oneTake = await transcribingRow(1);
  const one = render(<TranscriptRow item={oneTake.row} chrome={chrome} />);
  expect(one.getByTestId('voice-answers-label').props.children).toBe('ANSWERS 1 QUESTION');
  one.unmount();
  await drop(oneTake.id);

  const plainTake = await transcribingRow(0);
  const plain = render(<TranscriptRow item={plainTake.row} chrome={chrome} />);
  expect(plain.queryByTestId('voice-answers-label')).toBeNull();
  plain.unmount();
  await drop(plainTake.id);
});

test('CAP-06 restored pending row keeps its persisted answer count with no process binding', async () => {
  const take = await transcribingRow(2, true);
  const row = render(<TranscriptRow item={take.row} chrome={chrome} />);
  expect(row.getByTestId('voice-answers-label').props.children).toBe('ANSWERS 2 QUESTIONS');
  expect(row.getByText('TRANSCRIBING')).toBeTruthy();
  row.unmount();
  await drop(take.id);
});

test('a dropped binding renders "Couldn\'t attach questions" under the echoed voice turn; bound renders nothing', () => {
  const base = {
    id: 'echo:1',
    kind: 'USER',
    isUser: true,
    text: 'durable transcript',
    voice: { duration_s: 7 },
  };
  const dropped = render(
    <TranscriptRow
      item={
        {
          ...base,
          voiceAnswersStatus: { state: 'dropped', reason: 'identity_mismatch', staleKeys: [] },
        } as any
      }
      chrome={chrome}
    />,
  );
  expect(dropped.getByTestId('voice-answers-status-dropped').props.children).toBe(
    "Couldn't attach questions",
  );
  const bound = render(
    <TranscriptRow
      item={{ ...base, voiceAnswersStatus: { state: 'bound', staleKeys: [] } } as any}
      chrome={chrome}
    />,
  );
  expect(bound.queryByTestId('voice-answers-status-dropped')).toBeNull();
});
