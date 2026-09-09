import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { WandCastSendIcon, CrescentDartSendIcon } from '../src/components/SendGlyphs';

test('WandCastSendIcon (primary send glyph) renders', () => {
  render(<WandCastSendIcon color="#3dff66" />);
  expect(screen.getByTestId('send-icon-wand')).toBeTruthy();
});

test('CrescentDartSendIcon (backup send glyph) renders', () => {
  render(<CrescentDartSendIcon color="#3dff66" />);
  expect(screen.getByTestId('send-icon-crescent')).toBeTruthy();
});
