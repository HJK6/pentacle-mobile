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

test('same-observation presence refresh retains detail-only readable fields and honors explicit null', () => {
  const { currentMember } = require('../../../src/components/lanes/useLaneMembers');
  const base = { spec_id: 'spec_sample', obs_rev: 2, source_changed_at: '2026-11-01T00:00:00Z' };
  const detail = { ...base, summary_line: 'Outcome', blocked_line: 'Approval', progress_at: '2026-11-01T00:00:00Z', unblocks: [{ spec_id: 'spec_next', title: 'Next' }] };
  const opening = { ...base, seats: [] };
  const update = { ...base, seats: [{ stream_id: 'sample', activity: 'working' }], blocked_line: null };
  const merged = currentMember(detail, update, opening);
  expect(merged.summary_line).toBe('Outcome');
  expect(merged.unblocks).toEqual(detail.unblocks);
  expect(merged.blocked_line).toBeNull();
});
