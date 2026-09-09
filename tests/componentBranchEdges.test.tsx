import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Image, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import ArcaneRingFrame from '../src/components/ArcaneRingFrame';
import { Pill } from '../src/components/ArcaneAtoms';
import Bevel from '../src/components/Bevel';
import { MediaBubble } from '../src/components/MediaBubble';
import ProviderTag from '../src/components/ProviderTag';
import SevTag from '../src/components/SevTag';
import Starfield from '../src/components/Starfield';

test('bevel draws only after a real layout and ignores duplicate dimensions', () => {
  const rendered = render(<Bevel cut={20}><Text>content</Text></Bevel>);
  expect(rendered.UNSAFE_queryByType(Path)).toBeNull();
  const root = rendered.UNSAFE_getAllByType(View)[0];
  fireEvent(root, 'layout', { nativeEvent: { layout: { width: 100, height: 40 } } });
  expect(rendered.UNSAFE_getByType(Svg).props.width).toBe(100);
  expect(rendered.UNSAFE_getByType(Path).props.d).toBe('M0 0 H80 L100 20 V40 H20 L0 20 Z');
  fireEvent(root, 'layout', { nativeEvent: { layout: { width: 100, height: 40 } } });
  fireEvent(root, 'layout', { nativeEvent: { layout: { width: -1, height: 0 } } });
  expect(rendered.UNSAFE_queryByType(Path)).toBeNull();
});

test('media bubble reserves safe fallback geometry and transitions through loading, loaded, and broken states', () => {
  const onPress = jest.fn();
  const rendered = render(<MediaBubble uri="file:///image.jpg" onPress={onPress} testID="media" borderColor="#fff" />);
  expect(screen.getByTestId('media').props.style).toEqual(expect.objectContaining({ width: 220, height: 293 }));
  expect(screen.getByTestId('media-loading')).toBeTruthy();
  fireEvent(screen.getByTestId('media-img'), 'load');
  expect(screen.queryByTestId('media-loading')).toBeNull();
  fireEvent(screen.getByTestId('media-img'), 'loadStart');
  expect(screen.getByTestId('media-loading')).toBeTruthy();
  fireEvent(screen.getByTestId('media-img'), 'error');
  expect(screen.getByTestId('media-broken')).toBeTruthy();
  expect(rendered.UNSAFE_queryByType(Image)).toBeNull();
  fireEvent.press(screen.getByTestId('media'));
  expect(onPress).toHaveBeenCalledTimes(1);

  rendered.rerender(<MediaBubble uri="" width={100} height={400} onPress={onPress} testID="empty-media" borderColor="#fff" />);
  expect(screen.getByTestId('empty-media').props.style).toEqual(expect.objectContaining({ width: 80, height: 320 }));
  expect(screen.getByTestId('empty-media-broken')).toBeTruthy();
});

test('arcane presentation primitives honor explicit children and safe visual fallbacks', () => {
  const child = <Text>custom sigil</Text>;
  const ring = render(<ArcaneRingFrame color="#abcdef">{child}</ArcaneRingFrame>);
  expect(screen.getByText('custom sigil')).toBeTruthy();
  ring.rerender(<ArcaneRingFrame kind="sun" sigilSize={20} />);
  expect(screen.queryByText('custom sigil')).toBeNull();

  const tags = render(<><ProviderTag provider="other" /><SevTag severity="" /><SevTag severity="custom" /></>);
  expect(screen.getByText('Codex')).toBeTruthy();
  expect(screen.getByText('INFO')).toBeTruthy();
  expect(screen.getByText('CUSTOM')).toBeTruthy();
  tags.rerender(<Pill><View testID="pill-child" /></Pill>);
  expect(screen.getByTestId('pill-child')).toBeTruthy();
  tags.rerender(<Starfield n={2} seed={9} />);
  expect(tags.UNSAFE_getAllByType(View).length).toBeGreaterThanOrEqual(3);
});
