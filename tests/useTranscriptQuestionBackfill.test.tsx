import { renderHook } from '@testing-library/react-native';
import useTranscriptQuestionBackfill from '../src/hooks/useTranscriptQuestionBackfill';
import { listNotifications } from '../src/services/pentacleStream';

jest.mock('../src/services/pentacleStream', () => ({ listNotifications: jest.fn() }));
const list = jest.mocked(listNotifications);
const captured = '582a0a32-1d2e-4bd3-b59e-11b0deea87ea';
const ask = (notificationId: string) => ({ eventCase: 'agent-question-ask', notificationId });
beforeEach(() => { list.mockReset().mockResolvedValue([]); });

test('backfills loaded asks on focus and reconnect, never ordinary rows or duplicate rerenders', () => {
  const rows = [ask(captured), ask(captured), { eventCase: 'message', notificationId: 'foreign' }];
  const { rerender } = renderHook<void, { enabled: boolean; items: typeof rows }>(({ enabled, items }) =>
    useTranscriptQuestionBackfill('hostc:v2-5a6cfacf', enabled, items),
  { initialProps: { enabled: false, items: rows } });
  expect(list).not.toHaveBeenCalled();
  rerender({ enabled: true, items: rows });
  expect(list).toHaveBeenCalledWith({ notificationIds: [captured] });
  rerender({ enabled: true, items: [...rows] });
  expect(list).toHaveBeenCalledTimes(1);
  rerender({ enabled: true, items: [...rows, ask('older-loaded-ask')] });
  expect(list).toHaveBeenLastCalledWith({ notificationIds: ['older-loaded-ask'] });
  rerender({ enabled: false, items: rows });
  rerender({ enabled: true, items: rows });
  expect(list).toHaveBeenCalledTimes(3);
});

test('bounds exact lookup batches and resets ownership when the session changes', () => {
  const rows = Array.from({ length: 201 }, (_, i) => ask(`n-${i}`));
  const { rerender } = renderHook<void, { id: string }>(({ id }) => useTranscriptQuestionBackfill(id, true, rows),
    { initialProps: { id: 'first' } });
  expect(list.mock.calls.map(([args]) => args?.notificationIds?.length)).toEqual([100, 100, 1]);
  rerender({ id: 'second' });
  expect(list).toHaveBeenCalledTimes(6);
});

