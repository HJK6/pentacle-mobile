// A1 (photo/camera send) — media render contract, component level.
// Drives the REAL TranscriptRow (the row that renders the user bubble) with
// attachments, and the REAL ImageViewerModal. Asserts: attached images render in
// the bubble (MediaBubble), tapping one invokes the viewer opener (onPressAttachment),
// and the viewer shows/closes. Deterministic — no async send / transcript-ready timing.

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';
import type { PentacleTranscriptItem } from 'pentacle-chat-core';
import { TranscriptRow } from '../app/pentacle/session/[streamId]';
import { ImageViewerModal } from '../src/components/ImageViewerModal';
import type { RenderAttachment } from '../src/types/renderAttachment';

jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@expo/vector-icons', () => ({ FontAwesome: 'FontAwesome' }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());

function userItem(overrides: Partial<PentacleTranscriptItem> = {}): PentacleTranscriptItem {
  return {
    id: 'optimistic_1',
    kind: 'USER',
    text: 'look at these',
    isUser: true,
    displayRule: 'bubble:user',
    tone: 'user',
    label: '',
    optimisticId: 'optimistic_1',
    pending: true,
    ...overrides,
  } as unknown as PentacleTranscriptItem;
}

const chrome = { border: '#222', surface: '#111', header: '#000', color: '#0f0', accent: '#0f0', label: 'hostc' } as any;

const twoThumbs: RenderAttachment[] = [
  { uri: 'file:///tmp/a.jpg', width: 100, height: 200 },
  { uri: 'file:///tmp/b.jpg', width: 300, height: 400 },
];

test('a user bubble renders one MediaBubble per attachment (FIFO) and tap calls the viewer opener', () => {
  const onPressAttachment = jest.fn();
  render(
    <TranscriptRow
      item={userItem()}
      chrome={chrome}
      streamId="hostc:codex:one"
      attachments={twoThumbs}
      onPressAttachment={onPressAttachment}
    />,
  );

  // The caption text still renders alongside the images.
  expect(screen.getByText('look at these')).toBeTruthy();
  // Two image thumbs render in FIFO order.
  expect(screen.getByTestId('message-image-0')).toBeTruthy();
  expect(screen.getByTestId('message-image-1')).toBeTruthy();

  // Tapping the first opens the viewer with that image's uri.
  fireEvent.press(screen.getByTestId('message-image-0'));
  expect(onPressAttachment).toHaveBeenCalledWith('file:///tmp/a.jpg');
});

test('a photo-only user row (no text) renders the image without an empty text bubble', () => {
  render(
    <TranscriptRow
      item={userItem({ text: '' })}
      chrome={chrome}
      streamId="hostc:codex:one"
      attachments={[twoThumbs[0]]}
      onPressAttachment={jest.fn()}
    />,
  );
  expect(screen.getByTestId('message-image-0')).toBeTruthy();
  expect(screen.queryByText('look at these')).toBeNull();
});

test('an ordinary pending user row renders a sending affordance', () => {
  render(
    <TranscriptRow
      // An uncorrelated optimistic send (client_origin + optimistic_id, no
      // correlatedDaemonSeq) projects receiptCaption 'sending' in chat-core
      // (receiptCaptionForLatestUserEvent); userSendAffordance renders the
      // sending row off that caption, not the raw sendState.
      item={userItem({ receiptCaption: 'sending' } as Partial<PentacleTranscriptItem>)}
      chrome={chrome}
      streamId="hostc:codex:one"
      attachments={[twoThumbs[0]]}
      onPressAttachment={jest.fn()}
    />,
  );
  const sendingRow = screen.getByTestId('user-send-sending');
  expect(sendingRow).toBeTruthy();
  expect(within(sendingRow).getByTestId('status-tag-sending-arrow')).toBeTruthy();
  expect(within(sendingRow).UNSAFE_queryByType(ActivityIndicator)).toBeNull();
  expect(screen.getByText('Sending')).toBeTruthy();
});

test('a failed attachment send renders a failed affordance without dropping the image', () => {
  render(
    <TranscriptRow
      item={userItem({ text: '', sendState: 'failed', pending: false } as Partial<PentacleTranscriptItem>)}
      chrome={chrome}
      streamId="hostc:codex:one"
      attachments={[twoThumbs[0]]}
      onPressAttachment={jest.fn()}
    />,
  );
  expect(screen.getByTestId('message-image-0')).toBeTruthy();
  expect(screen.getByTestId('user-send-failed')).toBeTruthy();
});

test('a user row without attachments renders no image bubble (text-only unaffected)', () => {
  render(
    <TranscriptRow
      item={userItem()}
      chrome={chrome}
      streamId="hostc:codex:one"
      onPressAttachment={jest.fn()}
    />,
  );
  expect(screen.getByText('look at these')).toBeTruthy();
  expect(screen.queryByTestId('message-image-0')).toBeNull();
});

test('ImageViewerModal shows the tapped image and closes', () => {
  const onClose = jest.fn();
  const { rerender } = render(<ImageViewerModal uri="file:///tmp/a.jpg" onClose={onClose} />);
  expect(screen.getByTestId('image-viewer-image')).toBeTruthy();

  fireEvent.press(screen.getByTestId('image-viewer-close'));
  expect(onClose).toHaveBeenCalled();

  // No uri → nothing to view.
  rerender(<ImageViewerModal uri={null} onClose={onClose} />);
  expect(screen.queryByTestId('image-viewer-image')).toBeNull();
});

