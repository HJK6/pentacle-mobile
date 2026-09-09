import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import SendingIndicator from '../src/components/SendingIndicator';
import StatusTag from '../src/components/StatusTag';

test('SendingIndicator renders the shared sending arrow glyph', () => {
  render(<SendingIndicator />);
  expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
});

test('StatusTag renders idle, sending, and working icon-only states', () => {
  const idle = render(<StatusTag status="idle" />);
  expect(screen.getByTestId('status-tag-idle')).toBeTruthy();
  expect(screen.queryByText('Idle')).toBeNull();
  idle.unmount();

  const sending = render(<StatusTag status="sending" />);
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  expect(screen.queryByText('Sending')).toBeNull();
  sending.unmount();

  render(<StatusTag status="working" elapsedSeconds={65} />);
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.getByTestId('status-tag-elapsed').props.children).toBe('01:05');
  expect(screen.queryByText('Working')).toBeNull();
});

test('StatusTag renders the unresponsive client label', () => {
  render(<StatusTag status="unresponsive" />);
  expect(screen.getByTestId('status-tag-unresponsive')).toBeTruthy();
  expect(screen.getByText('Unresponsive')).toBeTruthy();
});

describe('StatusTag sending anti-flicker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  test('delayed sending hides the arrow until the threshold elapses', () => {
    render(<StatusTag status="sending" sendingDelayMs={275} />);
    // The tag is already in the sending slot, but the arrow must not flash before the debounce.
    expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
    expect(screen.queryByTestId('status-tag-sending-arrow')).toBeNull();

    act(() => jest.advanceTimersByTime(274));
    expect(screen.queryByTestId('status-tag-sending-arrow')).toBeNull();

    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  });

  test('a fast send that resolves before the threshold never renders the arrow', () => {
    const { rerender } = render(<StatusTag status="sending" sendingDelayMs={275} />);
    act(() => jest.advanceTimersByTime(150));
    // Send acked → status flips to idle before the debounce fires.
    rerender(<StatusTag status="idle" sendingDelayMs={275} />);
    act(() => jest.advanceTimersByTime(200));
    expect(screen.queryByTestId('status-tag-sending-arrow')).toBeNull();
    expect(screen.getByTestId('status-tag-idle')).toBeTruthy();
  });

  test('immediate sending (sendingDelayMs 0, image upload) shows the arrow at once', () => {
    render(<StatusTag status="sending" sendingDelayMs={0} />);
    expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  });

  test('visible-status callback follows the committed indicator and normal transition', () => {
    const onVisibleStatusCommit = jest.fn((status: string) => {
      expect(screen.getByTestId(`status-tag-${status}`)).toBeTruthy();
      expect(
        status === 'sending'
          ? screen.getByTestId('status-tag-sending-arrow')
          : screen.getByTestId('status-tag-working'),
      ).toBeTruthy();
    });
    const rendered = render(
      <StatusTag status="idle" sendingDelayMs={0} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    rendered.rerender(
      <StatusTag status="sending" sendingDelayMs={0} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    expect(onVisibleStatusCommit).toHaveBeenLastCalledWith('sending');

    rendered.rerender(
      <StatusTag status="working" sendingDelayMs={0} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    expect(onVisibleStatusCommit).toHaveBeenLastCalledWith('working');
  });

  test('failed, rapidly reconciled, and unmounted sends emit no visible callback', () => {
    const onVisibleStatusCommit = jest.fn();
    const rendered = render(
      <StatusTag status="sending" sendingDelayMs={275} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    rendered.rerender(
      <StatusTag status="failed" sendingDelayMs={275} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    act(() => jest.advanceTimersByTime(275));
    expect(onVisibleStatusCommit).not.toHaveBeenCalled();

    rendered.rerender(
      <StatusTag status="sending" sendingDelayMs={275} onVisibleStatusCommit={onVisibleStatusCommit} />,
    );
    rendered.unmount();
    act(() => jest.advanceTimersByTime(275));
    expect(onVisibleStatusCommit).not.toHaveBeenCalled();
  });
});
