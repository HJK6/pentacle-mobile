import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import VoiceMessageStatus from '../src/components/voice/VoiceMessageStatus';
import type { VoiceTake } from '../src/services/voiceDelivery';
import { VOICE_SEND_PROGRESS_MS } from '../src/services/voiceSendStatus';

const mockRetry = jest.fn(async (_id: string) => {});
const mockCheck = jest.fn(async (_id: string) => {});
const mockReplay = jest.fn(async (_id: string) => {});
const mockDiscard = jest.fn(async (_id: string, _options?: unknown) => {});
jest.mock('../src/services/voiceDelivery', () => ({ voiceDelivery: {
  retry: (id: string) => mockRetry(id), checkAgain: (id: string) => mockCheck(id),
  sendAgain: (id: string) => mockReplay(id), snapshot: () => ({ takes: [] }),
} }));
jest.mock('../src/services/voiceRecordingEngine', () => ({
  sendVoiceTake: jest.fn(), discardVoiceTake: (id: string, options?: unknown) => mockDiscard(id, options),
}));
jest.mock('../src/services/pentacleStream', () => ({ voiceTransportSnapshot: () => ({ ready: true }) }));
const take = (status: VoiceTake['status'], values: Partial<VoiceTake> = {}): VoiceTake => ({
  recordingId: 'take-1', streamId: 'hosta:original', status, durationS: 3,
  sendRequestedAt: Date.now(), manifest: {}, ...values,
} as VoiceTake);
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test.each(['failed', 'auth_needed', 'origin_unavailable', 'not_landed'] as const)('%s exposes row retry and discard', async status => {
  const view = render(<VoiceMessageStatus take={take(status)} />);
  await act(async () => fireEvent.press(view.getByLabelText('Retry voice message')));
  expect(mockRetry).toHaveBeenCalledWith('take-1');
  await act(async () => fireEvent.press(view.getByLabelText('Discard voice message')));
  expect(mockDiscard).toHaveBeenCalledWith('take-1', undefined);
  expect(view.queryByTestId('voice-transcribing-spinner')).toBeNull();
});
test('the persisted deadline stops busy presentation and survives a remount without changing delivery truth', () => {
  const retained = take('transcribing');
  let view = render(<VoiceMessageStatus take={retained} answerCount={2} />);
  expect(view.getByTestId('voice-transcribing-spinner')).toBeTruthy();
  expect(view.getByText('ANSWERS 2 QUESTIONS')).toBeTruthy();
  act(() => jest.advanceTimersByTime(VOICE_SEND_PROGRESS_MS - 1));
  expect(view.getByTestId('voice-transcribing-spinner')).toBeTruthy();
  act(() => jest.advanceTimersByTime(1));
  expect(view.queryByTestId('voice-transcribing-spinner')).toBeNull();
  expect(view.getByText('DELIVERY UNCONFIRMED')).toBeTruthy();
  expect(view.getByLabelText('Discard voice message')).toBeTruthy();
  view.unmount();
  view = render(<VoiceMessageStatus take={{ ...retained, status: 'queued' }} />);
  expect(view.getByText('DELIVERY UNCONFIRMED')).toBeTruthy();
  expect(retained.status).toBe('transcribing');
  expect(mockRetry).not.toHaveBeenCalled(); expect(mockReplay).not.toHaveBeenCalled();
  expect(mockCheck).not.toHaveBeenCalled(); expect(mockDiscard).not.toHaveBeenCalled();
});
test('unmount cancels the presentation timer', () => {
  const view = render(<VoiceMessageStatus take={take('uploading')} />);
  expect(jest.getTimerCount()).toBe(1);
  view.unmount(); expect(jest.getTimerCount()).toBe(0);
});
test('an active server mandate without client intent offers lookup only, including after the deadline', async () => {
  const retained = take('server_owned', { manifest: { serverMandate: {} } as any });
  const view = render(<VoiceMessageStatus take={retained} />);
  act(() => jest.advanceTimersByTime(VOICE_SEND_PROGRESS_MS));
  expect(view.getByText('DELIVERY UNCONFIRMED')).toBeTruthy();
  expect(view.queryByLabelText('Retry voice message')).toBeNull();
  expect(view.queryByLabelText('Send again')).toBeNull();
  await act(async () => fireEvent.press(view.getByLabelText('Check delivery again')));
  expect(mockCheck).toHaveBeenCalledWith('take-1');
  expect(mockReplay).not.toHaveBeenCalled(); expect(mockRetry).not.toHaveBeenCalled();
});
test('only authoritative client-intent absence offers exact replay', async () => {
  const retained = take('checking', { manifest: { dispatchIntent: {} } as any, receiptAbsent: false });
  const view = render(<VoiceMessageStatus take={retained} />);
  expect(view.queryByLabelText('Send again')).toBeNull();
  view.rerender(<VoiceMessageStatus take={{ ...retained, receiptAbsent: true }} />);
  expect(view.getByText('NOT RECEIVED')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByLabelText('Send again')));
  expect(mockReplay).toHaveBeenCalledWith('take-1');
  expect(mockRetry).not.toHaveBeenCalled();
  view.rerender(<VoiceMessageStatus take={{ ...retained, receiptAbsent: true, manifest: { ...retained.manifest, serverMandate: {} } as any }} />);
  expect(view.queryByLabelText('Send again')).toBeNull();
});
test('a retry is guarded across repeated presses and command failures become visible', async () => {
  let reject!: (error: Error) => void;
  mockRetry.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
  const alert = jest.spyOn(Alert, 'alert');
  try {
    const view = render(<VoiceMessageStatus take={take('failed')} />);
    const button = view.getByLabelText('Retry voice message');
    act(() => { fireEvent.press(button); fireEvent.press(button); });
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(view.getByLabelText('Retry voice message').props.accessibilityState.disabled).toBe(true);
    await act(async () => reject(new Error('Synthetic storage failure')));
    expect(alert).toHaveBeenCalledWith('Voice message', 'Synthetic storage failure');
    expect(view.getByLabelText('Retry voice message').props.accessibilityState.disabled).toBe(false);
  } finally { alert.mockRestore(); }
});
