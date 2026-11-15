// One failed row for text and voice (operator option B, 2026-11-15): "!", "Failed sending",
// a borderless retry symbol and a borderless X. No "Retry" word, no border.
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SendFailedRow, SendingRow } from '../src/components/SendStatusRow';

jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

const flat = (node: { props: { style?: unknown } }): { borderWidth?: number; backgroundColor?: string } => StyleSheet.flatten(node.props.style as never) ?? {};

test('failed row shows the warning icon, Failed sending, a retry symbol and an X', () => {
  const onRetry = jest.fn(); const onDiscard = jest.fn();
  const view = render(<SendFailedRow testID="user-send-failed" retryTestID="user-send-retry" discardTestID="user-send-discard" onRetry={onRetry} onDiscard={onDiscard} />);
  expect(view.getByTestId('user-send-failed')).toBeTruthy();
  expect(view.getByText('Failed sending')).toBeTruthy();
  const texts = view.UNSAFE_getAllByType(Text).map(node => node.props.children);
  expect(texts).not.toContain('Retry');
  const retry = view.getByTestId('user-send-retry');
  const discard = view.getByTestId('user-send-discard');
  expect(retry.props.accessibilityLabel).toBe('Retry sending');
  expect(discard.props.accessibilityLabel).toBe('Cancel and delete');
  for (const control of [retry, discard]) {
    const style = flat(control);
    expect(style.borderWidth ?? 0).toBe(0);
    expect(style.backgroundColor).toBeUndefined();
  }
  fireEvent.press(retry); expect(onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(discard); expect(onDiscard).toHaveBeenCalledTimes(1);
});

test('a disabled retry does not fire and the X is omitted without a handler', () => {
  const onRetry = jest.fn();
  const view = render(<SendFailedRow testID="row" retryTestID="retry" discardTestID="discard" onRetry={onRetry} retryDisabled />);
  fireEvent.press(view.getByTestId('retry'));
  expect(onRetry).not.toHaveBeenCalled();
  expect(view.queryByTestId('discard')).toBeNull();
});

test('sending row reads Sending', () => {
  const view = render(<SendingRow testID="voice-send-sending" />);
  expect(view.getByTestId('voice-send-sending')).toBeTruthy();
  expect(view.getByText('Sending')).toBeTruthy();
});
