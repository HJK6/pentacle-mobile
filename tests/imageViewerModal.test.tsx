import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, ScrollView } from 'react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { ImageViewerModal } from '../src/components/ImageViewerModal';
import { createImageGallery, type ImageGallery } from '../src/services/imageGallery';
import { resolveImageAttachment } from '../src/services/attachmentFetch';
import { shareImage } from '../src/services/imageShare';

jest.mock('../src/services/attachmentFetch', () => ({ resolveImageAttachment: jest.fn() }));
jest.mock('../src/services/imageShare', () => ({ shareImage: jest.fn() }));
jest.mock('../src/services/voicePresentation', () => ({ useVoiceSurface: jest.fn() }));
jest.mock('../src/components/voice/VoiceRecordingOverlay', () => () => null);
jest.mock('@expo/vector-icons', () => ({ FontAwesome: 'FontAwesome' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }) }));
const image = (key: string) => ({ key, mime: 'image/png', uri: `file:///${key}.png`, width: 640, height: 960 });
function gallery(): ImageGallery {
  return createImageGallery([{ id: 'new', attachments: [image('new')] }, { id: 'old', attachments: [image('old'), image('middle')] }], 'old', 1)!;
}
async function loaded() {
  await act(async () => { await Promise.resolve(); });
  fireEvent(screen.getByTestId('image-viewer-image'), 'load', { nativeEvent: { source: { width: 640, height: 960 } } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
function swipe(translationX: number) {
  act(() => { fireGestureHandler(getByGestureTestId('image-page-swipe'), [{ translationX, translationY: 0 }]); });
}
function nativeZoom(zoomScale: number) {
  fireEvent.scroll(screen.getByTestId('image-viewer-scroll'), { nativeEvent: { zoomScale, contentOffset: { x: 0, y: 0 } } });
}
beforeEach(() => {
  jest.mocked(resolveImageAttachment).mockImplementation(async attachment => (attachment as any).uri);
  jest.mocked(shareImage).mockResolvedValue(undefined);
});

test('pages chronologically at fit, locks paging while zoomed, resets every entered page and never wraps', async () => {
  render(<ImageViewerModal gallery={gallery()} onClose={jest.fn()} />);
  await loaded();
  expect(screen.getByLabelText('Chat image 2 of 3').props.source.uri).toBe('file:///middle.png');
  nativeZoom(2);
  swipe(-160);
  expect(screen.getByLabelText('Chat image 2 of 3')).toBeTruthy();
  nativeZoom(1);
  swipe(-160); await loaded();
  expect(screen.getByLabelText('Chat image 3 of 3').props.accessibilityValue.text).toBe('100% zoom');
  swipe(-160);
  expect(screen.getByLabelText('Chat image 3 of 3')).toBeTruthy();
  swipe(160); await loaded();
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('100% zoom');
  swipe(160); await loaded();
  swipe(160);
  expect(screen.getByLabelText('Chat image 1 of 3')).toBeTruthy();
});

test('active-image sharing suppresses repeated activation and aborts preparation on page change', async () => {
  let finish!: () => void;
  jest.mocked(shareImage).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<ImageViewerModal gallery={gallery()} onClose={jest.fn()} />);
  await loaded();
  fireEvent.press(screen.getByLabelText('Share image'));
  fireEvent.press(screen.getByLabelText('Share image'));
  expect(shareImage).toHaveBeenCalledTimes(1);
  expect(shareImage).toHaveBeenLastCalledWith('file:///middle.png', 'image/png', expect.any(AbortSignal), expect.objectContaining({ width: 44, height: 44 }));
  const signal = jest.mocked(shareImage).mock.calls[0][2];
  swipe(-160); await loaded();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(); });
  fireEvent.press(screen.getByLabelText('Share image'));
  await waitFor(() => expect(shareImage).toHaveBeenLastCalledWith('file:///new.png', 'image/png', expect.any(AbortSignal), expect.any(Object)));
});

test('load failure, retry, accessible previous/back and close remain usable', async () => {
  jest.mocked(resolveImageAttachment).mockImplementation(async attachment => {
    if (attachment.key === 'middle') throw new Error('expired');
    return (attachment as any).uri;
  });
  const close = jest.fn();
  render(<ImageViewerModal gallery={gallery()} onClose={close} />);
  await waitFor(() => expect(screen.getByText('Could not load this image.')).toBeTruthy());
  jest.mocked(resolveImageAttachment).mockImplementation(async attachment => (attachment as any).uri);
  fireEvent.press(screen.getByTestId('image-viewer-retry'));
  await loaded();
  fireEvent(screen.getByTestId('image-viewer-image'), 'accessibilityAction', { nativeEvent: { actionName: 'previous' } });
  await loaded();
  expect(screen.getByLabelText('Chat image 1 of 3')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close image'));
  expect(close).toHaveBeenCalledTimes(1);
});

test('close aborts pending share; failures allow another attempt without losing the viewer', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.mocked(shareImage).mockRejectedValueOnce(new Error('unavailable'));
  const close = jest.fn();
  const { unmount } = render(<ImageViewerModal gallery={gallery()} onClose={close} />);
  await loaded();
  fireEvent.press(screen.getByLabelText('Share image'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  let finish!: () => void;
  jest.mocked(shareImage).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.press(screen.getByLabelText('Share image'));
  const signal = jest.mocked(shareImage).mock.calls[1][2];
  fireEvent.press(screen.getByLabelText('Close image'));
  expect(signal.aborted).toBe(true);
  unmount();
  await act(async () => { finish(); });
  alert.mockRestore();
});

test('replacing the opening and resizing the viewport reset native zoom and cancel old preparation', async () => {
  const first = gallery();
  const { rerender } = render(<ImageViewerModal gallery={first} onClose={jest.fn()} />);
  await loaded(); nativeZoom(3);
  fireEvent(screen.getByTestId('image-viewer-viewport'), 'layout', { nativeEvent: { layout: { width: 500, height: 700 } } });
  await loaded();
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('100% zoom');
  nativeZoom(2);
  rerender(<ImageViewerModal gallery={gallery()} onClose={jest.fn()} />);
  await loaded();
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('100% zoom');
});


test('double-tap requests native zoom and waits for native scale without dispatching close', async () => {
  const request = jest.spyOn(ScrollView.prototype, 'scrollResponderZoomTo');
  const close = jest.fn();
  render(<ImageViewerModal gallery={gallery()} onClose={close} />);
  await loaded();
  act(() => { fireGestureHandler(getByGestureTestId('image-double-tap'), [{ x: 140, y: 240 }]); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('100% zoom');
  nativeZoom(2);
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('200% zoom');
  expect(close).not.toHaveBeenCalled();
  act(() => { fireGestureHandler(getByGestureTestId('image-double-tap'), [{ x: 140, y: 240 }]); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][0].width).toBe(request.mock.calls[0][0].width * 2);
  nativeZoom(1);
  expect(screen.getByLabelText('Chat image 2 of 3').props.accessibilityValue.text).toBe('100% zoom');
  expect(close).not.toHaveBeenCalled();
  request.mockRestore();
});


test('completed native drag or multi-touch cannot also dispatch tap-to-close', async () => {
  const close = jest.fn();
  render(<ImageViewerModal gallery={gallery()} onClose={close} />);
  await loaded();
  fireEvent(screen.getByTestId('image-viewer-scroll'), 'scrollBeginDrag');
  act(() => { fireGestureHandler(getByGestureTestId('image-single-tap')); });
  expect(close).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('image-viewer-scroll'), 'touchStart', { nativeEvent: { touches: [{}, {}] } });
  act(() => { fireGestureHandler(getByGestureTestId('image-single-tap')); });
  expect(close).not.toHaveBeenCalled();
  fireEvent(screen.getByTestId('image-viewer-scroll'), 'touchStart', { nativeEvent: { touches: [{}] } });
  act(() => { fireGestureHandler(getByGestureTestId('image-single-tap')); });
  expect(close).toHaveBeenCalledTimes(1);
});

test('a single-image opening has no wrapping or inaccessible neighbor action', async () => {
  const single = createImageGallery([{ id: 'only', attachments: [image('only')] }], 'only', 0)!;
  render(<ImageViewerModal gallery={single} onClose={jest.fn()} />);
  await loaded(); swipe(-160); swipe(160);
  expect(screen.getByLabelText('Chat image 1 of 1').props.accessibilityActions).toEqual([]);
});


test('an unresolved old page cannot replace the next image when its resolver finishes late', async () => {
  let finish!: (uri: string) => void;
  const snapshot = gallery();
  delete snapshot.images[1].attachment.uri;
  jest.mocked(resolveImageAttachment).mockImplementation(async attachment => {
    if (attachment.key === 'middle') return new Promise<string>(resolve => { finish = resolve; });
    return (attachment as any).uri;
  });
  render(<ImageViewerModal gallery={snapshot} onClose={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId('image-viewer-loading')).toBeTruthy();
  fireEvent(screen.getByTestId('image-viewer-loading'), 'accessibilityAction', { nativeEvent: { actionName: 'next' } });
  await loaded();
  await act(async () => { finish('file:///late-middle.png'); });
  expect(screen.getByLabelText('Chat image 3 of 3').props.source.uri).toBe('file:///new.png');
});
