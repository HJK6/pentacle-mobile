import { renderHook } from '@testing-library/react-native';
import type { WorkLaneMember, WorkLaneShow } from 'pentacle-chat-core';
import { useLaneMembers } from '../../../src/components/lanes/useLaneMembers';
const show = (member: WorkLaneMember): WorkLaneShow => ({ lane_id: 'sample', projection: null, members: [member], updates: [], spec_changes: [], events: [] });
test('observation baseline survives appends but resets on a new load even when null data was batched away', () => {
  const opening: WorkLaneMember = { spec_id: 'spec_sample', title: 'Opening preview', obs_rev: 1, source_changed_at: '2026-11-01T00:00:01Z' };
  const full: WorkLaneMember = { ...opening, title: 'Full details', transitions: [{ status: 'analysis', at: '2026-11-01T00:00:00Z' }] };
  const live: WorkLaneMember = { ...opening, title: 'New observation', obs_rev: 2, source_changed_at: '2026-11-01T00:00:02Z' };
  const { result, rerender } = renderHook(({ inline, data, epoch }: { inline: WorkLaneMember[]; data: WorkLaneShow; epoch: number }) =>
    useLaneMembers(inline, data, epoch),
    { initialProps: { inline: [opening], data: show(full), epoch: 1 } });
  expect(result.current[0].transitions).toEqual(full.transitions);
  rerender({ inline: [live], data: show(full), epoch: 1 });
  expect(result.current[0].title).toBe('New observation');
  const refreshed = { ...live, source_changed_at: '2026-11-01T00:00:03Z', transitions: full.transitions };
  rerender({ inline: [live], data: show(refreshed), epoch: 2 });
  expect(result.current[0].transitions).toEqual(full.transitions);
});
