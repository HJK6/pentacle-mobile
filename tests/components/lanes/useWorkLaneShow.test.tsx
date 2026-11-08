jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn() }));
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { WorkLaneShow, WorkLaneShowOptions } from 'pentacle-chat-core';
import { useWorkLaneShow } from '../../../src/components/lanes/useWorkLaneShow';
const revision = 'a'.repeat(64), changed = 'b'.repeat(64);
const id = (i: number) => `spec_sample_${String(i).padStart(3, '0')}`;
function page(start: number, end: number, total = 65, rev = revision): WorkLaneShow {
  return { lane_id: 'sample', projection: null, members: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => ({ spec_id: id(start + i), status: 'completed' })),
    members_total: total, members_next: end < total ? id(end) : null, detail_revision: rev, updates: [], spec_changes: [], events: [] };
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
for (const count of [0, 1, 32, 33, 65]) test(`${count} members traverse sequential pages and finish exactly once`, async () => {
  const read = jest.fn(async (_lane: string, options?: WorkLaneShowOptions) => {
    const start = options?.members_after ? Number(options.members_after.slice(-3)) + 1 : 1;
    return page(start, Math.min(start + 31, count), count);
  });
  const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read, revision));
  await waitFor(() => expect(result.current.complete).toBe(true));
  expect(result.current.data?.members).toHaveLength(count);
  expect(read).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 32)));
  expect(read.mock.calls.map(c => c[1])).toEqual(Array.from({ length: Math.max(1, Math.ceil(count / 32)) }, (_, i) => ({ members_limit: 32, ...(i ? { members_after: id(i * 32) } : {}) })));
});
test('later failure preserves rows and retry starts at page one; pending rows are never complete', async () => {
  const pending = deferred<WorkLaneShow>();
  const read = jest.fn().mockResolvedValueOnce(page(1, 32)).mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(page(1, 32)).mockResolvedValueOnce(page(33, 64)).mockResolvedValueOnce(page(65, 65));
  const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read));
  await waitFor(() => expect(result.current.data?.members).toHaveLength(32));
  expect(result.current.loading).toBe(true); expect(result.current.complete).toBe(false);
  await act(async () => pending.reject(new Error('offline')));
  expect(result.current.error).toBe('Lane details unavailable'); expect(result.current.data?.members).toHaveLength(32);
  await act(async () => { await result.current.retry(); });
  expect(result.current.complete).toBe(true); expect(result.current.data?.members).toHaveLength(65);
  expect(read.mock.calls[2][1]).toEqual({ members_limit: 32 });
});
test('source churn restarts once; a second revision mismatch stops with truthful Retry', async () => {
  const read = jest.fn().mockResolvedValueOnce(page(1, 32)).mockResolvedValueOnce(page(33, 64, 65, changed))
    .mockResolvedValueOnce(page(1, 32, 65, changed)).mockResolvedValueOnce(page(33, 64));
  const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(read).toHaveBeenCalledTimes(4); expect(read.mock.calls[2][1]).toEqual({ members_limit: 32 });
  expect(result.current.complete).toBe(false); expect(result.current.data?.detail_revision).toBe(changed);
});
test('deduplicates overlapping pages, but rejects a contradictory unique total', async () => {
  const read = jest.fn().mockResolvedValueOnce(page(1, 32, 33)).mockResolvedValueOnce(page(32, 33, 33));
  const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read));
  await waitFor(() => expect(result.current.complete).toBe(true));
  expect(result.current.data?.members).toHaveLength(33);
  read.mockReset().mockResolvedValue({ ...page(1, 32, 33), members_next: null });
  await act(async () => { await result.current.retry(); });
  expect(result.current.complete).toBe(false); expect(result.current.error).toContain('Incomplete');
});
for (const bad of [ { ...page(1, 32), members_next: id(31) }, { ...page(33, 32), members_next: id(32) }, { ...page(1, 32), detail_revision: undefined } ])
  test('malformed/nonadvancing page fails without a loop', async () => {
    const read = jest.fn().mockResolvedValue(bad);
    const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(read).toHaveBeenCalledTimes(1); expect(result.current.complete).toBe(false);
  });
test('legacy replies stay single-response, including explicit incomplete legacy counts', async () => {
  const legacy = { ...page(1, 32, 32), members_total: undefined, members_next: undefined, detail_revision: undefined };
  const read = jest.fn().mockResolvedValue(legacy);
  const { result } = renderHook(() => useWorkLaneShow('sample', true, true, read));
  await waitFor(() => expect(result.current.complete).toBe(true)); expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ ...legacy, projection: { members_total: 65 } });
  await act(async () => { await result.current.retry(); });
  expect(result.current.error).toContain('Incomplete'); expect(result.current.complete).toBe(false);
});
test('same revision/presence does not reload; changed revision, filter and reconnect invalidate old epochs', async () => {
  const pending = deferred<WorkLaneShow>();
  const read = jest.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(page(1, 1, 1, changed));
  const { result, rerender } = renderHook(({ rev, connected, filter }: { rev: string; connected: boolean; filter: string }) => useWorkLaneShow('sample', connected, true, read, rev, filter),
    { initialProps: { rev: revision, connected: true, filter: '' } });
  rerender({ rev: revision, connected: true, filter: '' }); expect(read).toHaveBeenCalledTimes(1);
  rerender({ rev: changed, connected: true, filter: '' });
  await waitFor(() => expect(result.current.complete).toBe(true));
  await act(async () => pending.resolve(page(1, 32))); expect(result.current.data?.members).toHaveLength(1);
  rerender({ rev: changed, connected: false, filter: '' }); expect(result.current.data).toBeNull();
  rerender({ rev: changed, connected: true, filter: 'g_sample' });
  await waitFor(() => expect(result.current.complete).toBe(true));
  expect(read.mock.calls.at(-1)[1]).toEqual({ members_limit: 32, goal_id: 'g_sample' });
});
