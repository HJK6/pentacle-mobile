import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { useWorkingMotion } from '../../../src/components/lanes/useWorkingMotion';

afterEach(() => jest.restoreAllMocks());
test('motion runs only for a working visible lane and respects Reduce Motion', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const view = renderHook(({ active, working }: { active: boolean; working: boolean }) => useWorkingMotion(active, working), { initialProps: { active: true, working: true } });
  await act(async () => {});
  expect(view.result.current.moving).toBe(true);
  view.rerender({ active: false, working: true });
  expect(view.result.current.moving).toBe(false);
  view.rerender({ active: true, working: false });
  expect(view.result.current.moving).toBe(false);
  view.unmount();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const reduced = renderHook(() => useWorkingMotion(true, true));
  await act(async () => {});
  expect(reduced.result.current.moving).toBe(false);
  reduced.unmount();
});
