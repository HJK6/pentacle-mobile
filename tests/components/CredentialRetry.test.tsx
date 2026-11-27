import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import CredentialRetry from '../../src/components/CredentialRetry';

test('Try again re-reads the credential once per press and ignores taps while reading', async () => {
  let finish: () => void = () => undefined;
  const onRetry = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<CredentialRetry onRetry={onRetry} />);

  fireEvent.press(view.getByTestId('credential-retry'));
  fireEvent.press(view.getByTestId('credential-retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(view.queryByText('Try again')).toBeNull();

  await act(async () => { finish(); });
  await waitFor(() => expect(view.getByText('Try again')).toBeTruthy());
  fireEvent.press(view.getByTestId('credential-retry'));
  expect(onRetry).toHaveBeenCalledTimes(2);
});
