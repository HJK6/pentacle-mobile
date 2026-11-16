// A sent voice message is on screen the whole time, in its true state, and reads Failed only when
// it failed (operator, 2026-11-16). Drives the real voice delivery and stream over the synthetic
// socket and reads the rows the chat screen assembles after every step.
import { connect, retain, flush, originId } from './helpers/outboxTransport';
import { assembleSessionTranscriptRows } from '../app/pentacle/session/[streamId]';
import { voiceTakeRow } from '../src/services/voiceDelivery';
import { voiceSendNeedsAttention } from '../src/services/voiceSendStatus';
import { selectSessionDetail } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-clipboard', () => ({}));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

type Journey = Awaited<ReturnType<typeof connect>>;
function screen(j: Journey) {
  const takes = j.voiceDelivery.snapshot().takes;
  const detail = selectSessionDetail(j.stream.getPentacleStreamState(), originId);
  const rows = assembleSessionTranscriptRows([], {}, detail?.transcriptItems ?? [], new Map(), takes.map(voiceTakeRow))
    .filter((row) => row.isUser);
  return {
    rows: rows.length,
    failed: takes.some((take) => voiceSendNeedsAttention(take, Date.now())),
    caption: rows.find((row) => !row.id.startsWith('voice:'))?.receiptCaption,
  };
}

describe('server-owned voice send', () => {
  test('one row from Sending through landed, never Failed, Queued when the daemon queued it', async () => {
    const j = await connect(undefined, true);
    const take = await retain(j);
    const seen: Record<string, ReturnType<typeof screen>> = {};
    const step = async (label: string, change: () => void | Promise<void>) => {
      await change(); await j.voiceDelivery.drain(); await flush(); seen[label] = screen(j);
    };
    await step('sending', () => j.voiceDelivery.send(take.recordingId));
    await step('in flight', () => { j.socket.outboundState = 'in_flight'; });
    await step('committed', () => { j.socket.outboundState = 'committed'; });
    await step('proved, receipt pending', () => { j.socket.outboundState = 'proved'; j.socket.receiptState = 'accepted'; });
    await step('landed and queued', () => { j.socket.receiptState = 'landed'; j.socket.receiptReason = 'provider_queued'; });
    for (const [label, state] of Object.entries(seen)) expect({ label, rows: state.rows, failed: state.failed }).toEqual({ label, rows: 1, failed: false });
    expect(j.voiceDelivery.snapshot().takes).toEqual([]);
    expect(seen['landed and queued'].caption).toBe('queued');
    j.cleanup();
  });
});

describe('client-owned voice send', () => {
  test('reads Sending, not Failed, between the send frame and its result', async () => {
    const j = await connect(undefined, false);
    const take = await retain(j);
    const sending = j.voiceDelivery.send(take.recordingId);
    await flush();
    expect(j.socket.sends()).toHaveLength(1);
    expect(screen(j).failed).toBe(false);
    const sent = j.socket.sends()[0];
    j.socket.message({ type: 'send.result', request_id: sent.request_id, to_stream_id: originId, delivery: 'landed' });
    await sending; await flush();
    expect(screen(j)).toMatchObject({ failed: false });
    j.cleanup();
  });

  test('a send the daemon proves it never received still reads Failed', async () => {
    const j = await connect(undefined, false);
    const take = await retain(j);
    const sending = j.voiceDelivery.send(take.recordingId);
    await flush();
    const sent = j.socket.sends()[0];
    j.socket.message({ type: 'send.result', request_id: sent.request_id, to_stream_id: originId, delivery: 'not_landed', state: 'not_landed' });
    await sending; await flush();
    expect(screen(j)).toMatchObject({ failed: true });
    j.cleanup();
  });
});
