// Voice messages use the text send grammar (operator, 2026-11-15): Sending under the bubble,
// or the shared failed row with a retry symbol and an X. The symbol keeps the safe delivery
// command for each state; the X deletes the local copy at once.
import React from 'react';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import VoiceMessageStatus from '../src/components/voice/VoiceMessageStatus';
import Bevel from '../src/components/Bevel';
import type { VoiceTake } from '../src/services/voiceDelivery';
import { VOICE_SEND_PROGRESS_MS, resetVoiceSendStatusForTests } from '../src/services/voiceSendStatus';
import { Tokens } from '../constants/Colors';

const mockRetry = jest.fn(async (_id: string) => {});
const mockCheck = jest.fn(async (_id: string) => {});
const mockReplay = jest.fn(async (_id: string) => {});
const mockDiscard = jest.fn(async (_id: string, _options?: unknown) => {});
let mockTakes: VoiceTake[] = [];
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('../src/services/voiceDelivery', () => ({ voiceDelivery: {
  retry: (id: string) => mockRetry(id), checkAgain: (id: string) => mockCheck(id),
  sendAgain: (id: string) => mockReplay(id), snapshot: () => ({ takes: mockTakes }),
} }));
jest.mock('../src/services/voiceRecordingEngine', () => ({
  sendVoiceTake: jest.fn(), discardVoiceTake: (id: string, options?: unknown) => mockDiscard(id, options),
}));
jest.mock('../src/services/pentacleStream', () => ({ voiceTransportSnapshot: () => ({ ready: true }) }));
const take = (status: VoiceTake['status'], values: Partial<VoiceTake> = {}): VoiceTake => ({
  recordingId: 'take-1', streamId: 'hosta:original', status, durationS: 3, levels: [0.2, 0.6],
  sendRequestedAt: Date.now(), manifest: {}, ...values,
} as VoiceTake);
const texts = (view: ReturnType<typeof render>) => view.UNSAFE_getAllByType(Text).map(node => String(node.props.children));
let alert: jest.SpyInstance;
beforeEach(() => { jest.useFakeTimers(); resetVoiceSendStatusForTests(); mockTakes = []; alert = jest.spyOn(Alert, 'alert'); });
afterEach(() => { alert.mockRestore(); jest.useRealTimers(); });

test.each(['queued', 'transcribing', 'server_owned'] as const)('%s reads Sending under the bubble', status => {
  const view = render(<VoiceMessageStatus take={take(status)} />);
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  expect(view.getByText('Sending')).toBeTruthy();
  expect(view.queryByText('Uploading')).toBeNull();
  expect(view.queryByTestId('voice-send-failed')).toBeNull();
  expect(view.getByTestId('voice-bubble')).toBeTruthy();
});

test('uploading reads Uploading, then Sending once the upload is done (operator, 2026-11-15)', () => {
  const view = render(<VoiceMessageStatus take={take('uploading')} />);
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  expect(view.getByText('Uploading')).toBeTruthy();
  expect(view.queryByText('Sending')).toBeNull();
  view.rerender(<VoiceMessageStatus take={take('transcribing')} />);
  expect(view.getByText('Sending')).toBeTruthy();
  expect(view.queryByText('Uploading')).toBeNull();
  expect(view.queryByTestId('voice-send-failed')).toBeNull();
  expect(view.getByTestId('voice-bubble')).toBeTruthy();
});

test.each(['failed', 'auth_needed', 'origin_unavailable', 'not_landed'] as const)('%s shows the shared failed row: retry symbol retries, X deletes at once', async status => {
  const view = render(<VoiceMessageStatus take={take(status)} />);
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
  expect(view.getByText('Failed sending')).toBeTruthy();
  expect(texts(view)).not.toEqual(expect.arrayContaining(['Retry']));
  expect(view.UNSAFE_getByType(Bevel).props.stroke).toBe(Tokens.palette.amber);
  await act(async () => fireEvent.press(view.getByLabelText('Retry sending')));
  expect(mockRetry).toHaveBeenCalledWith('take-1');
  await act(async () => fireEvent.press(view.getByLabelText('Cancel and delete')));
  expect(mockDiscard).toHaveBeenCalledWith('take-1', undefined);
  expect(alert).not.toHaveBeenCalled();
});

test('no voice message offers Check again, Send again, Remove local copy or Discard words', () => {
  const states: VoiceTake[] = [
    take('checking', { manifest: { dispatchIntent: {} } as any }),
    take('checking', { manifest: { dispatchIntent: {} } as any, receiptAbsent: true }),
    take('server_owned', { manifest: { serverMandate: {} } as any, sendRequestedAt: Date.now() - VOICE_SEND_PROGRESS_MS }),
    take('failed'),
  ];
  for (const state of states) {
    const view = render(<VoiceMessageStatus take={state} />);
    expect(texts(view).join(' ')).not.toMatch(/check again|send again|local copy|discard|DELIVERY|NOT RECEIVED/i);
    view.unmount();
  }
});

test('the persisted deadline turns Sending into Failed sending and survives a remount', () => {
  const retained = take('transcribing');
  let view = render(<VoiceMessageStatus take={retained} answerCount={2} />);
  expect(view.getByText('ANSWERS 2 QUESTIONS')).toBeTruthy();
  act(() => jest.advanceTimersByTime(VOICE_SEND_PROGRESS_MS - 1));
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1));
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
  view.unmount();
  view = render(<VoiceMessageStatus take={{ ...retained, status: 'queued' }} />);
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
  expect(mockRetry).not.toHaveBeenCalled(); expect(mockDiscard).not.toHaveBeenCalled();
});

test('unmount cancels the presentation timer', () => {
  const view = render(<VoiceMessageStatus take={take('uploading')} />);
  expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);
  view.unmount(); act(() => jest.runOnlyPendingTimers());
  expect(jest.getTimerCount()).toBe(0);
});

test('an active server mandate retries by lookup only', async () => {
  const view = render(<VoiceMessageStatus take={take('server_owned', { manifest: { serverMandate: {} } as any, sendRequestedAt: Date.now() - VOICE_SEND_PROGRESS_MS })} />);
  await act(async () => fireEvent.press(view.getByLabelText('Retry sending')));
  expect(mockCheck).toHaveBeenCalledWith('take-1');
  expect(mockRetry).not.toHaveBeenCalled(); expect(mockReplay).not.toHaveBeenCalled();
});

test('an unconfirmed client intent looks up, and replays exactly only after authoritative absence', async () => {
  const retained = take('checking', { manifest: { dispatchIntent: {} } as any, receiptAbsent: false });
  const view = render(<VoiceMessageStatus take={retained} />);
  await act(async () => fireEvent.press(view.getByLabelText('Retry sending')));
  expect(mockCheck).toHaveBeenCalledWith('take-1'); expect(mockReplay).not.toHaveBeenCalled();
  resetVoiceSendStatusForTests();
  view.rerender(<VoiceMessageStatus take={{ ...retained, receiptAbsent: true }} />);
  await act(async () => fireEvent.press(view.getByLabelText('Retry sending')));
  expect(mockReplay).toHaveBeenCalledWith('take-1');
  expect(mockRetry).not.toHaveBeenCalled();
});

test('retry shows Sending again until the delivery outcome or the display budget', async () => {
  const stale = take('checking', { manifest: { dispatchIntent: {} } as any, sendRequestedAt: Date.now() - VOICE_SEND_PROGRESS_MS });
  const view = render(<VoiceMessageStatus take={stale} />);
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByLabelText('Retry sending')));
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  view.rerender(<VoiceMessageStatus take={{ ...stale, status: 'not_landed' }} />);
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
  view.rerender(<VoiceMessageStatus take={stale} />);
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  act(() => jest.advanceTimersByTime(VOICE_SEND_PROGRESS_MS));
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
});

test('X removes an unconfirmed or server-owned message without a confirm', async () => {
  const intent = take('checking', { manifest: { dispatchIntent: {} } as any });
  let view = render(<VoiceMessageStatus take={intent} />);
  await act(async () => fireEvent.press(view.getByLabelText('Cancel and delete')));
  expect(mockDiscard).toHaveBeenCalledWith('take-1', { removeLocalCopy: true });
  view.unmount(); mockDiscard.mockClear();
  const owned = take('server_owned', { manifest: { serverMandate: {} } as any, sendRequestedAt: Date.now() - VOICE_SEND_PROGRESS_MS });
  mockTakes = [{ ...owned, status: 'checking' }];
  view = render(<VoiceMessageStatus take={owned} />);
  await act(async () => fireEvent.press(view.getByLabelText('Cancel and delete')));
  expect(mockDiscard.mock.calls).toEqual([['take-1', undefined], ['take-1', { removeLocalCopy: true }]]);
  expect(alert).not.toHaveBeenCalled();
});

test('a retry is guarded across repeated presses and command failures become visible', async () => {
  let reject!: (error: Error) => void;
  mockRetry.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  const view = render(<VoiceMessageStatus take={take('failed')} />);
  const button = view.getByLabelText('Retry sending');
  act(() => { fireEvent.press(button); fireEvent.press(button); });
  expect(mockRetry).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Synthetic storage failure')));
  expect(alert).toHaveBeenCalledWith('Voice message', 'Synthetic storage failure');
  expect(view.getByTestId('voice-send-failed')).toBeTruthy();
});

test('an unsent recording keeps its Send and Discard controls', () => {
  const view = render(<VoiceMessageStatus take={take('unsent')} />);
  expect(view.getByLabelText('Send voice message')).toBeTruthy();
  expect(view.getByLabelText('Discard voice message')).toBeTruthy();
  expect(view.queryByTestId('voice-send-failed')).toBeNull();
  expect(view.queryByTestId('voice-send-sending')).toBeNull();
});
