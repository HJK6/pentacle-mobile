import React from 'react';
import * as ReactNative from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { connect, flush, image, mockDisk, originId } from './helpers/outboxTransport';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));

// Only native/filesystem and the daemon peer are synthetic. The row, outbox,
// cancel RPC and local removal all run their production code.
beforeEach(() => {
  jest.doMock('react', () => React);
  jest.doMock('react-native', () => ReactNative);
});
afterEach(() => jest.restoreAllMocks());

async function photoRow() {
  const j = await connect(undefined, true);
  const id = j.stream.sendTurn(originId, 'Synthetic retained photo')!;
  await j.stream.sendPhotoOutbox(id, [image]);
  const store = require('../src/services/outboxStore').outboxStore;
  const entry = store.snapshot().entries[0];
  const { TranscriptRow, hostChrome } = require('../app/pentacle/session/[streamId]');
  const item = require('pentacle-chat-core').selectSessionDetail(
    j.stream.getPentacleStreamState(), originId, { visibleCount: 'all' },
  ).transcriptItems.find((v: any) => v.optimisticId === id);
  expect(item).toBeDefined();
  const view = render(<TranscriptRow item={item} chrome={hostChrome('hosta')} />);
  return { j, id, store, entry, view, path: entry.attachments[0].staged_path };
}

test('retained photo row reuses Remove local copy and cancels before deleting staged bytes', async () => {
  const { j, id, store, view, path } = await photoRow();
  try {
    j.socket.outboundState = 'cancelled';
    await act(async () => { fireEvent.press(view.getByLabelText('Remove local copy')); await flush(); });
    expect(j.socket.frames('outbound.cancel')).toHaveLength(1);
    expect(mockDisk.has(path)).toBe(false);
    expect(store.snapshot().entries).toEqual([]);
    expect(j.stream.getPentacleStreamState().optimisticSends?.[id]).toBeUndefined();
    expect(j.socket.sends()).toEqual([]);
  } finally { view.unmount(); j.cleanup(); }
});

test('in-flight photo keeps its bytes until explicit existing Remove local copy confirmation', async () => {
  const { j, store, view, path } = await photoRow();
  const alert = jest.spyOn(ReactNative.Alert, 'alert');
  try {
    j.socket.outboundState = 'in_flight';
    await act(async () => { fireEvent.press(view.getByLabelText('Remove local copy')); await flush(); });
    expect(j.socket.frames('outbound.cancel')).toHaveLength(1);
    expect(mockDisk.has(path)).toBe(true);
    expect(store.snapshot().entries).toHaveLength(1);
    expect(view.queryByTestId('user-send-sent')).toBeNull();
    const [title, body, buttons] = alert.mock.calls.at(-1)!;
    expect(title).toBe('Remove local copy?');
    expect(body).toBe('This message is already on the server and may still be sent.');
    expect(buttons?.find(b => b.text === 'Keep')?.style).toBe('cancel');
    await act(async () => { buttons?.find(b => b.text === 'Remove local copy')?.onPress?.(); await flush(); });
    expect(mockDisk.has(path)).toBe(false);
    expect(store.snapshot().entries).toEqual([]);
    expect(j.socket.frames('outbound.cancel')).toHaveLength(1);
    expect(j.socket.sends()).toEqual([]);
  } finally { view.unmount(); j.cleanup(); }
});

test('offline photo removal uses the same explicit confirmation and never implies server cancellation', async () => {
  const { j, store, view, path } = await photoRow();
  const alert = jest.spyOn(ReactNative.Alert, 'alert');
  try {
    await act(async () => { j.socket.close(); await flush(); });
    await act(async () => { fireEvent.press(view.getByLabelText('Remove local copy')); await flush(); });
    expect(mockDisk.has(path)).toBe(true);
    expect(j.socket.frames('outbound.cancel')).toEqual([]);
    const buttons = alert.mock.calls.at(-1)![2];
    await act(async () => { buttons?.find(b => b.text === 'Remove local copy')?.onPress?.(); await flush(); });
    expect(store.snapshot().entries).toEqual([]);
    expect(mockDisk.has(path)).toBe(false);
    expect(j.socket.sends()).toEqual([]);
  } finally { view.unmount(); j.cleanup(); }
});

test('a stale photo confirmation cannot remove a held entry after credential change', async () => {
  const { j, store, view, path } = await photoRow();
  const alert = jest.spyOn(ReactNative.Alert, 'alert');
  try {
    j.socket.outboundState = 'in_flight';
    await act(async () => { fireEvent.press(view.getByLabelText('Remove local copy')); await flush(); });
    const buttons = alert.mock.calls.at(-1)![2];
    await act(async () => { j.stream.setPentacleAuthToken(null); await flush(); });
    await act(async () => { buttons?.find(b => b.text === 'Remove local copy')?.onPress?.(); await flush(); });
    expect(mockDisk.has(path)).toBe(true);
    expect(store.snapshot().heldCount).toBe(1);
    expect(view.queryByLabelText('Remove local copy')).toBeNull();
    expect(j.socket.sends()).toEqual([]);
  } finally { view.unmount(); j.cleanup(); }
});
