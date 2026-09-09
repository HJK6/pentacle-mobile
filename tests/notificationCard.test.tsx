import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import NotificationCard from '../src/components/NotificationCard';
import type { PentacleNotification } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const mockResolveNotification = jest.fn().mockResolvedValue(true);
jest.mock('../src/services/pentacleStream', () => ({
  resolveNotification: (args: unknown) => mockResolveNotification(args),
}));

function notification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: 'n1',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'example-producer',
    severity: 'warning',
    title: 'Lead needs a decision',
    body: 'Approve outreach?',
    dedup_key: 'dk-1',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

afterEach(() => {
  mockResolveNotification.mockClear();
});

test('message-only notification (no actions) renders no buttons', () => {
  render(<NotificationCard notification={notification({ actions: [] })} />);
  expect(screen.getByTestId('notification-card')).toBeTruthy();
  expect(screen.queryByTestId('notification-action-yes')).toBeNull();
  expect(screen.queryByTestId('notification-action-ack')).toBeNull();
  expect(screen.queryByTestId('notification-action-run_command')).toBeNull();
});

test('informational mode hides open action buttons and the INFO label', () => {
  render(
    <NotificationCard
      informational
      notification={notification({
        severity: 'info',
        actions: [{ kind: 'run_command', action_id: 'r0', label: 'Run cleanup' }],
      })}
    />,
  );
  expect(screen.getByTestId('notification-card')).toBeTruthy();
  expect(screen.queryByText('INFO')).toBeNull();
  expect(screen.queryByText('Run cleanup')).toBeNull();
  expect(screen.queryByTestId('notification-action-run_command')).toBeNull();
});

test('informational mode annotates an in-flight resolution without removing the card', () => {
  render(
    <NotificationCard
      informational
      notification={notification({ client_resolution_pending: true } as Partial<PentacleNotification>)}
    />,
  );

  expect(screen.getByTestId('notification-card')).toBeTruthy();
  expect(screen.getByTestId('notification-resolution-pending')).toHaveTextContent('Resolving…');
});

test('open yes_no notification Yes/No forward action_id + choice', () => {
  render(<NotificationCard notification={notification({ actions: [{ kind: 'yes_no', action_id: 'a0' }] })} />);
  fireEvent.press(screen.getByTestId('notification-action-yes'));
  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  });
});

test('open ack notification renders Acknowledge and forwards action_id', () => {
  render(<NotificationCard notification={notification({ actions: [{ kind: 'ack', action_id: 'ack0' }] })} />);
  fireEvent.press(screen.getByTestId('notification-action-ack'));
  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'n1',
    action_kind: 'ack',
    action_id: 'ack0',
  });
});

test('free_text question renders input and submits exact text through notification resolve', () => {
  const typed = `  keep
spacing  `;
  render(
    <NotificationCard
      notification={notification({
        notification_id: 'free-text-n',
        actions: [{ kind: 'ack', action_id: 'ack0' }],
        question: {
          question_id: 'q-free',
          producer_stream_id: 'hostc:codex:asker',
          response_mode: 'free_text' as any,
          options: [],
          state: 'open',
          answer: null,
        },
      })}
    />,
  );
  fireEvent.press(screen.getByTestId('notification-action-ack'));
  expect(mockResolveNotification).not.toHaveBeenCalled();

  fireEvent.changeText(screen.getByTestId('notification-free-text-input'), typed);
  fireEvent.press(screen.getByTestId('notification-action-ack'));

  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'free-text-n',
    action_kind: 'ack',
    question_id: 'q-free',
    action_id: 'ack0',
    text: typed,
  });
});

test('open spawn_worker notification renders Spawn investigator and forwards action_id', () => {
  render(<NotificationCard notification={notification({ actions: [{ kind: 'spawn_worker', action_id: 's0' }] })} />);
  fireEvent.press(screen.getByTestId('notification-action-spawn_worker'));
  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'n1',
    action_kind: 'spawn_worker',
    action_id: 's0',
  });
});

test('action label override is used when supplied', () => {
  render(
    <NotificationCard
      notification={notification({ actions: [{ kind: 'run_command', action_id: 'r0', label: 'Re-run scrape' }] })}
    />,
  );
  expect(screen.getByText('Re-run scrape')).toBeTruthy();
});

test('run_command button renders default label and forwards action_id', () => {
  render(<NotificationCard notification={notification({ actions: [{ kind: 'run_command', action_id: 'r0' }] })} />);
  expect(screen.getByText('Run')).toBeTruthy();
  fireEvent.press(screen.getByTestId('notification-action-run_command'));
  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'n1',
    action_kind: 'run_command',
    action_id: 'r0',
  });
});

test('two same-kind actions: each tap forwards its own action_id', () => {
  // Two run_command buttons (distinct command_id/host) → distinct action_id.
  // Only ONE testID per kind exists, so render them one at a time to assert each
  // forwards its own id. Render-instance 1 → a; instance 2 → b.
  const actionsA: PentacleNotification['actions'] = [
    { kind: 'run_command', action_id: 'cmd-a', command_id: 'restart', host: 'hosta', label: 'Restart hosta' },
  ];
  const actionsB: PentacleNotification['actions'] = [
    { kind: 'run_command', action_id: 'cmd-b', command_id: 'restart', host: 'hostc', label: 'Restart hostc' },
  ];

  const a = render(<NotificationCard notification={notification({ actions: actionsA })} />);
  fireEvent.press(a.getByText('Restart hosta'));
  expect(mockResolveNotification).toHaveBeenLastCalledWith(
    expect.objectContaining({ action_id: 'cmd-a', action_kind: 'run_command' }),
  );
  a.unmount();

  const b = render(<NotificationCard notification={notification({ actions: actionsB })} />);
  fireEvent.press(b.getByText('Restart hostc'));
  expect(mockResolveNotification).toHaveBeenLastCalledWith(
    expect.objectContaining({ action_id: 'cmd-b', action_kind: 'run_command' }),
  );
});

test('two same-kind actions co-resident in one card: tap resolves ONLY the clicked action_id', () => {
  // B1 (matches the Phase-1 desktop contract): one notification carrying two
  // run_command buttons, both rendered together. Selecting by distinct label
  // proves the click resolves ONLY the clicked action (the other is untouched).
  const actions: PentacleNotification['actions'] = [
    { kind: 'run_command', action_id: 'cmd-a', command_id: 'restart', host: 'hosta', label: 'Restart hosta' },
    { kind: 'run_command', action_id: 'cmd-b', command_id: 'restart', host: 'hostc', label: 'Restart hostc' },
  ];
  render(<NotificationCard notification={notification({ actions })} />);
  expect(screen.getByText('Restart hosta')).toBeTruthy();
  fireEvent.press(screen.getByText('Restart hostc'));
  expect(mockResolveNotification).toHaveBeenCalledTimes(1);
  expect(mockResolveNotification).toHaveBeenCalledWith({
    notification_id: 'n1',
    action_kind: 'run_command',
    action_id: 'cmd-b',
  });
});

test('immediate feedback: tapping a button shows Working… and disables it', () => {
  // Never-settling resolve so the optimistic submitting state is observable.
  mockResolveNotification.mockReturnValueOnce(new Promise(() => {}));
  render(<NotificationCard notification={notification({ actions: [{ kind: 'ack', action_id: 'ack0' }] })} />);
  const button = screen.getByTestId('notification-action-ack');
  fireEvent.press(button);
  expect(screen.getByText('Working…')).toBeTruthy();
  expect(button.props.accessibilityState?.disabled).toBe(true);
});

test('a surfaced client_resolution_error after an optimistic offline answer re-enables the action button', async () => {
  // Offline answer: resolveNotification resolves optimistically (true) and queues a
  // reconnect replay — handleResolve's catch never fires, so the submit lock would
  // stay set. The button must re-enable when a later failure (1012 / expiry) surfaces
  // client_resolution_error, or the operator is stuck behind an un-actionable error.
  const { rerender } = render(<NotificationCard notification={notification({ actions: [{ kind: 'yes_no', action_id: 'a0' }] })} />);
  await act(async () => {
    fireEvent.press(screen.getByTestId('notification-action-yes'));
  });
  expect(screen.getByTestId('notification-action-yes').props.accessibilityState?.disabled).toBe(true);

  rerender(
    <NotificationCard
      notification={notification({
        actions: [{ kind: 'yes_no', action_id: 'a0' }],
        client_resolution_error: 'Answer expired before it could be delivered. Try again.',
      } as Partial<PentacleNotification>)}
    />,
  );
  expect(screen.getByTestId('notification-action-yes').props.accessibilityState?.disabled).toBe(false);
});

test('immediate feedback: yes_no No tap shows Working… only on the tapped button', () => {
  mockResolveNotification.mockReturnValueOnce(new Promise(() => {}));
  render(<NotificationCard notification={notification({ actions: [{ kind: 'yes_no', action_id: 'a0' }] })} />);
  fireEvent.press(screen.getByTestId('notification-action-no'));
  // The No button shows Working…; the Yes button keeps its label.
  expect(screen.getByText('Working…')).toBeTruthy();
  expect(screen.getByText('Yes')).toBeTruthy();
});

test('immediate feedback: run_command tap shows Running…', () => {
  mockResolveNotification.mockReturnValueOnce(new Promise(() => {}));
  render(<NotificationCard notification={notification({ actions: [{ kind: 'run_command', action_id: 'r0' }] })} />);
  fireEvent.press(screen.getByTestId('notification-action-run_command'));
  expect(screen.getByText('Running…')).toBeTruthy();
});

test('terminal notification renders no action buttons', () => {
  render(
    <NotificationCard
      notification={notification({ state: 'answered', actions: [{ kind: 'yes_no', action_id: 'a0' }] })}
    />,
  );
  expect(screen.queryByTestId('notification-action-yes')).toBeNull();
  expect(screen.queryByTestId('notification-action-no')).toBeNull();
});

test('in-place annotation: answered yes_no shows the chosen answer', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'answered',
        actions: [{ kind: 'yes_no', action_id: 'a0' }],
        resolution: { by: 'op', at: '2026-05-25T12:01:00.000Z', action_kind: 'yes_no', action_id: 'a0', choice: true },
      })}
    />,
  );
  expect(screen.getByText('Answered: Yes')).toBeTruthy();
  // Terminal card stays visible.
  expect(screen.getByTestId('notification-card')).toBeTruthy();
});

test('in-place annotation: acked shows Acknowledged', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'acked',
        actions: [{ kind: 'ack', action_id: 'ack0' }],
        resolution: { by: 'op', at: '2026-05-25T12:01:00.000Z', action_kind: 'ack', action_id: 'ack0' },
      })}
    />,
  );
  expect(screen.getByText('Acknowledged')).toBeTruthy();
});

test('in-place annotation: spawned shows the spawned stream id', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'spawned',
        actions: [{ kind: 'spawn_worker', action_id: 's0' }],
        resolution: {
          by: 'op',
          at: '2026-05-25T12:01:00.000Z',
          action_kind: 'spawn_worker',
          action_id: 's0',
          spawned_stream_id: 'claude-hosta-abc123',
        },
      })}
    />,
  );
  expect(screen.getByText('Spawned claude-hosta-abc123')).toBeTruthy();
});

test('in-place annotation: run_command done shows exit code + stdout tail', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'done',
        actions: [{ kind: 'run_command', action_id: 'r0' }],
        resolution: {
          by: 'op',
          at: '2026-05-25T12:01:00.000Z',
          action_kind: 'run_command',
          action_id: 'r0',
          result: { command_id: 'scrape', exit_code: 0, stdout_tail: 'populated 142 leads', stderr_tail: '', timed_out: false, ran_at: '2026-05-25T12:01:00.000Z' },
        },
      })}
    />,
  );
  expect(screen.getByText('✓ done (exit 0)')).toBeTruthy();
  expect(screen.getByTestId('notification-decision-stdout')).toBeTruthy();
  expect(screen.getByText('populated 142 leads')).toBeTruthy();
});

test('in-place annotation: run_command failed shows failed + stderr tail', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'failed',
        actions: [{ kind: 'run_command', action_id: 'r0' }],
        resolution: {
          by: 'op',
          at: '2026-05-25T12:01:00.000Z',
          action_kind: 'run_command',
          action_id: 'r0',
          result: { command_id: 'scrape', exit_code: 2, stdout_tail: '', stderr_tail: 'boom: connection refused', timed_out: false, ran_at: '2026-05-25T12:01:00.000Z' },
        },
      })}
    />,
  );
  expect(screen.getByText('✗ failed (exit 2)')).toBeTruthy();
  expect(screen.getByTestId('notification-decision-stderr')).toBeTruthy();
  expect(screen.getByText('boom: connection refused')).toBeTruthy();
});

test('in-place annotation: resolved shows Resolved', () => {
  render(
    <NotificationCard
      notification={notification({
        state: 'resolved',
        actions: [],
        resolution: { by: 'op', at: '2026-05-25T12:01:00.000Z', action_kind: 'ack' },
      })}
    />,
  );
  expect(screen.getByText('Resolved')).toBeTruthy();
});

test('running state renders the Running… lifecycle annotation (no buttons)', () => {
  render(
    <NotificationCard
      notification={notification({ state: 'running', actions: [{ kind: 'run_command', action_id: 'r0' }] })}
    />,
  );
  expect(screen.getByTestId('notification-decision')).toBeTruthy();
  expect(screen.getByText('Running…')).toBeTruthy();
  expect(screen.queryByTestId('notification-action-run_command')).toBeNull();
});

