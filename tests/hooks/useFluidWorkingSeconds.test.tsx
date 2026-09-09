import { act, renderHook } from '@testing-library/react-native';
import useFluidWorkingSeconds from '../../src/hooks/useFluidWorkingSeconds';

describe('useFluidWorkingSeconds', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-06-18T12:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns null and stays idle without a working anchor', () => {
    const { result } = renderHook(() => useFluidWorkingSeconds(null));

    expect(result.current).toBeNull();
    act(() => jest.advanceTimersByTime(5000));
    expect(result.current).toBeNull();
  });

  test('ticks once per second from the daemon anchor', () => {
    const { result } = renderHook(() => useFluidWorkingSeconds(5));

    expect(result.current).toBe(5);
    act(() => jest.advanceTimersByTime(1000));
    expect(result.current).toBe(6);
    act(() => jest.advanceTimersByTime(2000));
    expect(result.current).toBe(8);
  });

  test('re-syncs a later daemon anchor without ticking backward', () => {
    let anchor: number | null = 10;
    const { result, rerender } = renderHook(() => useFluidWorkingSeconds(anchor));

    act(() => jest.advanceTimersByTime(2000));
    expect(result.current).toBe(12);

    anchor = 11;
    rerender({});
    expect(result.current).toBe(12);

    act(() => jest.advanceTimersByTime(2000));
    expect(result.current).toBe(13);
  });

  test('does not flash backward when daemon elapsed dips during an interrupt', () => {
    let anchor: number | null = 30;
    const { result, rerender } = renderHook(() => useFluidWorkingSeconds(anchor));

    act(() => jest.advanceTimersByTime(2000));
    expect(result.current).toBe(32);

    anchor = 0;
    rerender({});
    expect(result.current).toBe(32);

    act(() => jest.advanceTimersByTime(1000));
    expect(result.current).toBe(33);
  });

  test('resets for a large backward anchor after a new-turn null gap', () => {
    let anchor: number | null = 30;
    const { result, rerender } = renderHook(() => useFluidWorkingSeconds(anchor));

    act(() => jest.advanceTimersByTime(2000));
    expect(result.current).toBe(32);

    anchor = null;
    rerender({});
    expect(result.current).toBeNull();

    anchor = 4;
    rerender({});
    expect(result.current).toBe(4);
  });

  test('clears the timer when working stops', () => {
    let anchor: number | null = 2;
    const { result, rerender } = renderHook(() => useFluidWorkingSeconds(anchor));

    act(() => jest.advanceTimersByTime(1000));
    expect(result.current).toBe(3);

    anchor = null;
    rerender({});
    expect(result.current).toBeNull();

    act(() => jest.advanceTimersByTime(3000));
    expect(result.current).toBeNull();
  });
});
