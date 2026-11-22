// A1 (photo/camera send) — media render contract, component level.
// Drives the REAL TranscriptRow (the row that renders the user bubble) with
// attachments, and the REAL ImageViewerModal. Asserts: attached images render in
// the bubble (MediaBubble), tapping one invokes the viewer opener (onPressAttachment),
// and the viewer shows/closes. Deterministic — no async send / transcript-ready timing.

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';
import {
  applyFetchedStreamEvents,
  applyPentacleEvent,
  applyPentacleSnapshotMessage,
  initialPentacleStreamState,
  selectSessionDetail,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleTranscriptItem,
} from 'pentacle-chat-core';
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

function assistantImageItem(overrides: Partial<PentacleTranscriptItem> = {}): PentacleTranscriptItem {
  return {
    id: 'assist_1',
    kind: 'ASSIST',
    text: '',
    isUser: false,
    displayRule: 'bubble:assistant',
    tone: 'assistant',
    label: 'Agent',
    ...overrides,
  } as unknown as PentacleTranscriptItem;
}

const chrome = { border: '#222', surface: '#111', header: '#000', color: '#0f0', accent: '#0f0', label: 'merlin' } as any;

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
      streamId="merlin:codex:one"
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
  expect(onPressAttachment).toHaveBeenCalledWith('file:///tmp/a.jpg', 0);
});

test('a photo-only user row (no text) renders the image without an empty text bubble', () => {
  render(
    <TranscriptRow
      item={userItem({ text: '' })}
      chrome={chrome}
      streamId="merlin:codex:one"
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
      streamId="merlin:codex:one"
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
      streamId="merlin:codex:one"
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
      streamId="merlin:codex:one"
      onPressAttachment={jest.fn()}
    />,
  );
  expect(screen.getByText('look at these')).toBeTruthy();
  expect(screen.queryByTestId('message-image-0')).toBeNull();
});

test('an assistant image row renders the existing MediaBubble and opens the existing viewer', () => {
  const onPressAttachment = jest.fn();
  render(
    <TranscriptRow
      item={assistantImageItem()}
      chrome={chrome}
      streamId="merlin:codex:one"
      attachments={[twoThumbs[0]]}
      onPressAttachment={onPressAttachment}
    />,
  );

  expect(screen.getByTestId('assistant-message-attachments-assist_1')).toBeTruthy();
  expect(screen.getByTestId('assistant-message-image-0')).toBeTruthy();
  expect(screen.queryByTestId('assistant-message-image-0-file')).toBeNull();
  expect(screen.getByTestId('assistant-message-image-0-img').props.accessible).toBe(true);
  fireEvent.press(screen.getByTestId('assistant-message-image-0'));
  expect(onPressAttachment).toHaveBeenCalledWith('file:///tmp/a.jpg', 0);
});

const designTarget = { project_id: 'delivery', design_id: 'delivery-board', view_id: 'prototype' };

function projectedDesignRow(
  dashboardLink: unknown,
  text: string,
  attachments?: PentacleEvent['attachments'],
  ingress: 'live' | 'history' | 'snapshot' = 'live',
) {
  const stream = 'fixture:design-chat';
  const time = '2026-11-21T00:00:00.000Z';
  const session: PentacleSessionSummary = {
    stream_id: stream, host: 'fixture', provider: 'codex', session_name: 'design-chat',
    last_event_at: time, last_text: '', last_kind: '', draft: '', pending: false, working: false, online: true,
  };
  const event: PentacleEvent = {
    stream_id: stream, session_id: stream, host: 'fixture', provider: 'codex', session_name: 'design-chat',
    timestamp: time, daemon_seq: 7, kind: 'ASSIST', text, raw: { dashboard_link: dashboardLink }, attachments,
  };
  const initial = { ...initialPentacleStreamState, connected: true, sessions: [session] };
  const state = ingress === 'snapshot' ? applyPentacleSnapshotMessage(initial, { events: [event], sessions: [session] })
    : ingress === 'history' ? applyFetchedStreamEvents(initial, [event], 500, stream)
    : applyPentacleEvent(initial, event);
  const item = selectSessionDetail(state, stream, { visibleCount: 'all' })?.transcriptItems[0];
  if (!item) throw new Error('Expected a durable assistant row');
  return item;
}

test('a typed assistant preview retains the caption and opens the exact target, including after an image error', () => {
  const item = projectedDesignRow(
    { dashboard: 'design', target: designTarget, title: 'Fixture prototype', subtitle: 'Delivery board' },
    'Synthetic caption',
    [{ key: 'a'.repeat(64), mime: 'image/png' }],
  );
  const open = jest.fn();
  const onAttachmentError = jest.fn();
  const viewImage = jest.fn();
  render(<TranscriptRow item={item} chrome={chrome} attachments={twoThumbs}
    onOpenDesign={open} onAttachmentError={onAttachmentError} onPressAttachment={viewImage} />);
  expect(screen.getByTestId('design-link-image').props.source).toEqual({ uri: twoThumbs[0].uri });
  expect(screen.getByText('Synthetic caption')).toBeTruthy();
  expect(screen.getByText('Design · Delivery board')).toBeTruthy();
  fireEvent.press(screen.getByTestId('design-link-preview'));
  expect(open).toHaveBeenLastCalledWith(designTarget);
  fireEvent(screen.getByTestId('design-link-image'), 'error');
  expect(onAttachmentError).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('design-link-image')).toBeNull();
  fireEvent.press(screen.getByTestId('design-link-preview'));
  expect(open).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByTestId('assistant-message-image-1'));
  expect(viewImage).toHaveBeenCalledWith(twoThumbs[1].uri, 1);
});

test.each(['live', 'history', 'snapshot'] as const)('a captionless target and Home chip remain actionable on %s', ingress => {
  const open = jest.fn();
  const exact = projectedDesignRow({ dashboard: 'design', target: designTarget }, '', undefined, ingress);
  const chip = projectedDesignRow({ dashboard: 'design' }, '', undefined, ingress);
  const { rerender } = render(<TranscriptRow item={exact} chrome={chrome} onOpenDesign={open} />);
  expect(screen.queryByTestId('design-link-image')).toBeNull();
  expect(screen.getByText('Design · delivery-board')).toBeTruthy();
  fireEvent.press(screen.getByTestId('design-link-preview'));
  expect(open).toHaveBeenLastCalledWith(designTarget);
  rerender(<TranscriptRow item={chip} chrome={chrome} onOpenDesign={open} />);
  fireEvent.press(screen.getByTestId('design-link-chip'));
  expect(open).toHaveBeenLastCalledWith(undefined);
});

test.each([{ dashboard: 'design', target: null }, { dashboard: 'unknown' }])(
  'a malformed or unknown link preserves the original caption and attachment',
  link => {
    const open = jest.fn();
    const viewImage = jest.fn();
    const item = projectedDesignRow(link, 'Ordinary caption', [{ key: 'b'.repeat(64), mime: 'image/png' }]);
    render(<TranscriptRow item={item} chrome={chrome} attachments={[twoThumbs[0]]}
      onOpenDesign={open} onPressAttachment={viewImage} />);
    expect(screen.queryByTestId('design-link-preview')).toBeNull();
    expect(screen.queryByTestId('design-link-chip')).toBeNull();
    expect(screen.getByText('Ordinary caption')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-message-image-0'));
    expect(open).not.toHaveBeenCalled();
    expect(viewImage).toHaveBeenCalledWith(twoThumbs[0].uri, 0);
  },
);

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

test('an attachment-only managed file uses the actual transcript file row without an image viewer',()=>{
 const attachment={key:'a'.repeat(64),mime:'application/pdf',filename:'synthetic.pdf',size:12};
 render(<TranscriptRow item={assistantImageItem({kind:'ASSIST_TEXT',text:''} as any)} chrome={chrome}
  streamId="fixture:assistant" attachments={[{kind:'file',uri:'',attachment}]} onPressAttachment={jest.fn()}/>);
 expect(screen.getByText('synthetic.pdf')).toBeTruthy();
 expect(screen.getByTestId('assistant-message-image-0-file-share')).toBeTruthy();
 expect(screen.queryByTestId('assistant-message-image-0-img')).toBeNull();
});
