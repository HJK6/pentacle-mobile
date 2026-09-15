import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { MediaBubble } from '../src/components/MediaBubble';
const props = { onPress: () => {}, testID: 'photo', borderColor: '#fff' };
test('genuinely loading, decoded and error states remain distinct', () => {
 render(<MediaBubble {...props} uri="file:///fixture-a.png" />);
 expect(screen.getByTestId('photo-loading')).toBeTruthy();
 fireEvent(screen.getByTestId('photo-img'), 'loadStart');
 fireEvent(screen.getByTestId('photo-img'), 'load');
 expect(screen.queryByTestId('photo-loading')).toBeNull();
});
test('cached decode completion cannot be reversed by late loadStart for the same source', () => {
 render(<MediaBubble {...props} uri="file:///fixture-a.png" />);
 fireEvent(screen.getByTestId('photo-img'), 'load');
 fireEvent(screen.getByTestId('photo-img'), 'loadStart');
 expect(screen.queryByTestId('photo-loading')).toBeNull();
});
test('a new source leaves prior broken state and begins loading', () => {
 const view=render(<MediaBubble {...props} uri="file:///fixture-a.png" />);
 fireEvent(screen.getByTestId('photo-img'), 'error');
 expect(screen.getByTestId('photo-broken')).toBeTruthy();
 view.rerender(<MediaBubble {...props} uri="file:///fixture-b.png" />);
 expect(screen.queryByTestId('photo-broken')).toBeNull();
 expect(screen.getByTestId('photo-loading')).toBeTruthy();
});

test('stale completion cannot settle a replacement source, and a rerender preserves its decoded state', () => {
  const view = render(<MediaBubble {...props} uri="file:///old.png" />);
  const oldLoad = screen.getByTestId('photo-img').props.onLoad;
  view.rerender(<MediaBubble {...props} uri="file:///new.png" />);
  oldLoad();
  expect(screen.getByTestId('photo-loading')).toBeTruthy();
  fireEvent(screen.getByTestId('photo-img'), 'load');
  view.rerender(<MediaBubble {...props} uri="file:///new.png" width={200} height={100} />);
  expect(screen.queryByTestId('photo-loading')).toBeNull();
});
test('empty source shows the fallback and a decoded photo still opens the viewer', () => {
  const onPress = jest.fn();
  const view = render(<MediaBubble {...props} uri="" onPress={onPress} />);
  expect(screen.getByTestId('photo-broken')).toBeTruthy();
  expect(screen.queryByTestId('photo-loading')).toBeNull();
  view.rerender(<MediaBubble {...props} uri="https://example.test/photo.png" onPress={onPress} />);
  fireEvent(screen.getByTestId('photo-img'), 'load');
  fireEvent.press(screen.getByTestId('photo'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
