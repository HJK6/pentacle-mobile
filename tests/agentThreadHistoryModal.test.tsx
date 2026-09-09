import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AgentThreadHistoryModal, type AgentThreadHistoryTarget } from '../src/components/AgentThreadHistoryModal';

const target: AgentThreadHistoryTarget = {
  parentStreamId: 'hosta:nexus',
  parentGeneration: 'parent-generation',
  child: {
    stream_id: 'hostc:worker', session_generation: 'child-generation', display_name: 'Worker', role: 'worker',
    objective: 'History test', state: 'working', model: 'gpt-5.6-luna', since: null,
  },
};

function response(cursor: string | null, text: string, next_cursor: string | null) {
  return {
    parent_stream_id: target.parentStreamId, child_stream_id: target.child.stream_id,
    parent_generation: 'parent-generation', child_generation: 'child-generation', next_cursor,
    rows: [{ row_id: `tell:${text}`, ref_id: text, ts: '2026-09-08T12:00:00.000Z', direction: 'parent_to_child' as const, kind: 'tell' as const, text, truncated: false }],
  };
}

test('nexus_agents_history_questions pages older rows before the current page without duplicates', async () => {
  const readThread = jest.fn()
    .mockResolvedValueOnce(response(null, 'Current exchange', 'older'))
    .mockResolvedValueOnce(response('older', 'Older exchange', null));
  render(<AgentThreadHistoryModal target={target} connected readThread={readThread} onClose={jest.fn()} />);
  expect(await screen.findByText('Current exchange')).toBeTruthy();
  fireEvent.press(screen.getByTestId('agent-thread-load-more'));
  await waitFor(() => expect(readThread).toHaveBeenLastCalledWith({ parentStreamId: 'hosta:nexus', childStreamId: 'hostc:worker', cursor: 'older' }));
  expect(await screen.findByText('Older exchange')).toBeTruthy();
  expect(screen.getAllByText('Current exchange')).toHaveLength(1);
});

test('nexus_agents_history_questions drops a late page after the current direct child is invalidated', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const readThread = jest.fn(() => new Promise<ReturnType<typeof response>>((done) => { resolve = done; }));
  const rendered = render(<AgentThreadHistoryModal target={target} connected readThread={readThread} onClose={jest.fn()} />);
  rendered.rerender(<AgentThreadHistoryModal target={null} connected readThread={readThread} onClose={jest.fn()} />);
  resolve(response(null, 'Late stale exchange', null));
  await Promise.resolve();
  expect(screen.queryByTestId('agent-thread-modal')).toBeNull();
  expect(screen.queryByText('Late stale exchange')).toBeNull();
});

test('nexus_agents_history_questions refetches the current page after reconnect', async () => {
  const readThread = jest.fn()
    .mockResolvedValueOnce(response(null, 'Before reconnect', null))
    .mockResolvedValueOnce(response(null, 'After reconnect', null));
  const rendered = render(<AgentThreadHistoryModal target={target} connected readThread={readThread} onClose={jest.fn()} />);
  expect(await screen.findByText('Before reconnect')).toBeTruthy();
  rendered.rerender(<AgentThreadHistoryModal target={target} connected={false} readThread={readThread} onClose={jest.fn()} />);
  rendered.rerender(<AgentThreadHistoryModal target={target} connected readThread={readThread} onClose={jest.fn()} />);
  await waitFor(() => expect(readThread).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('After reconnect')).toBeTruthy();
});

test('nexus_agents_history_questions clears a stale page when the direct-child pair closes', async () => {
  const readThread = jest.fn().mockRejectedValue(new Error('pair_closed'));
  render(<AgentThreadHistoryModal target={target} connected readThread={readThread} onClose={jest.fn()} />);
  expect(await screen.findByText('Thread history is unavailable because this direct-child pairing closed.')).toBeTruthy();
  expect(screen.queryByTestId('agent-thread-load-more')).toBeNull();
});
