jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => ({ sessions: [], events: [] }),
  appendOptimisticUserMessage: jest.fn(),
  sendPentacleMessage: jest.fn(),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: any) => selector({ sessions: [], events: [] }),
  usePentacleStreamActions: () => ({}),
}));
jest.mock('../src/hooks/usePentacleToken', () => () => ({ isReady: true, token: 'test-token' }));
jest.mock('../src/services/voiceSendUnit', () => ({
  ...jest.requireActual('../src/services/voiceSendUnit'),
  runVoiceUploadTranscribe: () => new Promise(() => {}),
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

import React from 'react';
import { act, render } from '@testing-library/react-native';

import { TranscriptRow, hostChrome } from '../app/pentacle/session/[streamId]';
import { registerVoiceAnswersBinding, resetVoiceAnswersForTests } from '../src/components/questions/voice/voiceAnswersBinding';
import { voiceDelivery, voiceTakeRow } from '../src/services/voiceDelivery';

const chrome = hostChrome('bart');
const item = (n: number) => ({
  key: `n-${n}:0`, question_id: `q-${n}`, notification_id: `n-${n}`, producer_stream_id: 'hostc:codex:seat',
  surface_stream_id: 'bart:assistant', prompt: `Prompt ${n}?`, segment: { start_s: n, end_s: n + 2 },
});

beforeEach(() => resetVoiceAnswersForTests());

const take = (recordingId: string) => ({ streamId: 'bart:assistant', recordingId, uri: 'file://x', mime: 'audio/mp4', durationS: 5, levels: [0.4], interrupted: false });

// The row reads the process singleton's takes; a never-resolving transcription keeps the take pending.
async function transcribingRow(recordingId: string) {
  await act(async () => { void voiceDelivery.accept(take(recordingId)); });
  return voiceTakeRow(voiceDelivery.snapshot().takes.find((t) => t.recordingId === recordingId)!);
}
async function drop(recordingId: string) {
  await act(async () => { voiceDelivery.discard(recordingId); });
}

test('the transcribing take shows "ANSWERS n QUESTIONS" for a bound recording and nothing for a plain note', async () => {
  registerVoiceAnswersBinding('rec-label', [item(1), item(2)]);
  const bound = render(<TranscriptRow item={await transcribingRow('rec-label')} chrome={chrome} />);
  expect(bound.getByTestId('voice-answers-label').props.children).toBe('ANSWERS 2 QUESTIONS');
  expect(bound.getByText('TRANSCRIBING')).toBeTruthy();
  bound.unmount();
  await drop('rec-label');

  registerVoiceAnswersBinding('rec-one', [item(1)]);
  const one = render(<TranscriptRow item={await transcribingRow('rec-one')} chrome={chrome} />);
  expect(one.getByTestId('voice-answers-label').props.children).toBe('ANSWERS 1 QUESTION');
  one.unmount();
  await drop('rec-one');

  const plain = render(<TranscriptRow item={await transcribingRow('rec-plain')} chrome={chrome} />);
  expect(plain.queryByTestId('voice-answers-label')).toBeNull();
  plain.unmount();
  await drop('rec-plain');
});

test('a dropped binding renders "Couldn\'t attach questions" under the echoed voice turn; bound renders nothing', () => {
  const base = { id: 'echo:1', kind: 'USER', isUser: true, text: 'durable transcript', voice: { duration_s: 7 } };
  const dropped = render(<TranscriptRow item={{ ...base, voiceAnswersStatus: { state: 'dropped', reason: 'identity_mismatch', staleKeys: [] } } as any} chrome={chrome} />);
  expect(dropped.getByTestId('voice-answers-status-dropped').props.children).toBe("Couldn't attach questions");
  const bound = render(<TranscriptRow item={{ ...base, voiceAnswersStatus: { state: 'bound', staleKeys: [] } } as any} chrome={chrome} />);
  expect(bound.queryByTestId('voice-answers-status-dropped')).toBeNull();
});
