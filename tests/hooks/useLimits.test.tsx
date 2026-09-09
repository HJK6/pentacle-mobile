import { renderHook } from '@testing-library/react-native';
import { usePentacleStreamSelectorWhen } from '../../src/services/pentacleStream';
import useLimits from '../../src/hooks/useLimits';

jest.mock('../../src/services/pentacleStream', () => ({
  usePentacleStreamSelectorWhen: jest.fn(),
}));

const LIMITS = [
  { id: 'claude', label: 'Claude', pct: 42, resets_at_iso: null, resets_text: 'Sunday' },
  { id: 'fable', label: 'Fable', pct: null, resets_at_iso: null, resets_text: null },
  { id: 'codex', label: 'Codex', pct: 17, resets_at_iso: '2026-08-30T00:00:00Z', resets_text: 'Saturday' },
];

test('selects the one atomic limits list from stream state', () => {
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation(
    (_enabled: boolean, selector: (value: any) => unknown) => selector({ limits: LIMITS }),
  );

  const { result } = renderHook(() => useLimits());

  expect(result.current).toBe(LIMITS);
});

test('disabling live subscription still returns the cached complete list', () => {
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation(
    (enabled: boolean, selector: (value: any) => unknown) => {
      expect(enabled).toBe(false);
      return selector({ limits: LIMITS });
    },
  );

  const { result } = renderHook(() => useLimits(false));

  expect(result.current).toBe(LIMITS);
});
